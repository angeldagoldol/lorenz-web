-- ============================================================================
-- DAGOLDOL — PHASE 1 READ-ONLY PRODUCTION SCHEMA / RLS / STORAGE EXPORT
-- File: 03-dagoldol-phase1-source-gap-export.sql
--
-- PURPOSE:
--   Run this in Supabase SQL Editor against the CURRENT production project.
--   It performs SELECT-only inspection so the missing production evidence can
--   be compared with script.js before writing the final checkout/RLS/storage
--   migration.
--
-- THIS FILE DOES NOT CREATE, ALTER, UPDATE, INSERT, OR DELETE DATA.
-- ============================================================================

-- --------------------------------------------------------------------------
-- A. Server identity / version
-- --------------------------------------------------------------------------
select
  current_database() as database_name,
  current_user as current_user_name,
  current_setting('server_version') as postgres_version;

-- --------------------------------------------------------------------------
-- B. Exact columns for every public object directly referenced by current JS
-- --------------------------------------------------------------------------
select
  c.table_schema,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
from information_schema.columns as c
where c.table_schema = 'public'
  and c.table_name in (
    'profiles',
    'products',
    'orders',
    'messages',
    'activity',
    'ratings',
    'settings',
    'brands',
    'bundles',
    'flash_sales',
    'promo_codes',
    'dm_threads',
    'dm_messages'
  )
order by c.table_name, c.ordinal_position;

-- --------------------------------------------------------------------------
-- C. Tables/views that actually exist in public
-- --------------------------------------------------------------------------
select
  t.table_schema,
  t.table_name,
  t.table_type
from information_schema.tables as t
where t.table_schema = 'public'
order by t.table_name;

-- --------------------------------------------------------------------------
-- D. Primary keys, foreign keys, unique constraints, and check constraints
-- --------------------------------------------------------------------------
select
  n.nspname as schema_name,
  cls.relname as table_name,
  con.conname as constraint_name,
  case con.contype
    when 'p' then 'PRIMARY KEY'
    when 'f' then 'FOREIGN KEY'
    when 'u' then 'UNIQUE'
    when 'c' then 'CHECK'
    when 'x' then 'EXCLUSION'
    else con.contype::text
  end as constraint_type,
  pg_get_constraintdef(con.oid, true) as definition
from pg_constraint as con
join pg_class as cls on cls.oid = con.conrelid
join pg_namespace as n on n.oid = cls.relnamespace
where n.nspname = 'public'
order by cls.relname, con.conname;

-- --------------------------------------------------------------------------
-- E. RLS enabled / forced state for public tables
-- --------------------------------------------------------------------------
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class as c
join pg_namespace as n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r', 'p')
order by c.relname;

-- --------------------------------------------------------------------------
-- F. EVERY current public RLS policy
-- --------------------------------------------------------------------------
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
order by tablename, policyname;

-- --------------------------------------------------------------------------
-- G. Grants for API-facing roles on public tables
-- --------------------------------------------------------------------------
select
  table_schema,
  table_name,
  grantee,
  privilege_type,
  is_grantable
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;

-- --------------------------------------------------------------------------
-- H. Exact definitions of security/business functions used by the app
-- --------------------------------------------------------------------------
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  pg_get_functiondef(p.oid) as function_definition
from pg_proc as p
join pg_namespace as n on n.oid = p.pronamespace
where n.nspname in ('public', 'private')
  and p.proname in (
    'is_admin',
    'decrement_stock_for_order',
    'restore_stock_for_order'
  )
order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid);

-- --------------------------------------------------------------------------
-- I. Trigger inventory for protected/public tables
-- --------------------------------------------------------------------------
select
  event_object_schema as table_schema,
  event_object_table as table_name,
  trigger_name,
  action_timing,
  event_manipulation,
  action_statement
from information_schema.triggers
where event_object_schema = 'public'
order by event_object_table, trigger_name, event_manipulation;

-- --------------------------------------------------------------------------
-- J. Realtime publication membership
-- --------------------------------------------------------------------------
select
  pubname,
  schemaname,
  tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by schemaname, tablename;

-- --------------------------------------------------------------------------
-- K. Storage buckets and their access/restriction configuration
-- --------------------------------------------------------------------------
select
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types,
  created_at,
  updated_at
from storage.buckets
order by id;

-- --------------------------------------------------------------------------
-- L. EVERY current Storage RLS policy (objects + buckets)
-- --------------------------------------------------------------------------
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
  and tablename in ('objects', 'buckets')
order by tablename, policyname;

-- --------------------------------------------------------------------------
-- M. Storage RLS enabled / forced state
-- --------------------------------------------------------------------------
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class as c
join pg_namespace as n on n.oid = c.relnamespace
where n.nspname = 'storage'
  and c.relname in ('objects', 'buckets')
order by c.relname;

-- --------------------------------------------------------------------------
-- N. Non-sensitive structural verification of orders.items JSON keys
--    (returns key names only, not customer values)
-- --------------------------------------------------------------------------
select distinct
  jsonb_object_keys(item) as top_level_item_key
from public.orders as o
cross join lateral jsonb_array_elements(o.items) as item
order by top_level_item_key;

select distinct
  jsonb_object_keys(component) as bundle_component_key
from public.orders as o
cross join lateral jsonb_array_elements(o.items) as item
cross join lateral jsonb_array_elements(
  case
    when jsonb_typeof(item -> 'components') = 'array'
      then item -> 'components'
    else '[]'::jsonb
  end
) as component
order by bundle_component_key;

-- --------------------------------------------------------------------------
-- O. Index inventory for public tables used by the app
-- --------------------------------------------------------------------------
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'profiles', 'products', 'orders', 'messages', 'activity', 'ratings',
    'settings', 'brands', 'bundles', 'flash_sales', 'promo_codes',
    'dm_threads', 'dm_messages'
  )
order by tablename, indexname;

-- ============================================================================
-- END — copy/save the complete SQL Editor results and provide them with the
-- current production schema file. Those results unblock the final P0 checkout,
-- stock/promo transaction, rating ownership, DM, bundle, and Storage policies.
-- ============================================================================
