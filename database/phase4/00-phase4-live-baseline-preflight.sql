-- DAGOLDOL PHASE 4.1 — LIVE DATABASE / RLS / STORAGE BASELINE (READ ONLY)
-- This file contains SELECT statements only. It must not mutate production.
-- Save every result grid before Phase 4.2. Do not infer missing objects.

-- 0. Server identity/version (non-secret metadata only).
select
  current_database() as database_name,
  current_user as current_user_name,
  current_setting('server_version') as postgres_version,
  now() as captured_at;

-- 1. Every table/view in public.
select table_schema, table_name, table_type
from information_schema.tables
where table_schema = 'public'
order by table_name;

-- 2. Public-table columns and defaults.
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_name,
  c.is_nullable,
  c.column_default
from information_schema.columns c
where c.table_schema = 'public'
order by c.table_name, c.ordinal_position;

-- 3. Primary/unique/foreign/check constraints.
select
  n.nspname as schema_name,
  cls.relname as table_name,
  con.conname as constraint_name,
  con.contype as constraint_type,
  pg_get_constraintdef(con.oid, true) as definition
from pg_constraint con
join pg_class cls on cls.oid = con.conrelid
join pg_namespace n on n.oid = cls.relnamespace
where n.nspname = 'public'
order by cls.relname, con.conname;

-- 4. Indexes used by current query paths and integrity rules.
select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;

-- 5. Table-level RLS status.
select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as force_rls
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind in ('r','p')
order by c.relname;

-- 6. Current public RLS policies, all tables.
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

-- 7. Public functions and security mode.
select
  n.nspname as schema_name,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as security_definer,
  p.provolatile as volatility,
  p.proconfig as function_config,
  pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname, arguments;

-- 8. Public triggers and their complete definitions.
select
  event_object_table as table_name,
  trigger_name,
  action_timing,
  event_manipulation,
  action_orientation,
  action_statement
from information_schema.triggers
where trigger_schema = 'public'
order by event_object_table, trigger_name, event_manipulation;

-- 9. Realtime publication membership for public tables.
select
  p.pubname,
  n.nspname as schema_name,
  c.relname as table_name
from pg_publication p
join pg_publication_rel pr on pr.prpubid = p.oid
join pg_class c on c.oid = pr.prrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
order by p.pubname, c.relname;

-- 10. Storage buckets and production limits.
select id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at
from storage.buckets
order by id;

-- 11. Storage-object RLS policies.
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
where schemaname = 'storage' and tablename = 'objects'
order by policyname;

-- 12. Known Dagoldol security/integrity object presence.
select
  to_regclass('public.profiles') is not null as profiles_exists,
  to_regclass('public.products') is not null as products_exists,
  to_regclass('public.orders') is not null as orders_exists,
  to_regclass('public.ratings') is not null as ratings_exists,
  to_regclass('public.promo_codes') is not null as promo_codes_exists,
  to_regclass('public.bundles') is not null as bundles_exists,
  to_regclass('public.dm_threads') is not null as dm_threads_exists,
  to_regclass('public.dm_messages') is not null as dm_messages_exists,
  to_regprocedure('public.is_admin()') is not null as is_admin_exists,
  to_regprocedure('public.guard_profile_role_client()') is not null as profile_role_guard_exists,
  to_regprocedure('public.guard_customer_order_write()') is not null as customer_order_guard_exists;

-- 13. Validation-only row counts that reveal incompatible legacy data.
-- Counts only; do not return private row content.
select
  (select count(*) from public.profiles) as profile_count,
  (select count(*) from public.orders) as order_count,
  (select count(*) from public.ratings) as rating_count;

-- 14. Invalid rating-domain count when ratings exists with value column.
select count(*) as invalid_rating_value_count
from public.ratings
where value is null or value < 1 or value > 5;

-- End of read-only Phase 4.1 preflight.
