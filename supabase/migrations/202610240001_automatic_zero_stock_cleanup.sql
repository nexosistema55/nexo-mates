-- Enable Integrations > Cron (pg_cron) before running this migration.
begin;
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'Activar Integrations > Cron (pg_cron) y volver a ejecutar este archivo';
  end if;
end;
$$;

-- A missing date is not evidence that the product has been empty for 30 days.
update public.products p set out_of_stock_since = now()
where p.archived_at is null and p.cleanup_deleted_at is null
  and p.tracks_stock and p.sku <> 'MANUAL_INTERNAL'
  and p.out_of_stock_since is null
  and exists (select 1 from public.product_variants v
    where v.product_id = p.id and v.active and v.archived_at is null)
  and not exists (select 1 from public.product_variants v
    where v.product_id = p.id and v.active and v.archived_at is null and v.current_stock > 0);

create or replace function public.cleanup_zero_stock_products_30d()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_before public.products%rowtype;
  v_count integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('nexo-cleanup-zero-stock-30d')) then
    return 0;
  end if;

  for v_id in
    select p.id from public.products p
    where p.archived_at is null and p.cleanup_deleted_at is null
      and p.tracks_stock and p.sku <> 'MANUAL_INTERNAL'
      and p.out_of_stock_since <= now() - interval '30 days'
    order by p.out_of_stock_since, p.id
  loop
    begin
      select p.* into v_before from public.products p
      where p.id = v_id and p.archived_at is null and p.cleanup_deleted_at is null
        and p.tracks_stock and p.sku <> 'MANUAL_INTERNAL'
        and p.out_of_stock_since <= now() - interval '30 days'
      for update skip locked;
      if not found then continue; end if;

      -- Stock operations lock variants first. Never wait while holding their product.
      perform v.id from public.product_variants v
      where v.product_id = v_id order by v.id for update nowait;

      if not exists (select 1 from public.product_variants v
        where v.product_id = v_id and v.active and v.archived_at is null)
        or exists (select 1 from public.product_variants v
        where v.product_id = v_id and v.active and v.archived_at is null and v.current_stock > 0)
      then
        perform public.refresh_product_out_of_stock_since(v_id);
        continue;
      end if;

      update public.products set archived_at = now(), published = false,
        cleanup_deleted_at = now() where id = v_id;
      update public.product_variants set archived_at = now(), active = false
        where product_id = v_id and archived_at is null;
      update public.product_images set archived_at = now()
        where product_id = v_id and archived_at is null;
      perform public.add_audit_log('product', v_id, 'auto-archive-zero-stock', null,
        to_jsonb(v_before), jsonb_build_object('archived_at', now(), 'published', false),
        jsonb_build_object('reason', '30 continuous days without stock',
          'out_of_stock_since', v_before.out_of_stock_since, 'retained_assets', true));
      v_count := v_count + 1;
    exception when lock_not_available then
      -- The subtransaction releases acquired locks; retry on the next daily run.
      continue;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.cleanup_zero_stock_products_30d() from public, anon, authenticated;
grant execute on function public.cleanup_zero_stock_products_30d() to service_role;

-- Disable the old destructive Storage-based route. Existing deployed versions
-- cannot obtain deletion candidates after this migration.
create or replace function public.list_stale_out_of_stock_product_assets(p_days integer default 30)
returns table(product_id uuid, storage_paths text[])
language sql security definer set search_path = public, pg_temp
as $$ select null::uuid, array[]::text[] where false; $$;
create or replace function public.archive_stale_out_of_stock_products(p_product_ids uuid[])
returns integer
language sql security definer set search_path = public, pg_temp
as $$ select 0; $$;
revoke all on function public.list_stale_out_of_stock_product_assets(integer) from public, anon, authenticated, service_role;
revoke all on function public.archive_stale_out_of_stock_products(uuid[]) from public, anon, authenticated, service_role;

-- pg_cron uses UTC: 06:00 UTC = 03:00 Argentina. Same name replaces the job.
select cron.schedule('nexo-cleanup-zero-stock-30d', '0 6 * * *',
  'select public.cleanup_zero_stock_products_30d();');
commit;

select jobname, schedule, command, active from cron.job
where jobname = 'nexo-cleanup-zero-stock-30d';
