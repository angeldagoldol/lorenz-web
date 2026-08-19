-- ============================================================================
-- DAGOLDOL PHASE 4.2B — COMMERCE AUTHORITY STRUCTURAL CONTRACT
-- READ ONLY. SAFE TO RUN AFTER THE PHASE 4.2B MIGRATION.
--
-- This verifier checks effective authority, not merely whether browser-facing
-- compatibility RPCs still have EXECUTE. Those RPCs intentionally remain
-- callable by authenticated clients so the current 3.3.5 source is not broken;
-- they must no longer mutate inventory.
-- ============================================================================

with
required_columns(column_name) as (
  values
    ('payment_reference'),
    ('payment_proof'),
    ('half_payment'),
    ('amount_due_now'),
    ('amount_due_later')
),
missing_columns as (
  select r.column_name
  from required_columns r
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema='public'
      and c.table_name='orders'
      and c.column_name=r.column_name
  )
),
function_state as (
  select
    coalesce(pg_get_functiondef(to_regprocedure('public.decrement_stock_for_order(jsonb)')),'') as decrement_def,
    coalesce(pg_get_functiondef(to_regprocedure('public.restore_stock_for_order(jsonb)')),'') as restore_def,
    coalesce(pg_get_functiondef(to_regprocedure('public.guard_customer_order_write()')),'') as guard_def,
    coalesce(pg_get_functiondef(to_regprocedure('public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer)')),'') as place_order_def
),
security_state as (
  select
    coalesce((
      select p.prosecdef
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='decrement_stock_for_order'
        and pg_get_function_identity_arguments(p.oid)='p_lines jsonb'
      limit 1
    ), true) as decrement_is_security_definer,
    coalesce((
      select p.prosecdef
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='restore_stock_for_order'
        and pg_get_function_identity_arguments(p.oid)='p_lines jsonb'
      limit 1
    ), true) as restore_is_security_definer,
    coalesce((
      select p.prosecdef
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='place_order'
        and pg_get_function_identity_arguments(p.oid)='p_order_id text, p_items jsonb, p_address jsonb, p_payment_method text, p_payment_reference text, p_payment_proof text, p_half_payment boolean, p_delivery_fee numeric, p_promo_code text, p_delivery_days integer'
      limit 1
    ), true) as place_order_is_security_definer
),
policy_state as (
  select
    exists (
      select 1 from pg_policies
      where schemaname='public'
        and tablename='orders'
        and policyname='p42_orders_insert_owner'
        and cmd='INSERT'
        and roles @> array['authenticated']::name[]
        and coalesce(with_check,'') ilike '%auth.uid()%'
    ) as stable_owner_insert_present,
    exists (
      select 1 from pg_policies
      where schemaname='public'
        and tablename='orders'
        and policyname='p42_orders_insert_owner_compat_phase42a'
    ) as temporary_insert_present
),
private_state as (
  select
    to_regprocedure('dagoldol_private.apply_stock_lines(jsonb,integer)') is not null as private_stock_function_present,
    case
      when to_regprocedure('dagoldol_private.apply_stock_lines(jsonb,integer)') is null then true
      else has_function_privilege(
        'authenticated',
        'dagoldol_private.apply_stock_lines(jsonb,integer)',
        'EXECUTE'
      )
    end as customer_can_execute_private_stock
)
select
  case
    when not exists (select 1 from missing_columns)
     and lower(fs.decrement_def) not like '%update public.products%'
     and lower(fs.restore_def) not like '%update public.products%'
     and lower(fs.guard_def) like '%dagoldol_private.apply_stock_lines%'
     and lower(fs.guard_def) like '%update public.promo_codes%'
     and lower(fs.guard_def) like '%customers may not modify protected order fields%'
     and not ss.decrement_is_security_definer
     and not ss.restore_is_security_definer
     and not ss.place_order_is_security_definer
     and ps.stable_owner_insert_present
     and not ps.temporary_insert_present
     and prs.private_stock_function_present
     and not prs.customer_can_execute_private_stock
    then 'PASS'
    else 'OPEN'
  end as phase42b_contract_status,

  coalesce(
    (select jsonb_agg(column_name order by column_name) from missing_columns),
    '[]'::jsonb
  ) as missing_order_columns,

  lower(fs.decrement_def) like '%update public.products%' as public_decrement_mutates_products,
  lower(fs.restore_def) like '%update public.products%' as public_restore_mutates_products,
  lower(fs.guard_def) like '%dagoldol_private.apply_stock_lines%' as order_guard_has_atomic_stock,
  lower(fs.guard_def) like '%update public.promo_codes%' as order_guard_has_atomic_promo,
  ps.stable_owner_insert_present,
  ps.temporary_insert_present,
  prs.private_stock_function_present,
  prs.customer_can_execute_private_stock,
  ss.decrement_is_security_definer,
  ss.restore_is_security_definer,
  ss.place_order_is_security_definer,

  has_function_privilege(
    'authenticated',
    'public.decrement_stock_for_order(jsonb)',
    'EXECUTE'
  ) as compatibility_decrement_rpc_still_callable,
  has_function_privilege(
    'authenticated',
    'public.restore_stock_for_order(jsonb)',
    'EXECUTE'
  ) as compatibility_restore_rpc_still_callable,

  'Delivery route pricing remains a Phase 4.3 server-checkout responsibility.'::text
    as residual_phase43_boundary

from function_state fs
cross join security_state ss
cross join policy_state ps
cross join private_state prs;
