-- DAGOLDOL PHASE 4.3 authenticated checkout fixture setup.
-- STAGING ONLY: approved Supabase project ref genlmsbvcwzlgjpdeqdl.
--
-- READY TO PASTE for staging project genlmsbvcwzlgjpdeqdl.
-- User A: angelmclorenzdagoldol@gmail.com
-- User B: lorenzdagoldol@gmail.com
--
-- This script never writes auth.users. Create and confirm both disposable
-- users through Authentication -> Users before running it.

begin;

do $phase43_preflight$
declare
  v_expected_project_ref constant text := 'genlmsbvcwzlgjpdeqdl';
  v_confirmed_project_ref constant text := 'genlmsbvcwzlgjpdeqdl';
  v_user_a_email constant text := 'angelmclorenzdagoldol@gmail.com';
  v_user_b_email constant text := 'lorenzdagoldol@gmail.com';
begin
  -- Production-safety guard: require an operator-entered staging project ref.
  if v_confirmed_project_ref is distinct from v_expected_project_ref then
    raise exception
      'Production-safety guard: project-ref confirmation must equal %; aborting.',
      v_expected_project_ref;
  end if;

  if v_user_a_email = ('REPLACE_' || 'USER_A_EMAIL')
     or v_user_b_email = ('REPLACE_' || 'USER_B_EMAIL')
     or v_user_a_email like 'REPLACE\_%' escape '\'
     or v_user_b_email like 'REPLACE\_%' escape '\' then
    raise exception
      'Production-safety guard: replace both disposable staging user email placeholders.';
  end if;

  if lower(trim(v_user_a_email)) = lower(trim(v_user_b_email)) then
    raise exception
      'Production-safety guard: disposable staging user emails must be distinct.';
  end if;

  if to_regclass('public.profiles') is null
     or to_regclass('public.products') is null
     or to_regclass('public.orders') is null
     or to_regclass('public.bundles') is null
     or to_regclass('public.promo_codes') is null
     or to_regclass('public.flash_sales') is null
     or to_regclass('public.settings') is null
     or to_regclass('dagoldol_private.checkout_requests') is null
     or to_regclass('dagoldol_private.delivery_config') is null
     or to_regclass('dagoldol_private.delivery_free_zones') is null then
    raise exception
      'Phase 4.3 preflight failed: one or more required tables are missing.';
  end if;

  if to_regprocedure('public.p43_get_routing_config()') is null
     or to_regprocedure('public.p43_quote_checkout(uuid,jsonb,jsonb,text)') is null
     or to_regprocedure('public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text)') is null
     or to_regprocedure('dagoldol_private.p43_delivery_config_hash()') is null
     or to_regprocedure('dagoldol_private.p43_request_fingerprint(jsonb)') is null
     or to_regprocedure('dagoldol_private.p43_normalize_request(jsonb,boolean)') is null
     or to_regprocedure('dagoldol_private.p43_resolve_checkout(uuid,jsonb,jsonb,text,boolean)') is null
     or to_regprocedure('dagoldol_private.apply_stock_lines(jsonb,integer)') is null then
    raise exception
      'Phase 4.3 preflight failed: one or more required functions are missing.';
  end if;
end
$phase43_preflight$;

-- Hold the guarded datasets stable from the emptiness check through fixture
-- creation. These locks block concurrent business-data writes during setup.
lock table public.profiles in share mode;
lock table public.products in share mode;
lock table public.orders in share mode;
lock table public.bundles in share mode;
lock table public.promo_codes in share mode;
lock table public.flash_sales in share mode;
lock table dagoldol_private.checkout_requests in share mode;

do $phase43_guard$
declare
  v_user_a_email constant text := 'angelmclorenzdagoldol@gmail.com';
  v_user_b_email constant text := 'lorenzdagoldol@gmail.com';
  v_user_a_id uuid;
  v_user_b_id uuid;
  v_routing_config jsonb;
begin
  -- Production-safety guard: staging must contain no business data before
  -- deterministic fixtures are installed. Do not weaken or bypass this gate.
  if exists (select 1 from public.profiles)
     or exists (select 1 from public.products)
     or exists (select 1 from public.orders)
     or exists (select 1 from public.bundles)
     or exists (select 1 from public.promo_codes)
     or exists (select 1 from public.flash_sales)
     or exists (select 1 from dagoldol_private.checkout_requests) then
    raise exception
      'Production-safety guard: profile or business data already exists; verify the empty staging project and abort.';
  end if;

  if (select count(*) from auth.users u
      where lower(trim(u.email)) = lower(trim(v_user_a_email))) <> 1 then
    raise exception
      'Disposable staging user A is missing or duplicated in Auth.';
  end if;

  if (select count(*) from auth.users u
      where lower(trim(u.email)) = lower(trim(v_user_b_email))) <> 1 then
    raise exception
      'Disposable staging user B is missing or duplicated in Auth.';
  end if;

  select u.id into strict v_user_a_id
  from auth.users u
  where lower(trim(u.email)) = lower(trim(v_user_a_email));

  select u.id into strict v_user_b_id
  from auth.users u
  where lower(trim(u.email)) = lower(trim(v_user_b_email));

  if v_user_a_id = v_user_b_id then
    raise exception
      'Disposable staging users must resolve to distinct Auth user IDs.';
  end if;

  if exists (
    select 1
    from auth.users u
    where u.id in (v_user_a_id, v_user_b_id)
      and u.confirmed_at is null
  ) then
    raise exception
      'Both disposable staging Auth users must be confirmed before fixture setup.';
  end if;

  if not exists (
       select 1 from dagoldol_private.delivery_config dc where dc.id = true
     )
     or not exists (
       select 1 from dagoldol_private.delivery_free_zones z where z.active = true
     )
     or not exists (
       select 1 from public.settings s where s.key = 'delivery_origin_latitude'
     )
     or not exists (
       select 1 from public.settings s where s.key = 'delivery_origin_longitude'
     ) then
    raise exception
      'Phase 4.3 preflight failed: routing or delivery configuration is incomplete.';
  end if;

  begin
    v_routing_config := public.p43_get_routing_config();
  exception when others then
    raise exception
      'Phase 4.3 preflight failed: routing configuration is invalid (%).', sqlerrm;
  end;

  if jsonb_typeof(v_routing_config) <> 'object'
     or nullif(v_routing_config->>'configHash', '') is null then
    raise exception
      'Phase 4.3 preflight failed: routing configuration hash is unavailable.';
  end if;
end
$phase43_guard$;

insert into public.profiles (id, username, role)
select u.id, fixture.username, 'customer'
from (
  values
    ('angelmclorenzdagoldol@gmail.com'::text, 'p43_edge_user_a'::text),
    ('lorenzdagoldol@gmail.com'::text, 'p43_edge_user_b'::text)
) as fixture(email, username)
join auth.users u
  on lower(trim(u.email)) = lower(trim(fixture.email));

insert into public.products (id, name, description, sizes, unit_type)
values
  (
    'p43-edge-normal-product',
    'P43 Edge Normal Product',
    'Disposable Phase 4.3 authenticated staging fixture',
    '[{"feet":"10","price":100,"stock":1}]'::jsonb,
    'feet'
  ),
  (
    'p43-edge-final-stock-product',
    'P43 Edge Final Stock Product',
    'Disposable Phase 4.3 authenticated staging fixture',
    '[{"feet":"10","price":100,"stock":1}]'::jsonb,
    'feet'
  ),
  (
    'p43-edge-idempotency-product',
    'P43 Edge Idempotency Product',
    'Disposable Phase 4.3 authenticated staging fixture',
    '[{"feet":"10","price":100,"stock":1}]'::jsonb,
    'feet'
  );

do $phase43_verify$
declare
  v_user_a_email constant text := 'angelmclorenzdagoldol@gmail.com';
  v_user_b_email constant text := 'lorenzdagoldol@gmail.com';
begin
  if (select count(*)
      from public.profiles p
      join auth.users u on u.id = p.id
      where (p.username = 'p43_edge_user_a'
             and lower(trim(u.email)) = lower(trim(v_user_a_email))
             and p.role = 'customer')
         or (p.username = 'p43_edge_user_b'
             and lower(trim(u.email)) = lower(trim(v_user_b_email))
             and p.role = 'customer')) <> 2 then
    raise exception
      'Phase 4.3 fixture verification failed: disposable customer profiles are not exact.';
  end if;

  if (select count(*)
      from public.products p
      where p.id in (
        'p43-edge-normal-product',
        'p43-edge-final-stock-product',
        'p43-edge-idempotency-product'
      )
        and p.unit_type = 'feet'
        and jsonb_typeof(p.sizes) = 'array'
        and jsonb_array_length(p.sizes) = 1
        and p.sizes->0->>'feet' = '10'
        and (p.sizes->0->>'price')::numeric = 100
        and (p.sizes->0->>'stock')::numeric = 1) <> 3 then
    raise exception
      'Phase 4.3 fixture verification failed: deterministic products are not exact.';
  end if;
end
$phase43_verify$;

commit;

select
  'PASS'::text as phase43_authenticated_staging_setup_status,
  'genlmsbvcwzlgjpdeqdl'::text as staging_project_ref,
  array['p43_edge_user_a', 'p43_edge_user_b']::text[] as fixture_usernames,
  array[
    'p43-edge-normal-product',
    'p43-edge-final-stock-product',
    'p43-edge-idempotency-product'
  ]::text[] as fixture_product_ids,
  'variant=10; canonical_price=100; initial_stock=1_each'::text as fixture_summary;