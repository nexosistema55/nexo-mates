-- Install after 202610240001. Deployment/secret setup: LIMPIEZA-STOCK-CERO.md.
begin;
do $$
begin
  if not exists(select 1 from pg_extension where extname='pg_net') then
    raise exception 'Habilitar pg_net antes de instalar la limpieza de archivos';
  end if;
  if not exists(select 1 from vault.decrypted_secrets
    where name='nexo_cleanup_secret' and length(decrypted_secret)>=32) then
    raise exception 'Configurar nexo_cleanup_secret en Vault antes de continuar';
  end if;
end;
$$;

create table if not exists public.product_cleanup_queue (
  product_id uuid primary key,
  created_at timestamptz not null default now(),
  claim_token uuid,
  leased_until timestamptz,
  completed_at timestamptz
);
alter table public.product_cleanup_queue enable row level security;
revoke all on public.product_cleanup_queue from public, anon, authenticated;

create or replace function public.claim_product_media_cleanup()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  -- Durable marker survives a crash between archiving and processing files.
  insert into public.product_cleanup_queue(product_id)
  select id from public.products where archived_at is not null and cleanup_deleted_at is not null
  on conflict(product_id) do nothing;

  with candidates as (
    select q.product_id from public.product_cleanup_queue q
    join public.products p on p.id=q.product_id
    where q.completed_at is null and (q.leased_until is null or q.leased_until<now())
      and p.archived_at is not null and p.cleanup_deleted_at is not null
    order by q.created_at,q.product_id limit 10 for update of q skip locked
  ), claimed as (
    update public.product_cleanup_queue q set claim_token=gen_random_uuid(),leased_until=now()+interval '10 minutes'
    from candidates c where q.product_id=c.product_id returning q.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('product_id',c.product_id,'token',c.claim_token,
    'assets',coalesce((select jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'path',o.name))
      from storage.objects o
      where ((o.bucket_id='product-images' and starts_with(o.name,'products/'||c.product_id::text||'/'))
          or (o.bucket_id='product-videos' and starts_with(o.name,c.product_id::text||'/')))
        and not exists(select 1 from public.product_images i where i.product_id<>c.product_id
          and (i.storage_path=o.name or right(i.storage_path,length(o.name)+1)='/'||o.name
            or right(i.public_url,length(o.name)+1)='/'||o.name))
        and not exists(select 1 from public.products p where p.id<>c.product_id
          and o.bucket_id='product-videos' and p.video_path=o.name)
      ),'[]'::jsonb))),'[]'::jsonb) into v_result from claimed c;
  return v_result;
end;
$$;

create or replace function public.complete_product_media_cleanup(p_product_id uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_deleted boolean := false;
begin
  perform 1 from public.product_cleanup_queue where product_id=p_product_id
    and claim_token=p_token and completed_at is null and leased_until>now() for update;
  if not found then return false; end if;
  perform 1 from public.products where id=p_product_id
    and archived_at is not null and cleanup_deleted_at is not null for update;
  if not found then return false; end if;

  delete from public.product_images where product_id=p_product_id;
  update public.products set video_url='',video_path='' where id=p_product_id;
  -- A product without history can be removed completely. Foreign keys retain
  -- only the technical product/variant rows needed by sales and stock history.
  begin
    delete from public.product_variants where product_id=p_product_id;
    delete from public.products where id=p_product_id;
    v_deleted := true;
  exception when foreign_key_violation then
    v_deleted := false;
  end;
  update public.product_cleanup_queue set completed_at=now(),leased_until=null where product_id=p_product_id;
  perform public.add_audit_log('product',p_product_id,'auto-delete-product-media',null,null,null,
    jsonb_build_object('product_row_deleted',v_deleted,'storage_api_completed',true));
  return true;
end;
$$;

create or replace function public.dispatch_zero_stock_cleanup()
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare v_secret text; v_request bigint;
begin
  select decrypted_secret into strict v_secret from vault.decrypted_secrets where name='nexo_cleanup_secret';
  if length(v_secret)<32 then raise exception 'Secret de limpieza invalido'; end if;
  select net.http_post(
    url:='https://sfgwqyplehwxnrzqjwiq.supabase.co/functions/v1/cleanup-stale-products',
    headers:=jsonb_build_object('Content-Type','application/json','x-cleanup-secret',v_secret),
    body:='{}'::jsonb,timeout_milliseconds:=120000) into v_request;
  return v_request;
end;
$$;
revoke all on function public.claim_product_media_cleanup() from public,anon,authenticated;
revoke all on function public.complete_product_media_cleanup(uuid,uuid) from public,anon,authenticated;
revoke all on function public.dispatch_zero_stock_cleanup() from public,anon,authenticated,service_role;
grant execute on function public.claim_product_media_cleanup() to service_role;
grant execute on function public.complete_product_media_cleanup(uuid,uuid) to service_role;

-- Replace the archive-only job; the worker archives then removes owned files.
select cron.schedule('nexo-cleanup-zero-stock-30d','0 6 * * *',
  'select public.dispatch_zero_stock_cleanup();');
-- Retry pending media work and continue large batches without waiting another day.
-- This worker only receives already-archived jobs; it never expires products early.
select cron.schedule('nexo-retry-product-media-cleanup','*/15 * * * *',
  'select public.dispatch_zero_stock_cleanup();');
commit;
