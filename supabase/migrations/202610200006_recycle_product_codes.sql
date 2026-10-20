-- Reutiliza codigos y URLs de productos archivados sin borrar su historial.
begin;

alter table public.products drop constraint if exists products_sku_key;
alter table public.products drop constraint if exists products_slug_key;
create unique index if not exists products_active_sku_unique
on public.products(upper(btrim(sku))) where archived_at is null and sku is not null;
create unique index if not exists products_active_slug_unique
on public.products(slug) where archived_at is null;

create or replace function public.get_next_product_code(p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_prefix text := upper(regexp_replace(coalesce(p_prefix,''),'[^A-Za-z0-9]','','g'));
  v_used text[];
  v_index integer;
  v_code text;
begin
  if auth.uid() is null or not public.is_active_staff() then raise exception 'No autorizado'; end if;
  if v_prefix = '' then v_prefix := 'X'; end if;
  select coalesce(array_agg(upper(btrim(sku))),array[]::text[]) into v_used
  from public.products where archived_at is null and coalesce(btrim(sku),'') <> '';
  for v_index in 1..999999 loop
    v_code := v_prefix || case when v_index < 1000 then lpad(v_index::text,3,'0') else v_index::text end;
    if not (v_code = any(v_used)) then return v_code; end if;
  end loop;
  raise exception 'No quedan codigos disponibles para este prefijo';
end;
$$;
revoke all on function public.get_next_product_code(text) from public,anon;
grant execute on function public.get_next_product_code(text) to authenticated;
notify pgrst, 'reload schema';
commit;
