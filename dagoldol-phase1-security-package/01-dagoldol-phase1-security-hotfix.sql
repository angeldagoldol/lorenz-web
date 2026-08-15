-- ============================================================================
-- DAGOLDOL — PHASE 1 SOURCE-GROUNDED SECURITY HOTFIX
-- File: 01-dagoldol-phase1-security-hotfix.sql
--
-- SQL STATUS:
--   SOURCE-GROUNDED HOTFIX — LOGICALLY REVIEWED, NOT EXECUTED AGAINST YOUR DB.
--
-- SCOPE:
--   This file intentionally changes ONLY objects that are present in the
--   supplied Supabase schema and whose behavior is also traceable in the
--   supplied/current script.js:
--     * public.profiles
--     * public.orders
--     * public.is_admin()
--
-- WHAT THIS FIXES NOW:
--   1. Prevents a normal authenticated customer from changing profiles.role.
--   2. Forces client-created profiles to role='customer'.
--   3. Hardens public.is_admin() with an explicit empty search_path.
--   4. Prevents a customer from modifying arbitrary columns on an existing
--      order. Only the two customer-side mutations used by the current UI are
--      permitted: cancelled and rated.
--   5. Makes customer cancellation one-way and enforces the same cancellable
--      window used by current script.js (status step < 2).
--   6. Prevents a customer from adding/changing ratings inside orders.rated
--      before delivery, on cancelled orders, for products not present as a
--      normal line item, or outside the 1..5 range.
--   7. On customer order INSERT, forces user_id ownership, server placed_at,
--      canonical username from public.profiles, status_override=NULL,
--      cancelled=false, and rated={}. This does NOT yet recompute prices.
--
-- WHAT THIS DOES NOT FIX:
--   * Client-authoritative subtotal/total/delivery/bulk/promo/payment amounts.
--   * Atomic stock decrement + order insert + promo consumption.
--   * Atomic cancellation + stock restoration.
--   * ratings table ownership / purchase binding.
--   * storage bucket privacy and storage.objects RLS.
--   * RLS for bundles, brands, flash_sales, promo_codes, settings, dm_threads,
--     dm_messages, or other modern tables absent from the supplied schema.
--
-- IMPORTANT:
--   Back up your database and inspect the companion audit/export files before
--   running this against production. This transaction is idempotent with
--   respect to the trigger/function names defined here.
-- ============================================================================

begin;

-- ============================================================================
-- 1. VERIFIED POLICY SUPPORT — harden the existing admin helper
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'Dagoldol admin authorization helper. Reads public.profiles.role for auth.uid(); SECURITY DEFINER with fixed search_path.';

-- ============================================================================
-- 2. VERIFIED SECURITY FIX — make customer role immutable at DB boundary
-- ============================================================================

create or replace function public.guard_profile_role_client()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();

  -- SQL Editor / migrations / trusted server operations normally have no
  -- end-user auth.uid(); leave those operations untouched so an administrator
  -- can still bootstrap/promote the first admin through trusted SQL.
  if v_uid is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- A browser/API signup can never choose its own privilege level.
    new.role := 'customer';
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.role is distinct from old.role
     and not public.is_admin() then
    raise exception 'profile role cannot be changed by a customer session'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_role_client on public.profiles;

create trigger profiles_guard_role_client
before insert or update
on public.profiles
for each row
execute function public.guard_profile_role_client();

comment on function public.guard_profile_role_client() is
  'For authenticated client sessions: force new profiles to customer and prevent non-admin role changes.';

-- ============================================================================
-- 3. VERIFIED SECURITY FIX — constrain customer order writes
--
-- The current RLS policy grants an order owner UPDATE authority over the row.
-- The current UI legitimately uses UPDATE for:
--   * cancelled: false -> true
--   * rated: adding productId -> 1..5 after delivery
--
-- The generic to_jsonb(NEW)/to_jsonb(OLD) comparison below deliberately avoids
-- naming the modern order columns that are visible in script.js but missing
-- from the supplied schema export. Therefore any present/future column other
-- than cancelled/rated remains immutable to a non-admin customer update.
-- ============================================================================

create or replace function public.guard_customer_order_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid;
  v_now_ms bigint;
  v_profile_username text;
  v_key text;
  v_value jsonb;
  v_cancel_cutoff_ms numeric;
begin
  v_uid := auth.uid();

  -- Trusted SQL/service operations with no end-user uid are outside this
  -- browser-client guard. Existing RLS/service-role behavior remains intact.
  if v_uid is null then
    return new;
  end if;

  -- Admin behavior is preserved: current admin UI updates status_override and
  -- may perform other management actions. RLS remains authoritative as well.
  if public.is_admin() then
    return new;
  end if;

  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;

  if tg_op = 'INSERT' then
    if new.user_id is distinct from v_uid then
      raise exception 'order user_id must match the authenticated user'
        using errcode = '42501';
    end if;

    select p.username
      into v_profile_username
      from public.profiles as p
     where p.id = v_uid;

    if v_profile_username is null then
      raise exception 'authenticated user has no Dagoldol profile'
        using errcode = '23503';
    end if;

    -- These are workflow/security-owned fields. The current frontend already
    -- submits equivalent initial values, so normal behavior is preserved.
    if jsonb_typeof(new.items) <> 'array' then
      raise exception 'orders.items must be a JSON array'
        using errcode = '22023';
    end if;

    -- Current script.js generates delivery_days as 3 + floor(random * 4),
    -- therefore the only source-backed customer values are 3, 4, 5, or 6.
    -- Validate rather than regenerate it so the ETA shown by the current UI
    -- remains identical to the row it just submitted.
    if new.delivery_days < 3 or new.delivery_days > 6 then
      raise exception 'delivery_days must be between 3 and 6 for customer orders'
        using errcode = '22023';
    end if;

    new.user_id := v_uid;
    new.username := v_profile_username;
    new.placed_at := v_now_ms;
    new.status_override := null;
    new.cancelled := false;
    new.rated := '{}'::jsonb;

    return new;
  end if;

  -- On customer UPDATE, every column except cancelled and rated is immutable.
  -- This automatically protects modern columns not present in the old schema
  -- export (for example promo/payment fields) without inventing their names.
  if (to_jsonb(new) - 'cancelled' - 'rated')
       is distinct from
     (to_jsonb(old) - 'cancelled' - 'rated') then
    raise exception 'customers may not modify protected order fields'
      using errcode = '42501';
  end if;

  -- ------------------------------
  -- Cancellation integrity
  -- ------------------------------

  if new.cancelled is distinct from old.cancelled then
    if old.cancelled = true and new.cancelled = false then
      raise exception 'a cancelled order cannot be reopened by the customer'
        using errcode = '42501';
    end if;

    if new.cancelled = true then
      -- Mirrors current script.js:
      -- isOrderCancellable(order) => getOrderStatus(order).stepIndex < 2
      -- With status_override: step is exactly status_override.
      -- Without override: Shipped (step 2) begins at 45% of delivery window.
      if old.status_override is not null then
        if old.status_override >= 2 then
          raise exception 'order can no longer be cancelled at its current status'
            using errcode = '42501';
        end if;
      else
        v_cancel_cutoff_ms :=
          old.placed_at::numeric
          + (old.delivery_days::numeric * 86400000::numeric * 0.45::numeric);

        if v_now_ms::numeric >= v_cancel_cutoff_ms then
          raise exception 'order can no longer be cancelled after shipping has begun'
            using errcode = '42501';
        end if;
      end if;
    end if;
  end if;

  -- ------------------------------
  -- Per-order rating state integrity
  -- ------------------------------

  if new.rated is distinct from old.rated then
    if old.cancelled then
      raise exception 'cancelled orders cannot be rated'
        using errcode = '42501';
    end if;

    -- Current UI only exposes rating after Delivered.
    if not (
      coalesce(old.status_override = 4, false)
      or (
        old.status_override is null
        and v_now_ms >= (
          old.placed_at
          + (old.delivery_days::bigint * 86400000::bigint)
        )
      )
    ) then
      raise exception 'order cannot be rated before delivery'
        using errcode = '42501';
    end if;

    if jsonb_typeof(new.rated) <> 'object' then
      raise exception 'orders.rated must be a JSON object'
        using errcode = '22023';
    end if;

    -- Existing ratings are append-only from the customer perspective.
    if not (new.rated @> old.rated) then
      raise exception 'existing order ratings cannot be changed or removed'
        using errcode = '42501';
    end if;

    for v_key, v_value in
      select e.key, e.value
      from jsonb_each(new.rated) as e(key, value)
    loop
      if jsonb_typeof(v_value) <> 'number'
         or (v_value #>> '{}') !~ '^[1-5]$' then
        raise exception 'rating for product % must be an integer from 1 to 5', v_key
          using errcode = '22023';
      end if;

      -- Current script.js deliberately renders ratings only for non-bundle
      -- order lines and uses item.productId as the product identifier.
      if not exists (
        select 1
        from jsonb_array_elements(old.items) as item
        where coalesce(item ->> 'isBundle', 'false') <> 'true'
          and item ->> 'productId' = v_key
      ) then
        raise exception 'product % is not a rateable item in this order', v_key
          using errcode = '42501';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_guard_customer_write on public.orders;

create trigger orders_guard_customer_write
before insert or update
on public.orders
for each row
execute function public.guard_customer_order_write();

comment on function public.guard_customer_order_write() is
  'Dagoldol client-write guard: protects order columns, cancellation state, and per-order rating state for non-admin authenticated users.';

commit;

-- ============================================================================
-- POST-DEPLOY VALIDATION (manual; run through your normal Supabase client)
-- ============================================================================
-- 1. Customer profile update: name/address/profile/cart should still work.
-- 2. Customer direct update role='admin': MUST fail.
-- 3. New signup attempting role='admin': persisted role MUST be customer.
-- 4. Customer direct order UPDATE total/subtotal/items/status_override/etc:
--    MUST fail.
-- 5. Customer cancellation before step 2: SHOULD succeed.
-- 6. Customer cancellation at/after step 2: MUST fail.
-- 7. Customer uncancel (true -> false): MUST fail.
-- 8. Rating before delivery / cancelled order / unrelated product / 0 or 6:
--    MUST fail.
-- 9. Current admin status updates MUST continue to work.
--
-- IMPORTANT REMAINING P0:
-- Order INSERT still accepts client-calculated commercial fields. Do not call
-- Phase 1 complete until the current production schema/RPC export is collected
-- with 03-dagoldol-phase1-source-gap-export.sql and checkout is moved into one
-- server-authoritative transaction.
-- ============================================================================
