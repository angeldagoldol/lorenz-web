-- DAGOLDOL PHASE 4.3 authenticated checkout fixture cleanup.
-- STAGING ONLY: approved Supabase project ref genlmsbvcwzlgjpdeqdl.
--
-- READY TO PASTE for staging project genlmsbvcwzlgjpdeqdl.
-- User A: angelmclorenzdagoldol@gmail.com
-- User B: lorenzdagoldol@gmail.com
--
-- Run this complete script after either a successful or failed test run.
-- It preserves auth.users so the two disposable Auth users can be deleted
-- afterward through Supabase Dashboard -> Authentication -> Users.

begin;

do $phase43_cleanup_preflight$
declare
  v_expected_project_ref constant text := 'genlmsbvcwzlgjpdeqdl';
  v_confirmed_project_ref constant text := 'genlmsbvcwzlgjpdeqdl';
  v_user_a_email constant text := 'angelmclorenzdagoldol@gmail.com';
  v_user_b_email constant text := 'lorenzdagoldol@gmail.com';
begin
  if v_confirmed_project_ref is distinct from v_expected_project_ref then
    raise exception
      'Cleanup production-safety guard: project-ref confirmation must equal %; aborting.',
      v_expected_project_ref;
  end if;

  if v_user_a_email = ('REPLACE_' || 'USER_A_EMAIL')
     or v_user_b_email = ('REPLACE_' || 'USER_B_EMAIL')
     or v_user_a_email like 'REPLACE\_%' escape '\'
     or v_user_b_email like 'REPLACE\_%' escape '\' then
    raise exception
      'Cleanup production-safety guard: replace both disposable staging user email placeholders.';
  end if;

  if lower(trim(v_user_a_email)) = lower(trim(v_user_b_email)) then
    raise exception
      'Cleanup production-safety guard: disposable staging user emails must be distinct.';
  end if;

  if to_regclass('public.profiles') is null
     or to_regclass('public.products') is null
     or to_regclass('public.orders') is null
     or to_regclass('dagoldol_private.checkout_requests') is null then
    raise exception
      'Cleanup verification failed: one or more required Phase 4.3 tables are missing.';
  end if;
end
$phase43_cleanup_preflight$;

-- Keep fixture provenance and dependent rows stable while cleanup validates
-- and removes them. No Auth row is modified by this transaction.
lock table public.profiles in share mode;
lock table public.products in share mode;
lock table public.orders in share mode;
lock table dagoldol_private.checkout_requests in share mode;

do $phase43_cleanup$
declare
  v_user_a_email constant text := 'angelmclorenzdagoldol@gmail.com';
  v_user_b_email constant text := 'lorenzdagoldol@gmail.com';
  v_user_a_id uuid;
  v_user_b_id uuid;
  v_fixture_user_ids uuid[];
  v_fixture_order_ids text[] := array[]::text[];
  v_has_artifacts boolean := false;
begin
  if (select count(*) from auth.users u
      where lower(trim(u.email)) = lower(trim(v_user_a_email))) <> 1 then
    raise exception
      'Cleanup verification failed: disposable staging user A is missing or duplicated in Auth.';
  end if;

  if (select count(*) from auth.users u
      where lower(trim(u.email)) = lower(trim(v_user_b_email))) <> 1 then
    raise exception
      'Cleanup verification failed: disposable staging user B is missing or duplicated in Auth.';
  end if;

  select u.id into strict v_user_a_id
  from auth.users u
  where lower(trim(u.email)) = lower(trim(v_user_a_email))
  for key share;

  select u.id into strict v_user_b_id
  from auth.users u
  where lower(trim(u.email)) = lower(trim(v_user_b_email))
  for key share;

  if v_user_a_id = v_user_b_id then
    raise exception
      'Cleanup verification failed: disposable staging users resolved to the same Auth user.';
  end if;

  v_fixture_user_ids := array[v_user_a_id, v_user_b_id];

  select (
    exists (
      select 1 from public.profiles p
      where p.id = any(v_fixture_user_ids)
         or p.username in ('p43_edge_user_a', 'p43_edge_user_b')
    )
    or exists (
      select 1 from public.products p
      where p.id in (
        'p43-edge-normal-product',
        'p43-edge-final-stock-product',
        'p43-edge-idempotency-product'
      )
    )
    or exists (
      select 1 from public.orders o
      where o.user_id = any(v_fixture_user_ids)
    )
    or exists (
      select 1 from dagoldol_private.checkout_requests cr
      where cr.user_id = any(v_fixture_user_ids)
    )
  ) into v_has_artifacts;

  -- A failed setup transaction leaves no artifacts. Treat that state, and a
  -- repeated cleanup, as a safe no-op while still proving the Auth identities.
  if not v_has_artifacts then
    return;
  end if;

  -- Fixture provenance: both reserved usernames must belong to the exact Auth
  -- IDs supplied by email, and those IDs must have no other profile identity.
  if (select count(*)
      from public.profiles p
      where p.id = any(v_fixture_user_ids)
         or p.username in ('p43_edge_user_a', 'p43_edge_user_b')) <> 2
     or (select count(*)
         from public.profiles p
         where (p.id = v_user_a_id
                and p.username = 'p43_edge_user_a'
                and p.role = 'customer')
            or (p.id = v_user_b_id
                and p.username = 'p43_edge_user_b'
                and p.role = 'customer')) <> 2 then
    raise exception
      'Cleanup fixture provenance failed: profile IDs, usernames, or roles are not exact.';
  end if;

  -- Stock may be 1 before a test or 0 after its single successful checkout;
  -- every other product field must still match the deterministic fixture.
  if (select count(*)
      from public.products p
      where p.id in (
        'p43-edge-normal-product',
        'p43-edge-final-stock-product',
        'p43-edge-idempotency-product'
      )) <> 3
     or (select count(*)
         from public.products p
         where p.id in (
           'p43-edge-normal-product',
           'p43-edge-final-stock-product',
           'p43-edge-idempotency-product'
         )
           and p.name = case p.id
             when 'p43-edge-normal-product' then 'P43 Edge Normal Product'
             when 'p43-edge-final-stock-product' then 'P43 Edge Final Stock Product'
             when 'p43-edge-idempotency-product' then 'P43 Edge Idempotency Product'
           end
           and p.description = 'Disposable Phase 4.3 authenticated staging fixture'
           and p.unit_type = 'feet'
           and jsonb_typeof(p.sizes) = 'array'
           and jsonb_array_length(p.sizes) = 1
           and p.sizes->0->>'feet' = '10'
           and (p.sizes->0->>'price')::numeric = 100
           and (p.sizes->0->>'stock')::numeric in (0, 1)) <> 3 then
    raise exception
      'Cleanup fixture provenance failed: deterministic products are missing or altered.';
  end if;

  select coalesce(array_agg(o.id order by o.id), array[]::text[])
  into v_fixture_order_ids
  from public.orders o
  where o.user_id = any(v_fixture_user_ids);

  -- FK-safe cleanup order: the ledger has an ON DELETE RESTRICT order_id FK
  -- and a user_id FK to profiles, so ledger rows must be removed first.
  delete from dagoldol_private.checkout_requests cr
  where cr.user_id = any(v_fixture_user_ids)
     or cr.order_id = any(v_fixture_order_ids);

  delete from public.orders o
  where o.user_id = any(v_fixture_user_ids);

  delete from public.products p
  where p.id in (
    'p43-edge-normal-product',
    'p43-edge-final-stock-product',
    'p43-edge-idempotency-product'
  );

  delete from public.profiles p
  where p.id = any(v_fixture_user_ids);

  if exists (
       select 1
       from dagoldol_private.checkout_requests cr
       where cr.user_id = any(v_fixture_user_ids)
          or cr.order_id = any(v_fixture_order_ids)
     )
     or exists (
       select 1
       from public.orders o
       where o.user_id = any(v_fixture_user_ids)
     )
     or exists (
       select 1
       from public.products p
       where p.id in (
         'p43-edge-normal-product',
         'p43-edge-final-stock-product',
         'p43-edge-idempotency-product'
       )
     )
     or exists (
       select 1
       from public.profiles p
       where p.id = any(v_fixture_user_ids)
          or p.username in ('p43_edge_user_a', 'p43_edge_user_b')
     ) then
    raise exception
      'Cleanup verification failed: fixture ledger, orders, products, or profiles remain.';
  end if;
end
$phase43_cleanup$;

commit;

select
  'PASS'::text as phase43_authenticated_staging_cleanup_status,
  'genlmsbvcwzlgjpdeqdl'::text as staging_project_ref,
  'fixture ledger, orders, products, and profiles absent; auth users preserved'::text
    as cleanup_summary;