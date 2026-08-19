-- ============================================================================
-- DAGOLDOL PHASE 4.2B — PRE-MIGRATION PREFLIGHT
-- READ ONLY. SAFE TO RUN ON PRODUCTION.
--
-- Expected before first Phase 4.2B deployment:
--   phase42b_preflight_status = READY
--
-- This file does not create, alter, update, insert, or delete anything.
-- ============================================================================

with
required_tables(table_name) as (
  values ('orders'),('products'),('bundles'),('flash_sales'),('promo_codes'),('profiles')
),
missing_tables as (
  select r.table_name
  from required_tables r
  where to_regclass('public.' || r.table_name) is null
),
required_functions(signature) as (
  values
    ('public.is_admin()'),
    ('public.decrement_stock_for_order(jsonb)'),
    ('public.restore_stock_for_order(jsonb)')
),
missing_functions as (
  select r.signature
  from required_functions r
  where to_regprocedure(r.signature) is null
),
public_policy_state as (
  select
    count(*) filter (
      where tablename in ('orders','products','promo_codes','profiles')
        and policyname not like 'p42\_%' escape '\'
    )::int as noncanonical_policy_count,
    bool_or(
      tablename='orders'
      and policyname in ('p42_orders_insert_owner_compat_phase42a','p42_orders_insert_owner')
      and cmd='INSERT'
    ) as has_owned_order_insert
  from pg_policies
  where schemaname='public'
),
storage_state as (
  select
    exists (
      select 1 from storage.buckets
      where id='payment-proofs' and public=false
    ) as payment_proofs_private,
    not exists (
      select 1 from pg_policies
      where schemaname='storage' and tablename='objects'
        and policyname in (
          'storage_public_read','storage_avatar_upload_own',
          'storage_payment_proof_upload_own','storage_admin_delete',
          'storage_admin_manage','storage_admin_upload'
        )
    ) as phase42a2_unsafe_legacy_removed,
    not exists (
      select 1 from pg_policies
      where schemaname='storage' and tablename='objects' and cmd='SELECT'
        and (roles @> array['public']::name[] or roles @> array['anon']::name[])
        and coalesce(qual,'') ilike '%payment-proofs%'
    ) as no_public_payment_proof_select
),
order_data_state as (
  select
    count(*)::int as order_count,
    count(*) filter (
      where payment_method not in ('gcash','bank')
    )::int as invalid_payment_method_rows,
    count(*) filter (
      where subtotal < 0
         or delivery_fee < 0
         or bulk_fee_rate < 0
         or bulk_fee_rate > 1
         or bulk_fee < 0
         or cod_fee < 0
         or total < 0
         or coalesce(promo_discount,0) < 0
    )::int as invalid_money_rows
  from public.orders
),
product_schema_state as (
  select
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='products' and column_name='sizes'
    ) as has_sizes,
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='products' and column_name='stock'
    ) as has_unexpected_top_level_stock
),
trigger_state as (
  select exists (
    select 1 from pg_trigger
    where tgrelid='public.orders'::regclass
      and tgname='orders_guard_customer_write'
      and not tgisinternal
  ) as has_order_guard
)
select
  case
    when not exists (select 1 from missing_tables)
     and not exists (select 1 from missing_functions)
     and coalesce(pps.noncanonical_policy_count,0)=0
     and coalesce(pps.has_owned_order_insert,false)
     and ss.payment_proofs_private
     and ss.phase42a2_unsafe_legacy_removed
     and ss.no_public_payment_proof_select
     and ods.invalid_payment_method_rows=0
     and ods.invalid_money_rows=0
     and pss.has_sizes
     and not pss.has_unexpected_top_level_stock
     and ts.has_order_guard
    then 'READY'
    else 'BLOCKED'
  end as phase42b_preflight_status,

  coalesce((select jsonb_agg(table_name order by table_name) from missing_tables),'[]'::jsonb)
    as missing_tables,
  coalesce((select jsonb_agg(signature order by signature) from missing_functions),'[]'::jsonb)
    as missing_functions,
  coalesce(pps.noncanonical_policy_count,0) as noncanonical_public_policy_count,
  coalesce(pps.has_owned_order_insert,false) as owned_order_insert_policy_present,
  ss.payment_proofs_private,
  ss.phase42a2_unsafe_legacy_removed,
  ss.no_public_payment_proof_select,
  ods.order_count,
  ods.invalid_payment_method_rows,
  ods.invalid_money_rows,
  pss.has_sizes as products_sizes_present,
  pss.has_unexpected_top_level_stock as products_top_level_stock_present,
  ts.has_order_guard as orders_guard_trigger_present,
  has_function_privilege('authenticated','public.decrement_stock_for_order(jsonb)','EXECUTE')
    as compatibility_decrement_currently_callable,
  has_function_privilege('authenticated','public.restore_stock_for_order(jsonb)','EXECUTE')
    as compatibility_restore_currently_callable;
