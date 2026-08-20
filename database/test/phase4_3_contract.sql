-- DAGOLDOL PHASE 4.3 structural/security contract.
-- Read-only. Expected result: one row with phase43_contract_status = PASS.

with checks as (
  select
    exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='orders' and column_name='delivery_quote' and udt_name='jsonb'
    ) as orders_delivery_quote_ok,
    to_regclass('dagoldol_private.delivery_config') is not null as delivery_config_ok,
    to_regclass('dagoldol_private.delivery_free_zones') is not null as delivery_free_zones_ok,
    to_regclass('dagoldol_private.checkout_requests') is not null as checkout_requests_ok,
    exists (
      select 1 from information_schema.columns
      where table_schema='dagoldol_private' and table_name='checkout_requests'
        and column_name='idempotency_key' and udt_name='uuid'
    ) as idempotency_uuid_ok,
    exists (
      select 1 from information_schema.columns
      where table_schema='dagoldol_private' and table_name='checkout_requests'
        and column_name='request_fingerprint'
    ) as fingerprint_column_ok,
    exists (
      select 1 from pg_indexes
      where schemaname='dagoldol_private' and tablename='checkout_requests'
        and indexname='checkout_requests_order_id_idx'
    ) as order_fk_index_ok,
    coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='dagoldol_private' and c.relname='checkout_requests'),false) as checkout_requests_rls,
    coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='dagoldol_private' and c.relname='delivery_config'),false) as delivery_config_rls,
    coalesce((select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
              where n.nspname='dagoldol_private' and c.relname='delivery_free_zones'),false) as delivery_zones_rls,
    to_regprocedure('dagoldol_private.p43_delivery_config_hash()') is not null as config_hash_ok,
    to_regprocedure('dagoldol_private.p43_normalize_request(jsonb,boolean)') is not null as normalize_request_ok,
    to_regprocedure('dagoldol_private.p43_request_fingerprint(jsonb)') is not null as request_fingerprint_ok,
    to_regprocedure('dagoldol_private.p43_resolve_checkout(uuid,jsonb,jsonb,text,boolean)') is not null as resolver_ok,
    to_regprocedure('public.p43_get_routing_config()') is not null as routing_config_rpc_ok,
    to_regprocedure('public.p43_quote_checkout(uuid,jsonb,jsonb,text)') is not null as quote_rpc_ok,
    to_regprocedure('public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text)') is not null as commit_rpc_ok,
    has_function_privilege('service_role','public.p43_get_routing_config()','EXECUTE') as service_routing_exec,
    has_function_privilege('service_role','public.p43_quote_checkout(uuid,jsonb,jsonb,text)','EXECUTE') as service_quote_exec,
    has_function_privilege('service_role','public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text)','EXECUTE') as service_commit_exec,
    has_function_privilege('anon','public.p43_get_routing_config()','EXECUTE') as anon_routing_exec,
    has_function_privilege('authenticated','public.p43_get_routing_config()','EXECUTE') as auth_routing_exec,
    has_function_privilege('anon','public.p43_quote_checkout(uuid,jsonb,jsonb,text)','EXECUTE') as anon_quote_exec,
    has_function_privilege('authenticated','public.p43_quote_checkout(uuid,jsonb,jsonb,text)','EXECUTE') as auth_quote_exec,
    has_function_privilege('anon','public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text)','EXECUTE') as anon_commit_exec,
    has_function_privilege('authenticated','public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text)','EXECUTE') as auth_commit_exec,
    coalesce((select not p.prosecdef and p.proconfig @> array['search_path=']::text[]
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='p43_get_routing_config'),false)
    and coalesce((select not p.prosecdef and p.proconfig @> array['search_path=']::text[]
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='p43_quote_checkout'),false)
    and coalesce((select not p.prosecdef and p.proconfig @> array['search_path=']::text[]
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname='p43_commit_checkout'),false)
      as public_rpcs_invoker_fixed_path,
    coalesce((select (public.p43_get_routing_config()->>'freeKmThreshold')::numeric = dc.free_km_threshold
              from dagoldol_private.delivery_config dc where dc.id=true),false) as routing_threshold_matches,
    not exists (
      select 1 from pg_extension where extname in ('dblink','pg_cron','pg_net')
    ) as test_extensions_removed
), final as (
  select *,
    orders_delivery_quote_ok and delivery_config_ok and delivery_free_zones_ok and checkout_requests_ok
    and idempotency_uuid_ok and fingerprint_column_ok and order_fk_index_ok
    and checkout_requests_rls and delivery_config_rls and delivery_zones_rls
    and config_hash_ok and normalize_request_ok and request_fingerprint_ok and resolver_ok
    and routing_config_rpc_ok and quote_rpc_ok and commit_rpc_ok
    and service_routing_exec and service_quote_exec and service_commit_exec
    and not anon_routing_exec and not auth_routing_exec
    and not anon_quote_exec and not auth_quote_exec
    and not anon_commit_exec and not auth_commit_exec
    and public_rpcs_invoker_fixed_path and routing_threshold_matches and test_extensions_removed
      as all_ok
  from checks
)
select case when all_ok then 'PASS' else 'FAIL' end as phase43_contract_status, * from final;
