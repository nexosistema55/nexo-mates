-- Internal stock uses one UNICO row per product; it is never a user-facing variety.
create or replace function public.internal_product_snapshot(p_product_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(p) || jsonb_build_object(
    'product_categories', (select to_jsonb(c) from public.product_categories c where c.id = p.category_id),
    'product_subcategories', (select to_jsonb(s) from public.product_subcategories s where s.id = p.subcategory_id),
    'product_variants', coalesce((select jsonb_agg(to_jsonb(v)) from public.product_variants v where v.product_id = p.id and v.active and v.archived_at is null), '[]'::jsonb),
    'product_images', coalesce((select jsonb_agg(to_jsonb(i)) from public.product_images i where i.product_id = p.id and i.archived_at is null), '[]'::jsonb)
  ) from public.products p where p.id = p_product_id;
$$;
revoke all on function public.internal_product_snapshot(uuid) from public, anon, authenticated;

alter function public.create_sale_complete(uuid,uuid,numeric,text,numeric,text,jsonb) rename to create_sale_complete_base;
revoke all on function public.create_sale_complete_base(uuid,uuid,numeric,text,numeric,text,jsonb) from public, anon, authenticated;
create or replace function public.create_sale_complete(
  p_operation_id uuid, p_customer_id uuid, p_paid_amount numeric,
  p_payment_method text, p_manual_total numeric, p_notes text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sale jsonb;
begin
  if not public.is_active_staff() or p_operation_id is null then raise exception 'No autorizado u operacion invalida'; end if;
  v_sale := public.create_sale_complete_base(p_operation_id,p_customer_id,p_paid_amount,p_payment_method,p_manual_total,p_notes,p_items);
  return v_sale || jsonb_build_object('_products', coalesce((
    select jsonb_agg(public.internal_product_snapshot(x.product_id))
    from (select distinct si.product_id from public.sale_items si where si.sale_id = (v_sale->>'id')::uuid) x
  ), '[]'::jsonb));
end;
$$;
revoke all on function public.create_sale_complete(uuid,uuid,numeric,text,numeric,text,jsonb) from public, anon;
grant execute on function public.create_sale_complete(uuid,uuid,numeric,text,numeric,text,jsonb) to authenticated;

create or replace function public.register_purchase_stock_complete(
  p_operation_id uuid, p_variant_id uuid, p_quantity integer,
  p_unit_cost numeric default 0, p_stock_note text default '',
  p_expense_at timestamptz default now(), p_expense_note text default '',
  p_payment_method text default '', p_update_product_cost boolean default false,
  p_next_cost numeric default null, p_next_price numeric default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_product_id uuid;
begin
  if not public.is_active_staff() or p_operation_id is null then raise exception 'No autorizado u operacion invalida'; end if;
  perform pg_advisory_xact_lock(hashtext(p_operation_id::text));
  v_result := public.register_purchase_stock(p_operation_id,p_variant_id,p_quantity,p_unit_cost,p_stock_note,p_expense_at,p_expense_note,p_payment_method,p_update_product_cost,p_next_cost,p_next_price);
  select product_id into v_product_id from public.product_variants where id = p_variant_id;
  return v_result || jsonb_build_object(
    'product', public.internal_product_snapshot(v_product_id),
    'movement', (select to_jsonb(m) from public.stock_movements m where m.id = (v_result->>'movementId')::uuid),
    'expense', (select to_jsonb(e) from public.expenses e where e.id = (v_result->>'expenseId')::uuid)
  );
end;
$$;
revoke all on function public.register_purchase_stock_complete(uuid,uuid,integer,numeric,text,timestamptz,text,text,boolean,numeric,numeric) from public, anon;
grant execute on function public.register_purchase_stock_complete(uuid,uuid,integer,numeric,text,timestamptz,text,text,boolean,numeric,numeric) to authenticated;

alter function public.save_product_with_assets(uuid,uuid,jsonb,jsonb,jsonb) rename to save_product_with_assets_base;
revoke all on function public.save_product_with_assets_base(uuid,uuid,jsonb,jsonb,jsonb) from public, anon, authenticated;
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
  v_result := public.save_product_with_assets_base(p_operation_id,p_product_id,p_product,p_variants,p_images);
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
