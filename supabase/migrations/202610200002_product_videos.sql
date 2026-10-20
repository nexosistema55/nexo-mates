-- Incremental installation for Nexo: run after the initial installation.
begin;

alter table public.products add column if not exists video_url text not null default '';
alter table public.products add column if not exists video_path text not null default '';

-- Public catalog media, like product images. Uploads are immutable.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('product-videos','product-videos',true,5242880,array['video/mp4','video/webm'])
on conflict(id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists nexo_video_staff_insert on storage.objects;
create policy nexo_video_staff_insert on storage.objects for insert to authenticated
with check (bucket_id = 'product-videos' and public.is_active_staff());
drop policy if exists nexo_video_staff_select on storage.objects;
create policy nexo_video_staff_select on storage.objects for select to authenticated
using (bucket_id = 'product-videos' and public.is_active_staff());

create or replace function public.save_product_with_assets(
  p_operation_id uuid, p_product_id uuid, p_product jsonb, p_variants jsonb, p_images jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_stock_before integer; v_stock_after integer; v_variant_id uuid;
begin
  if not public.is_active_staff() or p_operation_id is null then raise exception 'No autorizado u operacion invalida'; end if;
  perform pg_advisory_xact_lock(hashtext(p_operation_id::text));
  perform pg_advisory_xact_lock(hashtext('product:' || p_product_id::text));
  if exists (select 1 from public.audit_log where operation_id = p_operation_id and entity_id = p_product_id) then
    return jsonb_build_object('id',p_product_id,'product',public.internal_product_snapshot(p_product_id));
  end if;
  if coalesce((p_product->>'tracks_stock')::boolean, false) and (
    jsonb_array_length(p_variants) <> 1 or p_variants->0->>'size' <> 'UNICO'
  ) then raise exception 'Se requiere un unico stock por producto'; end if;
  select coalesce(sum(current_stock),0) into v_stock_before from public.product_variants
  where product_id = p_product_id and active and archived_at is null;
  if p_product ? 'video_path' then
    if coalesce(p_product->>'video_path','') <> '' then
      if p_product->>'video_path' !~ ('^' || p_product_id::text || '/[0-9a-f-]{36}[.](mp4|webm)$')
        or not exists (select 1 from storage.objects where bucket_id = 'product-videos' and name = p_product->>'video_path')
        or p_product->>'video_url' is distinct from
          ('https://sfgwqyplehwxnrzqjwiq.supabase.co/storage/v1/object/public/product-videos/' || (p_product->>'video_path'))
      then raise exception 'Video invalido o no cargado'; end if;
    elsif coalesce(p_product->>'video_url','') <> '' then
      raise exception 'El video requiere una ruta de almacenamiento';
    end if;
  end if;
  v_result := public.save_product_with_assets_base(p_operation_id,p_product_id,p_product,p_variants,p_images);
  if p_product ? 'video_path' then
    update public.products set video_path = coalesce(p_product->>'video_path',''),
      video_url = coalesce(p_product->>'video_url','') where id = (v_result->>'id')::uuid;
  end if;
  select id,current_stock into v_variant_id,v_stock_after from public.product_variants
  where product_id = p_product_id and active and archived_at is null and size = 'UNICO';
  v_stock_after := coalesce(v_stock_after,0);
  if v_stock_after <> v_stock_before then
    insert into public.stock_movements(operation_id,product_id,variant_id,movement_type,quantity_delta,stock_after,unit_cost,note,created_by)
    values(p_operation_id,p_product_id,v_variant_id,'adjustment',v_stock_after-v_stock_before,v_stock_after,
      coalesce((p_product->>'cost')::numeric,0),'Stock actualizado con el producto',auth.uid());
  end if;
  return v_result || jsonb_build_object('product',public.internal_product_snapshot((v_result->>'id')::uuid));
end;
$$;
revoke all on function public.save_product_with_assets(uuid,uuid,jsonb,jsonb,jsonb) from public, anon;
grant execute on function public.save_product_with_assets(uuid,uuid,jsonb,jsonb,jsonb) to authenticated;
notify pgrst, 'reload schema';


create or replace view public.catalog_products as
select
  p.id,
  p.sku as code,
  p.slug,
  p.name,
  p.description,
  p.color,
  c.name as category,
  sc.name as subcategory,
  p.price,
  p.promo_price,
  p.published,
  p.created_at,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'size', v.size,
      'available', not p.tracks_stock or v.current_stock > 0,
      'sort_order', v.sort_order
    ) order by v.sort_order, v.size)
    from public.product_variants v
    where v.product_id = p.id
      and v.active = true
      and v.archived_at is null
  ), '[]'::jsonb) as variants,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'url', coalesce(i.public_url, i.storage_path),
      'path', i.storage_path,
      'alt', i.alt_text,
      'is_primary', i.is_primary,
      'sort_order', i.sort_order
    ) order by i.is_primary desc, i.sort_order, i.created_at)
    from public.product_images i
    where i.product_id = p.id
      and i.archived_at is null
  ), '[]'::jsonb) as images,
  p.tracks_stock,
  p.video_url
from public.products p
left join public.product_categories c on c.id = p.category_id
left join public.product_subcategories sc on sc.id = p.subcategory_id
where p.published = true
  and p.archived_at is null
  and (
    coalesce((select bs.out_of_stock_product_mode from public.business_settings bs where bs.id = 'main'), 'show') <> 'hide'
    or not p.tracks_stock
    or exists (
      select 1 from public.product_variants v
      where v.product_id = p.id
        and v.active = true
        and v.archived_at is null
        and v.current_stock > 0
    )
  );

notify pgrst, 'reload schema';


-- Productos paginados desde PostgreSQL.
-- Evita descargar todo el catalogo interno al abrir el sistema.

create or replace function public.list_products_page(
  p_query text default '',
  p_sort text default 'recent',
  p_category text default 'all',
  p_subcategory text default 'all',
  p_stock text default 'all',
  p_published text default 'all',
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_offset integer;
  v_query text := lower(trim(coalesce(p_query, '')));
  v_sort text := coalesce(nullif(trim(coalesce(p_sort, '')), ''), 'recent');
  v_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'all');
  v_subcategory text := coalesce(nullif(trim(coalesce(p_subcategory, '')), ''), 'all');
  v_stock text := coalesce(nullif(trim(coalesce(p_stock, '')), ''), 'all');
  v_published text := coalesce(nullif(trim(coalesce(p_published, '')), ''), 'all');
  v_rows jsonb;
  v_total_count integer;
begin
  if auth.uid() is null or not public.is_active_staff() then
    raise exception 'No autorizado';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  with product_rows as (
    select
      p.*,
      coalesce(c.name, '') as category_name,
      coalesce(s.name, '') as subcategory_name,
      coalesce((
        select sum(pv.current_stock)
        from public.product_variants pv
        where pv.product_id = p.id
          and pv.active = true
          and pv.archived_at is null
      ), 0) as stock_total,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pv.id,
            'size', pv.size,
            'current_stock', pv.current_stock,
            'active', pv.active,
            'sort_order', pv.sort_order,
            'archived_at', pv.archived_at
          )
          order by pv.sort_order asc, pv.size asc
        )
        from public.product_variants pv
        where pv.product_id = p.id
          and pv.active = true
          and pv.archived_at is null
      ), '[]'::jsonb) as product_variants,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', pi.id,
            'storage_path', pi.storage_path,
            'public_url', pi.public_url,
            'alt_text', pi.alt_text,
            'is_primary', pi.is_primary,
            'sort_order', pi.sort_order,
            'archived_at', pi.archived_at
          )
          order by pi.is_primary desc, pi.sort_order asc, pi.created_at asc
        )
        from public.product_images pi
        where pi.product_id = p.id
          and pi.archived_at is null
      ), '[]'::jsonb) as product_images
    from public.products p
    left join public.product_categories c on c.id = p.category_id
    left join public.product_subcategories s on s.id = p.subcategory_id
    where p.archived_at is null
      and coalesce(p.sku, '') <> 'MANUAL_INTERNAL'
  ),
  filtered as (
    select *
    from product_rows pr
    where (v_category = 'all' or pr.category_name = v_category)
      and (v_subcategory = 'all' or pr.subcategory_name = v_subcategory)
      and (
        v_stock = 'all'
        or (v_stock = 'tracked' and pr.tracks_stock = true)
        or (v_stock = 'untracked' and pr.tracks_stock = false)
      )
      and (
        v_published = 'all'
        or (v_published = 'published' and pr.published = true)
        or (v_published = 'unpublished' and pr.published = false)
      )
      and (
        v_query = ''
        or lower(coalesce(pr.sku, '')) like '%' || v_query || '%'
        or lower(coalesce(pr.name, '')) like '%' || v_query || '%'
        or lower(coalesce(pr.color, '')) like '%' || v_query || '%'
        or lower(coalesce(pr.category_name, '')) like '%' || v_query || '%'
        or lower(coalesce(pr.subcategory_name, '')) like '%' || v_query || '%'
      )
  ),
  counted as (
    select count(*)::integer as total_count
    from filtered
  ),
  ordered as (
    select
      f.*,
      row_number() over (
        order by
          case when v_sort = 'recent' then f.updated_at end desc nulls last,
          case when v_sort = 'recent' then f.created_at end desc nulls last,
          case when v_sort = 'alphaDesc' then f.sku end desc nulls last,
          case when v_sort = 'alphaDesc' then f.name end desc nulls last,
          case when v_sort not in ('recent', 'alphaDesc') then f.sku end asc nulls last,
          case when v_sort not in ('recent', 'alphaDesc') then f.name end asc nulls last,
          f.id asc
      ) as position
    from filtered f
  ),
  page_rows as (
    select
      f.position,
      jsonb_build_object(
        'id', f.id,
        'sku', f.sku,
        'slug', f.slug,
        'name', f.name,
        'color', f.color,
        'description', f.description,
        'cost', f.cost,
        'margin_percent', f.margin_percent,
        'price', f.price,
        'promo_price', f.promo_price,
        'wholesale_price', f.wholesale_price,
        'tracks_stock', f.tracks_stock,
        'published', f.published,
        'video_url', f.video_url,
        'video_path', f.video_path,
        'created_at', f.created_at,
        'updated_at', f.updated_at,
        'product_categories', jsonb_build_object('name', f.category_name),
        'product_subcategories', jsonb_build_object('name', f.subcategory_name),
        'product_variants', f.product_variants,
        'product_images', f.product_images
      ) as row_data
    from ordered f
    where f.position > v_offset
      and f.position <= v_offset + v_page_size
  )
  select
    coalesce((select total_count from counted), 0),
    coalesce(jsonb_agg(page_rows.row_data order by page_rows.position), '[]'::jsonb)
  into v_total_count, v_rows
  from page_rows;

  return jsonb_build_object(
    'rows', coalesce(v_rows, '[]'::jsonb),
    'totalCount', coalesce(v_total_count, 0),
    'page', v_page,
    'pageSize', v_page_size
  );
end;
$$;

revoke all on function public.list_products_page(text, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.list_products_page(text, text, text, text, text, text, integer, integer) to authenticated;

notify pgrst, 'reload schema';
commit;

