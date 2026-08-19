-- DAGOLDOL PHASE 4.2 — LIVE AUTHORIZATION CONTRACT EXPORT (READ ONLY)
-- Date: 2026-08-20
-- This file performs SELECT statements only.

select current_database() as database_name,
       current_user as current_user_name,
       current_setting('server_version') as postgres_version;

select c.table_schema, c.table_name, c.ordinal_position, c.column_name,
       c.data_type, c.udt_name, c.is_nullable, c.column_default
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name = any (array[
    'activity','brands','bundles','chat_messages','chat_threads','dm_messages',
    'dm_threads','flash_sales','gift_card_transactions','gift_cards','messages',
    'orders','products','profiles','promo_codes','ratings','settings',
    'subscription_orders','subscriptions'
  ])
order by c.table_name, c.ordinal_position;

select n.nspname as schema_name, cls.relname as table_name,
       cls.relrowsecurity as rls_enabled, cls.relforcerowsecurity as rls_forced
from pg_class cls
join pg_namespace n on n.oid = cls.relnamespace
where n.nspname in ('public','storage')
  and cls.relkind = 'r'
  and (
    (n.nspname='public' and cls.relname = any (array[
      'activity','brands','bundles','chat_messages','chat_threads','dm_messages',
      'dm_threads','flash_sales','gift_card_transactions','gift_cards','messages',
      'orders','products','profiles','promo_codes','ratings','settings',
      'subscription_orders','subscriptions'
    ]))
    or (n.nspname='storage' and cls.relname='objects')
  )
order by n.nspname, cls.relname;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where (schemaname='public' and tablename = any (array[
        'activity','brands','bundles','chat_messages','chat_threads','dm_messages',
        'dm_threads','flash_sales','gift_card_transactions','gift_cards','messages',
        'orders','products','profiles','promo_codes','ratings','settings',
        'subscription_orders','subscriptions'
      ]))
   or (schemaname='storage' and tablename='objects')
order by schemaname, tablename, policyname;

select grantee, table_schema, table_name, privilege_type
from information_schema.role_table_grants
where grantee in ('anon','authenticated','service_role')
  and (
    (table_schema='public' and table_name = any (array[
      'activity','brands','bundles','chat_messages','chat_threads','dm_messages',
      'dm_threads','flash_sales','gift_card_transactions','gift_cards','messages',
      'orders','products','profiles','promo_codes','ratings','settings',
      'subscription_orders','subscriptions'
    ]))
    or (table_schema='storage' and table_name='objects')
  )
order by table_schema, table_name, grantee, privilege_type;

select n.nspname as schema_name, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
       pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
order by p.proname, arguments;

select n.nspname as schema_name, c.relname as table_name, t.tgname as trigger_name,
       pg_get_triggerdef(t.oid, true) as trigger_definition
from pg_trigger t
join pg_class c on c.oid=t.tgrelid
join pg_namespace n on n.oid=c.relnamespace
where not t.tgisinternal
  and n.nspname in ('public','storage')
order by n.nspname, c.relname, t.tgname;

select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id in ('avatars','brand-logos','payment-proofs','payment-settings','product-images')
order by id;

select schemaname, tablename, indexname, indexdef
from pg_indexes
where schemaname='public'
  and tablename = any (array['orders','ratings','gift_cards','gift_card_transactions','subscriptions','subscription_orders'])
order by tablename,indexname;
