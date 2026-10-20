-- Nexo: modificacion masiva de precios persistente e idempotente.
begin;
create or replace function public.update_product_prices(
  p_operation_id uuid, p_percent numeric, p_category text default null,
  p_known_ids uuid[] default '{}'::uuid[]
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_product record;
  v_price numeric;
  v_count integer := 0;
  v_changes jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if auth.uid() is null or not public.is_active_staff() then raise exception 'No autorizado'; end if;
  if p_operation_id is null or p_percent is null or p_percent < -100 or p_percent > 10000 then
    raise exception 'Porcentaje u operacion invalida';
  end if;
  if coalesce(cardinality(p_known_ids),0) > 1000 then raise exception 'Demasiados productos locales'; end if;
  if p_category is not null and not exists (
    select 1 from public.product_categories where name = p_category and archived_at is null
  ) then raise exception 'Categoria inexistente'; end if;
  perform pg_advisory_xact_lock(hashtext(p_operation_id::text));
  select payload into v_result from public.audit_log
  where operation_id = p_operation_id and action = 'bulk-price-complete' limit 1;
  if v_result is not null then return v_result; end if;

  for v_product in
    select p.id,p.price from public.products p
    where p.archived_at is null and p.sku <> 'MANUAL_INTERNAL'
      and (p_category is null or exists (
        select 1 from public.product_categories c where c.id = p.category_id and c.name = p_category
      ))
    order by p.id for update of p
  loop
    v_price := round(v_product.price * (1 + p_percent / 100));
    update public.products set price = v_price, updated_by = auth.uid() where id = v_product.id;
    perform public.add_audit_log('product',v_product.id,'bulk-price',p_operation_id,
      jsonb_build_object('price',v_product.price),jsonb_build_object('price',v_price),
      jsonb_build_object('percent',p_percent));
    if v_product.id = any(coalesce(p_known_ids,'{}'::uuid[])) then
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('id',v_product.id,'price',v_price));
    end if;
    v_count := v_count + 1;
  end loop;
  v_result := jsonb_build_object('updatedCount',v_count,'priceChanges',v_changes);
  insert into public.audit_log(entity_type,action,operation_id,payload,user_id)
    values('product','bulk-price-complete',p_operation_id,v_result,auth.uid());
  return v_result;
end;
$$;
revoke all on function public.update_product_prices(uuid,numeric,text,uuid[]) from public,anon;
grant execute on function public.update_product_prices(uuid,numeric,text,uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;
