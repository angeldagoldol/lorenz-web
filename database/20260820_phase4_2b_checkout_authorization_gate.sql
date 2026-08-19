-- ============================================================================
-- DAGOLDOL PHASE 4.2B — CHECKOUT AUTHORIZATION CUTOVER GATE
-- READ ONLY / DIAGNOSTIC. THIS IS NOT A MIGRATION.
--
-- Purpose: make the currently verified blockers explicit before any attempt to
-- revoke authenticated stock-helper execution or direct customer order INSERT.
-- The exact current Dagoldol 3.3.5 script.js must also pass source verification;
-- SQL alone cannot prove that browser calls have been removed.
-- ============================================================================

-- 1. Live orders contract versus fields referenced by the retrievable Phase 3
-- frontend and the current live place_order() implementation.
with expected(column_name) as (
  values
    ('id'),('user_id'),('username'),('items'),('subtotal'),('delivery_fee'),
    ('bulk_fee_rate'),('bulk_fee'),('total'),('payment_method'),('address'),
    ('placed_at'),('delivery_days'),('status_override'),('cancelled'),('rated'),
    ('promo_code'),('promo_discount'),
    ('payment_reference'),('payment_proof'),('half_payment'),
    ('amount_due_now'),('amount_due_later')
)
select
  e.column_name,
  exists (
    select 1
    from information_schema.columns c
    where c.table_schema='public'
      and c.table_name='orders'
      and c.column_name=e.column_name
  ) as exists_in_live_orders
from expected e
order by e.column_name;

-- 2. The current live inventory representation is products.sizes JSON. The
-- subscription helpers inspected on 2026-08-20 still reference products.stock.
select
  exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='sizes'
  ) as products_sizes_exists,
  exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='stock'
  ) as products_top_level_stock_exists;

-- 3. Function/browser privilege state. Full 4.2 closure requires all direct
-- stock-helper customer privileges below to be FALSE after frontend cutover.
select
  has_function_privilege('anon','public.decrement_stock_for_order(jsonb)','EXECUTE') as anon_can_decrement_stock,
  has_function_privilege('authenticated','public.decrement_stock_for_order(jsonb)','EXECUTE') as customer_can_decrement_stock,
  has_function_privilege('anon','public.restore_stock_for_order(jsonb)','EXECUTE') as anon_can_restore_stock,
  has_function_privilege('authenticated','public.restore_stock_for_order(jsonb)','EXECUTE') as customer_can_restore_stock,
  has_function_privilege(
    'authenticated',
    'public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer)',
    'EXECUTE'
  ) as customer_can_call_place_order;

-- 4. Direct customer order INSERT state. Full 4.2 closure requires no customer
-- direct INSERT policy once the trusted checkout command is functioning.
select
  policyname,
  roles,
  cmd,
  with_check
from pg_policies
where schemaname='public' and tablename='orders' and cmd='INSERT'
order by policyname;

select exists (
  select 1 from pg_policies
  where schemaname='public' and tablename='orders'
    and policyname='p42_orders_insert_owner_compat_phase42a'
    and cmd='INSERT'
) as p42_orders_insert_owner_compat_phase42a_still_present;

-- 5. Current function definitions for final reconciliation.
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in (
    'place_order','decrement_stock_for_order','restore_stock_for_order',
    'process_subscription','decrement_stock_for_subscription','verify_stock_for_subscription'
  )
order by p.proname, arguments;

-- DATABASE EXIT CONDITIONS FOR PHASE 4.2B:
--   1. trusted checkout/cancellation functions compile against the actual schema;
--   2. authenticated cannot execute decrement_stock_for_order/restore_stock_for_order;
--   3. no customer direct INSERT policy remains on orders;
--   4. only the intended browser-facing checkout/cancellation commands are
--      executable by authenticated;
--   5. exact current 3.3.5 source verification confirms browser code no longer
--      calls stock helpers, direct orders.insert(), or direct promo used_count.
-- ============================================================================
-- DAGOLDOL PHASE 4.2B — CHECKOUT AUTHORIZATION CUTOVER GATE
-- READ ONLY / DIAGNOSTIC. THIS IS NOT A MIGRATION.
--
-- Purpose: make the currently verified blockers explicit before any attempt to
-- revoke authenticated stock-helper execution or direct customer order INSERT.
-- The exact current Dagoldol 3.3.5 script.js must also pass source verification;
-- SQL alone cannot prove that browser calls have been removed.
-- ============================================================================

-- 1. Live orders contract versus fields referenced by the retrievable Phase 3
-- frontend and the current live place_order() implementation.
with expected(column_name) as (
  values
    ('id'),('user_id'),('username'),('items'),('subtotal'),('delivery_fee'),
    ('bulk_fee_rate'),('bulk_fee'),('total'),('payment_method'),('address'),
    ('placed_at'),('delivery_days'),('status_override'),('cancelled'),('rated'),
    ('promo_code'),('promo_discount'),
    ('payment_reference'),('payment_proof'),('half_payment'),
    ('amount_due_now'),('amount_due_later')
)
select
  e.column_name,
  exists (
    select 1
    from information_schema.columns c
    where c.table_schema='public'
      and c.table_name='orders'
      and c.column_name=e.column_name
  ) as exists_in_live_orders
from expected e
order by e.column_name;

-- 2. The current live inventory representation is products.sizes JSON. The
-- subscription helpers inspected on 2026-08-20 still reference products.stock.
select
  exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='sizes'
  ) as products_sizes_exists,
  exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='stock'
  ) as products_top_level_stock_exists;

-- 3. Function/browser privilege state. Full 4.2 closure requires all direct
-- stock-helper customer privileges below to be FALSE after frontend cutover.
select
  has_function_privilege('anon','public.decrement_stock_for_order(jsonb)','EXECUTE') as anon_can_decrement_stock,
  has_function_privilege('authenticated','public.decrement_stock_for_order(jsonb)','EXECUTE') as customer_can_decrement_stock,
  has_function_privilege('anon','public.restore_stock_for_order(jsonb)','EXECUTE') as anon_can_restore_stock,
  has_function_privilege('authenticated','public.restore_stock_for_order(jsonb)','EXECUTE') as customer_can_restore_stock,
  has_function_privilege(
    'authenticated',
    'public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer)',
    'EXECUTE'
  ) as customer_can_call_place_order;

-- 4. Direct customer order INSERT state. Full 4.2 closure requires no customer
-- direct INSERT policy once the trusted checkout command is functioning.
select
  policyname,
  roles,
  cmd,
  with_check
from pg_policies
where schemaname='public' and tablename='orders' and cmd='INSERT'
order by policyname;

select exists (
  select 1 from pg_policies
  where schemaname='public' and tablename='orders'
    and policyname='p42_orders_insert_owner_compat_phase42a'
    and cmd='INSERT'
) as p42_orders_insert_owner_compat_phase42a_still_present;

-- 5. Current function definitions for final reconciliation.
select
  p.proname,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in (
    'place_order','decrement_stock_for_order','restore_stock_for_order',
    'process_subscription','decrement_stock_for_subscription','verify_stock_for_subscription'
  )
order by p.proname, arguments;

-- DATABASE EXIT CONDITIONS FOR PHASE 4.2B:
--   1. trusted checkout/cancellation functions compile against the actual schema;
--   2. authenticated cannot execute decrement_stock_for_order/restore_stock_for_order;
--   3. no customer direct INSERT policy remains on orders;
--   4. only the intended browser-facing checkout/cancellation commands are
--      executable by authenticated;
--   5. exact current 3.3.5 source verification confirms browser code no longer
--      calls stock helpers, direct orders.insert(), or direct promo used_count.
