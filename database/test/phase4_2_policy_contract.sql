-- ============================================================================
-- DAGOLDOL PHASE 4.2A — STRUCTURAL AUTHORIZATION CONTRACT TEST
-- READ ONLY. Run after 20260820_phase4_2a_zero_trust_rls_private_data.sql on
-- staging. It intentionally reports the still-open Phase 4.2B checkout gate.
-- ============================================================================

do $$
declare
  v_bad text;
  v_count integer;
begin
  -- Every audited public-table policy must be from the Phase 4.2 canonical set.
  select string_agg(format('%s:%s',tablename,policyname), ', ' order by tablename,policyname)
    into v_bad
  from pg_policies
  where schemaname='public'
    and tablename = any(array[
      'activity','brands','bundles','chat_messages','chat_threads',
      'dm_messages','dm_threads','flash_sales','gift_card_transactions',
      'gift_cards','messages','orders','products','profiles','promo_codes',
      'ratings','settings','subscription_orders','subscriptions'
    ])
    and policyname not like 'p42\_%' escape '\';

  if v_bad is not null then
    raise exception 'FAIL: non-canonical public policies remain: %', v_bad;
  end if;

  -- Profiles must not have a broad authenticated all-row SELECT policy.
  select count(*) into v_count
  from pg_policies
  where schemaname='public' and tablename='profiles' and cmd='SELECT';
  if v_count <> 1 then
    raise exception 'FAIL: expected exactly one canonical profiles SELECT policy, found %', v_count;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='profiles'
      and policyname='p42_profiles_select_owner_or_admin'
      and cmd='SELECT'
      and coalesce(qual,'') ilike '%auth.uid()%'
      and coalesce(qual,'') ilike '%is_admin()%'
  ) then
    raise exception 'FAIL: owner/admin profiles SELECT policy is missing or malformed.';
  end if;

  -- Storefront-management tables must have public/authenticated reads only
  -- where intended and admin-gated writes.
  foreach v_bad in array array['products','brands','bundles','flash_sales','settings']
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname='public' and tablename=v_bad
        and policyname like 'p42\_%admin_write' escape '\'
        and cmd='ALL'
        and coalesce(qual,'') ilike '%is_admin()%'
        and coalesce(with_check,'') ilike '%is_admin()%'
    ) then
      raise exception 'FAIL: % lacks canonical admin-write policy.', v_bad;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='promo_codes'
      and policyname='p42_promo_codes_admin_write'
      and cmd='ALL'
  ) then
    raise exception 'FAIL: promo_codes admin-write policy missing.';
  end if;

  -- Ratings must have exactly one customer INSERT route and it must bind owner,
  -- order, delivery status and product membership.
  select count(*) into v_count
  from pg_policies
  where schemaname='public' and tablename='ratings' and cmd='INSERT';
  if v_count <> 1 then
    raise exception 'FAIL: expected exactly one ratings INSERT policy, found %', v_count;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='ratings'
      and policyname='p42_ratings_insert_purchased_delivered'
      and coalesce(with_check,'') ilike '%auth.uid()%user_id%'
      and coalesce(with_check,'') ilike '%order_id%'
      and coalesce(with_check,'') ilike '%status_override%'
      and coalesce(with_check,'') ilike '%productId%'
  ) then
    raise exception 'FAIL: purchase-bound ratings INSERT policy is missing or incomplete.';
  end if;

  -- Private payment proof Storage must have no anonymous storage.objects SELECT.
  if exists (
    select 1 from storage.buckets where id='payment-proofs' and public
  ) then
    raise exception 'FAIL: payment-proofs bucket is public.';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and cmd='SELECT' and roles @> array['anon']::name[]
  ) then
    raise exception 'FAIL: anonymous storage.objects SELECT policy exists.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='p42_storage_payment_proof_owner_admin_read'
      and cmd='SELECT'
      and coalesce(qual,'') ilike '%payment-proofs%'
      and coalesce(qual,'') ilike '%auth.uid()%'
      and coalesce(qual,'') ilike '%is_admin()%'
  ) then
    raise exception 'FAIL: owner/admin payment proof read policy is missing.';
  end if;

  -- Safe directory APIs: authenticated only.
  if has_function_privilege('anon','public.p42_lookup_profile_directory(text)','EXECUTE')
     or not has_function_privilege('authenticated','public.p42_lookup_profile_directory(text)','EXECUTE') then
    raise exception 'FAIL: profile directory RPC execution grants are incorrect.';
  end if;

  if has_function_privilege('anon','public.p42_get_seller_directory_profile()','EXECUTE')
     or not has_function_privilege('authenticated','public.p42_get_seller_directory_profile()','EXECUTE') then
    raise exception 'FAIL: seller directory RPC execution grants are incorrect.';
  end if;

  -- Anonymous stock mutation must be closed immediately in 4.2A.
  if has_function_privilege('anon','public.decrement_stock_for_order(jsonb)','EXECUTE')
     or has_function_privilege('anon','public.restore_stock_for_order(jsonb)','EXECUTE') then
    raise exception 'FAIL: anonymous stock helper execution remains.';
  end if;

  -- Monetary/stale subscription functions must not be browser-callable.
  if has_function_privilege('authenticated','public.purchase_gift_card(numeric,uuid,text,text,text,text,text,timestamp with time zone)','EXECUTE')
     or has_function_privilege('authenticated','public.redeem_gift_card(text,uuid,numeric)','EXECUTE')
     or has_function_privilege('authenticated','public.refund_gift_card(uuid,uuid,numeric)','EXECUTE')
     or has_function_privilege('authenticated','public.process_subscription(uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.process_due_subscriptions()','EXECUTE') then
    raise exception 'FAIL: browser execution remains on gift-card/subscription mutation functions.';
  end if;

  -- DM integrity triggers must be installed.
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.dm_threads'::regclass and tgname='p42_dm_thread_guard' and not tgisinternal
  ) then
    raise exception 'FAIL: p42_dm_thread_guard trigger missing.';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.dm_messages'::regclass and tgname='p42_dm_message_guard' and not tgisinternal
  ) then
    raise exception 'FAIL: p42_dm_message_guard trigger missing.';
  end if;
end
$$;

-- This row is intentionally expected to be TRUE after 4.2A. It keeps the open
-- P0 visible instead of pretending the complete Phase 4.2 exit gate has passed.
select
  has_function_privilege('authenticated','public.decrement_stock_for_order(jsonb)','EXECUTE') as phase42b_stock_decrement_still_browser_callable,
  has_function_privilege('authenticated','public.restore_stock_for_order(jsonb)','EXECUTE') as phase42b_stock_restore_still_browser_callable,
  exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='orders'
      and policyname='p42_orders_insert_owner_compat_phase42a'
      and cmd='INSERT'
  ) as phase42b_direct_order_insert_still_enabled;

-- PASS for Phase 4.2A requires the DO block to complete without exception.
-- Full Phase 4.2 closure additionally requires all three Phase 4.2B values above
-- to become FALSE after the exact 3.3.5 checkout/cancellation cutover.
