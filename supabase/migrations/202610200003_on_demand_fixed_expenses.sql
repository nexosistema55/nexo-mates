-- Nexo: consultas por demanda y gastos fijos mensuales.
begin;

alter table public.expenses add column if not exists fixed_template_key text;
alter table public.expenses add column if not exists fixed_month date;
create unique index if not exists expenses_fixed_template_month_active
on public.expenses(fixed_template_key, fixed_month)
where fixed_template_key is not null and archived_at is null;

create or replace function public.get_navigation_metadata()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_active_staff() then raise exception 'No autorizado'; end if;
  return jsonb_build_object(
    'months', coalesce((select jsonb_agg(m order by m desc) from (
      select distinct to_char(sold_at at time zone 'America/Argentina/Buenos_Aires','YYYY-MM') as m
      from public.sales where archived_at is null
      union
      select distinct to_char(expense_at at time zone 'America/Argentina/Buenos_Aires','YYYY-MM') as m
      from public.expenses where archived_at is null
    ) x), '[]'::jsonb),
    'paymentMethods', coalesce((select jsonb_agg(x.payment_method order by x.payment_method) from (
      select distinct payment_method from public.sales where archived_at is null and payment_method <> ''
    ) x), '[]'::jsonb),
    'expenseCategories', coalesce((select jsonb_agg(x.category order by x.category) from (
      select distinct category from public.expenses where archived_at is null
    ) x), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_navigation_metadata() from public,anon;
grant execute on function public.get_navigation_metadata() to authenticated;

create or replace function public.save_fixed_expenses_batch(p_operation_id uuid, p_date date, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_month date;
  v_item jsonb;
  v_expense public.expenses%rowtype;
  v_before jsonb;
  v_result jsonb;
  v_rows jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.is_active_staff() then raise exception 'No autorizado'; end if;
  if p_operation_id is null or p_date is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Solicitud invalida';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Seleccion invalida'; end if;
  if (select count(distinct x->>'template_key') from jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) then
    raise exception 'Gastos repetidos o sin identificador';
  end if;
  v_month := date_trunc('month',p_date)::date;
  perform pg_advisory_xact_lock(hashtext(p_operation_id::text));
  select payload into v_result from public.audit_log
    where operation_id = p_operation_id and action = 'fixed-batch' limit 1;
  if v_result is not null then return v_result; end if;
  perform pg_advisory_xact_lock(hashtext('fixed-expenses:' || v_month::text));
  for v_item in select value from jsonb_array_elements(p_items) loop
    if coalesce(trim(v_item->>'template_key'),'') = '' or length(v_item->>'template_key') > 200
      or coalesce(trim(v_item->>'concept'),'') = '' or coalesce(trim(v_item->>'category'),'') = ''
      or v_item->>'category' in ('CompraMercaderia','Mercaderia')
      or coalesce((v_item->>'amount')::numeric,0) <= 0 then raise exception 'Gasto fijo invalido'; end if;
    select to_jsonb(e) into v_before from public.expenses e where e.fixed_template_key = v_item->>'template_key'
      and e.fixed_month = v_month and e.archived_at is null;
    insert into public.expenses(operation_id,expense_at,category,amount,note,created_by,fixed_template_key,fixed_month)
    values(gen_random_uuid(), (p_date + time '12:00') at time zone 'America/Argentina/Buenos_Aires',
      v_item->>'category',(v_item->>'amount')::numeric,v_item->>'concept',auth.uid(),v_item->>'template_key',v_month)
    on conflict(fixed_template_key,fixed_month) where fixed_template_key is not null and archived_at is null
    do update set expense_at = excluded.expense_at, category = excluded.category, amount = excluded.amount, note = excluded.note
    returning * into v_expense;
    perform public.add_audit_log('expense',v_expense.id,'fixed-save',p_operation_id,v_before,to_jsonb(v_expense),'{}'::jsonb);
    v_rows := v_rows || jsonb_build_array(to_jsonb(v_expense));
  end loop;
  v_result := jsonb_build_object('rows',v_rows);
  insert into public.audit_log(entity_type,action,operation_id,payload,user_id)
    values('expense','fixed-batch',p_operation_id,v_result,auth.uid());
  return v_result;
end;
$$;
revoke all on function public.save_fixed_expenses_batch(uuid,date,jsonb) from public,anon;
grant execute on function public.save_fixed_expenses_batch(uuid,date,jsonb) to authenticated;

-- Gastos y mercaderia paginados desde PostgreSQL.
-- Devuelve filas listas para la tabla, total de registros y total filtrado.

create or replace function public.list_expenses_page(
  p_query text default '',
  p_year text default null,
  p_month text default null,
  p_category text default 'all',
  p_type text default 'all',
  p_behavior text default 'all',
  p_hide_commissions boolean default false,
  p_page integer default 1,
  p_page_size integer default 40
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 40), 1), 100);
  v_offset integer;
  v_query text := lower(trim(coalesce(p_query, '')));
  v_year text := nullif(trim(coalesce(p_year, '')), '');
  v_month text := coalesce(nullif(trim(coalesce(p_month, '')), ''), 'all');
  v_category text := coalesce(nullif(trim(coalesce(p_category, '')), ''), 'all');
  v_type text := coalesce(nullif(trim(coalesce(p_type, '')), ''), 'all');
  v_behavior text := coalesce(nullif(trim(coalesce(p_behavior, '')), ''), 'all');
  v_rows jsonb;
  v_total_count integer;
  v_total_amount numeric;
begin
  if auth.uid() is null or not public.is_active_staff() then
    raise exception 'No autorizado';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  with all_rows as (
    select
      case when e.category in ('CompraMercaderia', 'Mercaderia') then 'purchase:' || e.id else 'expense:' || e.id end as key,
      case when e.category in ('CompraMercaderia', 'Mercaderia') then 'purchase' else 'expense' end as source,
      e.id,
      ((e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date)::text as date,
      case when e.category in ('CompraMercaderia', 'Mercaderia') then 'purchase' else 'expense' end as type,
      e.category,
      case
        when (e.fixed_template_key is not null or e.category in ('Alquiler', 'Sueldos', 'Impuestos', 'Honorarios')) then 'fijo'
        else 'variable'
      end as behavior,
      'local' as area,
      coalesce(nullif(e.note, ''), e.category) as concept,
      case
        when e.category in ('CompraMercaderia', 'Mercaderia') then 'Compra cargada manualmente'
        else 'Gasto cargado manualmente'
      end as detail,
      e.amount,
      e.category not in ('CompraMercaderia', 'Mercaderia') as affects_result,
      true as deletable,
      false as editable_amount,
      false as automatic,
      extract(epoch from e.created_at)::numeric as row_order
    from public.expenses e
    where e.archived_at is null

    union all

    select
      'sale-cost:' || s.id as key,
      'sale-cost' as source,
      s.id,
      ((s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date)::text as date,
      'purchase' as type,
      'Mercaderia' as category,
      'variable' as behavior,
      'local' as area,
      'Costo venta local #' || lpad(coalesce(s.local_order_number, 0)::text, 4, '0') as concept,
      'Productos vendidos en Local' as detail,
      sum(si.quantity * si.unit_cost) as amount,
      true as affects_result,
      false as deletable,
      false as editable_amount,
      true as automatic,
      extract(epoch from s.created_at)::numeric as row_order
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.archived_at is null
    group by s.id, s.sold_at, s.local_order_number, s.created_at
    having sum(si.quantity * si.unit_cost) > 0
  ),
  filtered as (
    select *
    from all_rows r
    where (v_year is null or left(r.date, 4) = v_year)
      and (v_month = 'all' or substring(r.date from 6 for 2) = v_month)
      and (v_category = 'all' or r.category = v_category)
      and (v_type = 'all' or r.type = v_type)
      and (v_behavior = 'all' or r.behavior = v_behavior)
      and (
        v_query = ''
        or lower(coalesce(r.concept, '')) like '%' || v_query || '%'
        or lower(coalesce(r.category, '')) like '%' || v_query || '%'
        or lower(coalesce(r.detail, '')) like '%' || v_query || '%'
      )
      and (
        p_hide_commissions is distinct from true
        or (
          r.category <> 'Comisiones'
          and lower(coalesce(r.concept, '')) not like '%comision%'
          and lower(coalesce(r.concept, '')) not like '%comisión%'
        )
      )
  ),
  counted as (
    select
      count(*)::integer as total_count,
      coalesce(sum(amount), 0) as total_amount
    from filtered
  ),
  page_rows as (
    select *
    from filtered
    order by date desc, row_order desc, key desc
    limit v_page_size
    offset v_offset
  )
  select
    coalesce((select total_count from counted), 0),
    coalesce((select total_amount from counted), 0),
    coalesce(jsonb_agg(row_to_json(page_rows)::jsonb order by page_rows.date desc, page_rows.row_order desc, page_rows.key desc), '[]'::jsonb)
  into v_total_count, v_total_amount, v_rows
  from page_rows;

  return jsonb_build_object(
    'rows', coalesce(v_rows, '[]'::jsonb),
    'totalCount', coalesce(v_total_count, 0),
    'totalAmount', coalesce(v_total_amount, 0),
    'page', v_page,
    'pageSize', v_page_size
  );
end;
$$;

revoke all on function public.list_expenses_page(text, text, text, text, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.list_expenses_page(text, text, text, text, text, text, boolean, integer, integer) to authenticated;

-- Separa ventas generadas, ingresos reales y cobro de deudas en Estadisticas.

create or replace function public.get_report_summary(
  p_from date,
  p_to date default null,
  p_scope text default 'total'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from date := coalesce(p_from, date_trunc('month', current_date)::date);
  v_to date := coalesce(p_to, current_date);
  v_scope text := coalesce(nullif(trim(coalesce(p_scope, '')), ''), 'total');
  v_fake_income numeric := 0;
  v_sales_real_income numeric := 0;
  v_debt_collections numeric := 0;
  v_real_income numeric := 0;
  v_sales_count integer := 0;
  v_merchandise_cost numeric := 0;
  v_fixed_expenses numeric := 0;
  v_variable_expenses numeric := 0;
  v_categories jsonb := '{}'::jsonb;
  v_subcategories jsonb := '{}'::jsonb;
  v_subcategory_categories jsonb := '{}'::jsonb;
  v_payments jsonb := '{}'::jsonb;
  v_expense_details jsonb := '{}'::jsonb;
  v_trend jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.is_active_staff() then
    raise exception 'No autorizado';
  end if;

  if v_to < v_from then
    v_from := v_to;
  end if;

  with sales_in_range as (
    select *
    from public.sales s
    where s.archived_at is null
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
  ),
  sale_payment_summary as (
    select
      s.id,
      coalesce(sum(p.amount) filter (where lower(coalesce(p.note, '')) like '%pago registrado al crear la venta%'), 0) as initial_paid,
      count(p.id) as payment_count
    from sales_in_range s
    left join public.payments p on p.sale_id = s.id
    group by s.id
  )
  select
    coalesce(sum(s.total), 0),
    coalesce(sum(case when ps.payment_count > 0 then ps.initial_paid else least(s.paid_amount, s.total) end), 0),
    count(*)::integer
  into v_fake_income, v_sales_real_income, v_sales_count
  from sales_in_range s
  left join sale_payment_summary ps on ps.id = s.id;

  select coalesce(sum(p.amount), 0)
  into v_debt_collections
  from public.payments p
  left join public.sales s on s.id = p.sale_id
  where lower(coalesce(p.note, '')) not like '%pago registrado al crear la venta%'
    and (s.id is null or s.archived_at is null)
    and (p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
    and (p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to;

  v_real_income := v_sales_real_income + v_debt_collections;

  with sales_in_range as (
    select *
    from public.sales s
    where s.archived_at is null
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
  )
  select coalesce(sum(si.quantity * si.unit_cost), 0)
  into v_merchandise_cost
  from public.sale_items si
  join sales_in_range s on s.id = si.sale_id;

  select
    coalesce(sum(e.amount) filter (where (e.fixed_template_key is not null or e.category in ('Alquiler', 'Sueldos', 'Impuestos', 'Honorarios'))), 0),
    coalesce(sum(e.amount) filter (where (e.fixed_template_key is null and e.category not in ('Alquiler', 'Sueldos', 'Impuestos', 'Honorarios'))), 0)
  into v_fixed_expenses, v_variable_expenses
  from public.expenses e
  where e.archived_at is null
    and e.category not in ('CompraMercaderia', 'Mercaderia')
    and (e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
    and (e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to;

  with item_rows as (
    select
      coalesce(pc.name, 'Sin Categoria') as category,
      coalesce(ps.name, '') as subcategory,
      si.quantity
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    left join public.products p on p.id = si.product_id
    left join public.product_categories pc on pc.id = p.category_id
    left join public.product_subcategories ps on ps.id = p.subcategory_id
    where s.archived_at is null
      and coalesce(p.sku, '') <> 'MANUAL_INTERNAL'
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
  ),
  category_rows as (
    select category, sum(quantity)::integer as quantity
    from item_rows
    where coalesce(category, '') <> ''
    group by category
  ),
  subcategory_rows as (
    select subcategory, sum(quantity)::integer as quantity, string_agg(distinct category, ' / ' order by category) as categories
    from item_rows
    where coalesce(subcategory, '') <> ''
    group by subcategory
  )
  select
    coalesce((select jsonb_object_agg(category, quantity) from category_rows), '{}'::jsonb),
    coalesce((select jsonb_object_agg(subcategory, quantity) from subcategory_rows), '{}'::jsonb),
    coalesce((select jsonb_object_agg(subcategory, categories) from subcategory_rows), '{}'::jsonb)
  into v_categories, v_subcategories, v_subcategory_categories;

  with actual_payment_rows as (
    select
      case lower(coalesce(nullif(p.method, ''), 'sin-medio'))
        when 'efectivo' then 'Efectivo'
        when 'debito' then 'Débito'
        when 'transferencia' then 'Transferencias'
        when 'transferencias' then 'Transferencias'
        when 'qr' then 'QR'
        when 'credito' then 'Crédito'
        when 'web' then 'Web'
        when 'sin-medio' then 'Sin Medio'
        else initcap(replace(coalesce(nullif(p.method, ''), 'Sin Medio'), '-', ' '))
      end as method,
      p.amount
    from public.payments p
    left join public.sales s on s.id = p.sale_id
    where (s.id is null or s.archived_at is null)
      and (p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
      and (p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
  ),
  legacy_sale_payment_rows as (
    select
      case lower(coalesce(nullif(s.payment_method, ''), 'sin-medio'))
        when 'efectivo' then 'Efectivo'
        when 'debito' then 'Débito'
        when 'transferencia' then 'Transferencias'
        when 'transferencias' then 'Transferencias'
        when 'qr' then 'QR'
        when 'credito' then 'Crédito'
        when 'web' then 'Web'
        when 'sin-medio' then 'Sin Medio'
        else initcap(replace(coalesce(nullif(s.payment_method, ''), 'Sin Medio'), '-', ' '))
      end as method,
      least(s.paid_amount, s.total) as amount
    from public.sales s
    where s.archived_at is null
      and least(s.paid_amount, s.total) > 0
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
      and not exists (select 1 from public.payments p where p.sale_id = s.id)
  ),
  payment_totals as (
    select
      method,
      count(*)::integer as count,
      coalesce(sum(amount), 0) as amount
    from (
      select * from actual_payment_rows
      union all
      select * from legacy_sale_payment_rows
    ) payment_union
    group by method
  )
  select coalesce(jsonb_object_agg(method, jsonb_build_object('amount', amount, 'count', count)), '{}'::jsonb)
  into v_payments
  from payment_totals;

  with expense_rows as (
    select
      coalesce(nullif(e.note, ''), e.category, 'Sin detalle') as label,
      count(*)::integer as count,
      coalesce(sum(e.amount), 0) as amount
    from public.expenses e
    where e.archived_at is null
      and e.category not in ('CompraMercaderia', 'Mercaderia')
      and (e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date >= v_from
      and (e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
    group by coalesce(nullif(e.note, ''), e.category, 'Sin detalle')
  )
  select coalesce(jsonb_object_agg(label, jsonb_build_object('amount', amount, 'count', count)), '{}'::jsonb)
  into v_expense_details
  from expense_rows;

  with month_series as (
    select generate_series(date_trunc('month', v_from)::date, date_trunc('month', v_to)::date, interval '1 month')::date as month_start
  ),
  monthly_sales as (
    select
      date_trunc('month', s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date as month_start,
      coalesce(sum(s.total), 0) as fake_income,
      coalesce(sum(case when coalesce(ps.payment_count, 0) > 0 then coalesce(ps.initial_paid, 0) else least(s.paid_amount, s.total) end), 0) as sales_real_income
    from public.sales s
    left join (
      select
        p.sale_id,
        coalesce(sum(p.amount) filter (where lower(coalesce(p.note, '')) like '%pago registrado al crear la venta%'), 0) as initial_paid,
        count(p.id) as payment_count
      from public.payments p
      where p.sale_id is not null
      group by p.sale_id
    ) ps on ps.sale_id = s.id
    where s.archived_at is null
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date >= date_trunc('month', v_from)::date
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
    group by date_trunc('month', s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  monthly_debt_collections as (
    select
      date_trunc('month', p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date as month_start,
      coalesce(sum(p.amount), 0) as debt_collections
    from public.payments p
    left join public.sales s on s.id = p.sale_id
    where lower(coalesce(p.note, '')) not like '%pago registrado al crear la venta%'
      and (s.id is null or s.archived_at is null)
      and (p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date >= date_trunc('month', v_from)::date
      and (p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
    group by date_trunc('month', p.paid_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  monthly_costs as (
    select
      date_trunc('month', s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date as month_start,
      coalesce(sum(si.quantity * si.unit_cost), 0) as merchandise_cost
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.archived_at is null
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date >= date_trunc('month', v_from)::date
      and (s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
    group by date_trunc('month', s.sold_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  monthly_expenses as (
    select
      date_trunc('month', e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date as month_start,
      coalesce(sum(e.amount), 0) as expenses
    from public.expenses e
    where e.archived_at is null
      and e.category not in ('CompraMercaderia', 'Mercaderia')
      and (e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date >= date_trunc('month', v_from)::date
      and (e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date <= v_to
    group by date_trunc('month', e.expense_at at time zone 'America/Argentina/Buenos_Aires')::date
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', to_char(ms.month_start, 'YYYY-MM'),
      'income', coalesce(s.sales_real_income, 0) + coalesce(d.debt_collections, 0),
      'realIncome', coalesce(s.sales_real_income, 0) + coalesce(d.debt_collections, 0),
      'fakeIncome', coalesce(s.fake_income, 0),
      'salesRealIncome', coalesce(s.sales_real_income, 0),
      'debtCollections', coalesce(d.debt_collections, 0),
      'costs', coalesce(e.expenses, 0) + coalesce(c.merchandise_cost, 0),
      'margin', coalesce(s.sales_real_income, 0) + coalesce(d.debt_collections, 0) - coalesce(e.expenses, 0) - coalesce(c.merchandise_cost, 0),
      'marginRate', case when coalesce(s.sales_real_income, 0) + coalesce(d.debt_collections, 0) > 0 then ((coalesce(s.sales_real_income, 0) + coalesce(d.debt_collections, 0) - coalesce(e.expenses, 0) - coalesce(c.merchandise_cost, 0)) / (coalesce(s.sales_real_income, 0) + coalesce(d.debt_collections, 0))) * 100 else 0 end
    )
    order by ms.month_start
  ), '[]'::jsonb)
  into v_trend
  from month_series ms
  left join monthly_sales s on s.month_start = ms.month_start
  left join monthly_debt_collections d on d.month_start = ms.month_start
  left join monthly_expenses e on e.month_start = ms.month_start
  left join monthly_costs c on c.month_start = ms.month_start;

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'scope', v_scope,
    'salesCount', v_sales_count,
    'income', v_real_income,
    'fakeIncome', v_fake_income,
    'salesRealIncome', v_sales_real_income,
    'debtCollections', v_debt_collections,
    'realIncome', v_real_income,
    'localIncome', v_real_income,
    'webInsumos', 0,
    'webAccesorios', 0,
    'shipping', 0,
    'fixedExpenses', v_fixed_expenses,
    'variableExpenses', v_variable_expenses,
    'expenseTotal', v_fixed_expenses + v_variable_expenses,
    'merchandiseCost', v_merchandise_cost,
    'margin', v_real_income - v_fixed_expenses - v_variable_expenses - v_merchandise_cost,
    'ticket', case when v_sales_count > 0 then v_fake_income / v_sales_count else 0 end,
    'categories', v_categories,
    'subcategories', v_subcategories,
    'subcategoryCategories', v_subcategory_categories,
    'provinces', '{}'::jsonb,
    'payments', v_payments,
    'expenseDetails', v_expense_details,
    'trend', v_trend
  );
end;
$$;

revoke all on function public.get_report_summary(date, date, text) from public, anon;
grant execute on function public.get_report_summary(date, date, text) to authenticated;

notify pgrst, 'reload schema';
commit;

