-- ============================================================================
-- DAGOLDOL PHASE 3 — LIVE DATABASE PREFLIGHT (READ ONLY)
-- ============================================================================
-- Run in Supabase SQL Editor before the Phase 3 migration if you want a
-- human-readable snapshot of the live schema/security contract. This script
-- performs SELECT statements only; it does not change database data or policy.
-- ============================================================================

-- 1. Relevant public-table columns and types.
select
  table_name,
  ordinal_position,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in (
    'profiles', 'products', 'brands', 'flash_sales', 'promo_codes', 'bundles',
    'orders', 'ratings', 'settings', 'messages', 'activity', 'dm_threads', 'dm_messages'
  )
order by table_name, ordinal_position;

-- 2. Current RLS policies on Dagoldol tables.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'profiles', 'products', 'brands', 'flash_sales', 'promo_codes', 'bundles',
    'orders', 'ratings', 'settings', 'messages', 'activity', 'dm_threads', 'dm_messages'
  )
order by tablename, policyname;

-- 3. Existing public functions used by the frontend or security policies.
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as security_definer,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'is_admin',
    'decrement_stock_for_order',
    'restore_stock_for_order',
    'get_public_recommendation_signals'
  )
order by p.proname, arguments;

-- 4. Storage buckets used by the supplied frontend.
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('avatars', 'payment-proofs', 'product-images', 'brand-logos', 'payment-settings')
order by id;

-- 5. Storage-object RLS policies.
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'storage'
  and tablename = 'objects'
order by policyname;

-- 6. Existing rating rows that would block the Phase 3 1..5 constraint.
select count(*) as invalid_rating_value_count
from public.ratings
where value is null or value < 1 or value > 5;
