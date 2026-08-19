-- ============================================================================
-- DAGOLDOL PHASE 4.2B — COMMERCE AUTHORITY COMPATIBILITY HARDENING
-- Version: 2026-08-20
--
-- PURPOSE
--   Move inventory mutation, canonical line pricing, promo consumption,
--   commercial totals, and cancellation stock restoration into PostgreSQL
--   transaction boundaries while preserving the current Dagoldol browser flow.
--
-- IMPORTANT BOUNDARY
--   Delivery route pricing still arrives from the current delivery-map/browser
--   quote. This migration validates it as finite/non-negative and prevents later
--   customer mutation, but does not reproduce OSRM/Nominatim road routing
--   inside PostgreSQL. Full server-authoritative delivery quoting remains a
--   Phase 4.3 checkout-service concern.
--
-- COMPATIBILITY
--   Existing browser calls to decrement_stock_for_order() become read-only
--   availability checks. Existing calls to restore_stock_for_order() become
--   harmless no-ops. Actual stock movement occurs atomically in the order
--   INSERT / cancellation UPDATE trigger.
--
--   The current direct orders INSERT path remains available to the order owner,
--   but all trusted commercial fields are overwritten/canonicalized by the
--   database trigger. This avoids breaking Dagoldol 3.3.5 while making the
--   database—not the browser—the authority for those fields.
--
-- SAFETY
--   No business rows are deleted.
--   Existing orders are not rewritten.
--   All DDL/DCL changes run in one transaction.
-- ============================================================================

begin;

-- --------------------------------------------------------------------------
-- 0. Fail-closed preflight against the verified live Phase 4.2A contract.
-- --------------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  select string_agg(required_name, ', ' order by required_name)
    into v_missing
  from (
    select required_name
    from unnest(array[
      'orders','products','bundles','flash_sales','promo_codes','profiles'
    ]) as r(required_name)
    where to_regclass('public.' || required_name) is null
  ) missing;

  if v_missing is not null then
    raise exception 'Phase 4.2B stopped: required table(s) missing: %', v_missing;
  end if;

  if to_regprocedure('public.is_admin()') is null then
    raise exception 'Phase 4.2B stopped: public.is_admin() is missing.';
  end if;

  if to_regprocedure('public.decrement_stock_for_order(jsonb)') is null
     or to_regprocedure('public.restore_stock_for_order(jsonb)') is null then
    raise exception 'Phase 4.2B stopped: expected stock helper RPC(s) are missing.';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid='public.orders'::regclass
      and tgname='orders_guard_customer_write'
      and not tgisinternal
  ) then
    raise exception 'Phase 4.2B stopped: orders_guard_customer_write trigger is missing.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='orders'
      and policyname='p42_orders_insert_owner_compat_phase42a'
      and cmd='INSERT'
  )
  and not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='orders'
      and policyname='p42_orders_insert_owner'
      and cmd='INSERT'
  ) then
    raise exception 'Phase 4.2B stopped: Phase 4.2A owned-order INSERT policy is missing.';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname='public'
      and tablename in ('orders','products','promo_codes','profiles')
      and policyname not like 'p42\_%' escape '\'
  ) then
    raise exception 'Phase 4.2B stopped: non-canonical public policies reappeared.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='sizes'
  ) then
    raise exception 'Phase 4.2B stopped: products.sizes is missing.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='products' and column_name='stock'
  ) then
    raise exception 'Phase 4.2B stopped: unexpected products.stock column exists; re-audit inventory representation.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 1. Reconcile the order schema with the checkout fields already consumed by
--    current Dagoldol source and the existing place_order() signature.
-- --------------------------------------------------------------------------
alter table public.orders
  add column if not exists payment_reference text,
  add column if not exists payment_proof text,
  add column if not exists half_payment boolean not null default false,
  add column if not exists amount_due_now numeric not null default 0,
  add column if not exists amount_due_later numeric not null default 0;

-- Basic invariant checks. These do not attempt to encode external route pricing.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.orders'::regclass
      and conname='orders_phase42b_nonnegative_money_check'
  ) then
    alter table public.orders
      add constraint orders_phase42b_nonnegative_money_check
      check (
        subtotal >= 0
        and delivery_fee >= 0
        and bulk_fee_rate >= 0
        and bulk_fee_rate <= 1
        and bulk_fee >= 0
        and cod_fee >= 0
        and total >= 0
        and coalesce(promo_discount,0) >= 0
        and amount_due_now >= 0
        and amount_due_later >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.orders'::regclass
      and conname='orders_phase42b_payment_method_check'
  ) then
    alter table public.orders
      add constraint orders_phase42b_payment_method_check
      check (payment_method in ('gcash','bank'));
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 2. Private implementation schema. Nothing here is exposed to anon or normal
--    authenticated browser clients.
-- --------------------------------------------------------------------------
create schema if not exists dagoldol_private authorization postgres;

revoke all on schema dagoldol_private from public;
revoke all on schema dagoldol_private from anon;
revoke all on schema dagoldol_private from authenticated;

-- --------------------------------------------------------------------------
-- 3. Internal stock mutator.
--
--    p_direction = -1 : decrement (checkout)
--    p_direction =  1 : restore   (cancellation)
--
--    Product rows are locked FOR UPDATE so concurrent orders serialize at the
--    inventory row. Any exception rolls back the order/promo/stock transaction.
-- --------------------------------------------------------------------------
create or replace function dagoldol_private.apply_stock_lines(
  p_lines jsonb,
  p_direction integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_input_line jsonb;
  v_line jsonb;
  v_product_id text;
  v_feet text;
  v_qty numeric;
  v_normalized_lines jsonb := '[]'::jsonb;
  v_sizes jsonb;
  v_new_sizes jsonb;
  v_size jsonb;
  v_current_stock numeric;
  v_matched boolean;
  i integer;
begin
  if p_direction not in (-1,1) then
    raise exception 'Invalid stock direction' using errcode='22023';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Stock lines must be a JSON array' using errcode='22023';
  end if;

  -- Validate and normalize before taking row locks. Duplicated product/size
  -- lines are aggregated below, which prevents double bookkeeping and lets us
  -- acquire product locks in deterministic product/size order.
  for v_input_line in
    select value from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_input_line) <> 'object' then
      raise exception 'Each stock line must be a JSON object' using errcode='22023';
    end if;

    v_product_id := nullif(trim(v_input_line->>'productId'),'');
    v_feet := nullif(trim(v_input_line->>'feet'),'');

    begin
      v_qty := nullif(trim(v_input_line->>'qty'),'')::numeric;
    exception
      when invalid_text_representation then
        raise exception 'Invalid stock quantity: %', v_input_line using errcode='22023';
    end;

    if v_product_id is null
       or v_feet is null
       or v_qty is null
       or lower(v_qty::text) in ('nan','infinity','-infinity')
       or v_qty <= 0
       or v_qty <> trunc(v_qty)
       or v_qty > 10000000 then
      raise exception 'Invalid stock line: %', v_input_line using errcode='22023';
    end if;

    v_normalized_lines := v_normalized_lines || jsonb_build_object(
      'productId', v_product_id,
      'feet', v_feet,
      'qty', v_qty
    );
  end loop;

  for v_line in
    select jsonb_build_object(
      'productId', q.product_id,
      'feet', q.feet,
      'qty', sum(q.qty)
    )
    from (
      select
        value->>'productId' as product_id,
        value->>'feet' as feet,
        (value->>'qty')::numeric as qty
      from jsonb_array_elements(v_normalized_lines)
    ) q
    group by q.product_id,q.feet
    order by q.product_id,q.feet
  loop
    v_product_id := v_line->>'productId';
    v_feet := v_line->>'feet';
    v_qty := (v_line->>'qty')::numeric;

    if v_qty > 10000000 then
      raise exception 'Aggregated stock quantity is too large for product % size %',
        v_product_id,v_feet using errcode='22023';
    end if;

    -- Product rows are locked in deterministic product-id order because the
    -- aggregate query above is ordered. Concurrent carts that contain the same
    -- products therefore do not acquire product locks in arbitrary cart order.
    select p.sizes
      into v_sizes
    from public.products p
    where p.id=v_product_id
    for update;

    if not found then
      if p_direction=1 then
        -- A historical product can legitimately have been removed before a
        -- cancellation. There is no inventory row to restore in that case.
        continue;
      end if;
      raise exception 'Product % not found', v_product_id using errcode='23503';
    end if;

    if v_sizes is null or jsonb_typeof(v_sizes) <> 'array' then
      raise exception 'Product % has invalid sizes inventory', v_product_id using errcode='22023';
    end if;

    v_new_sizes := '[]'::jsonb;
    v_matched := false;

    if jsonb_array_length(v_sizes) > 0 then
      for i in 0 .. jsonb_array_length(v_sizes)-1
      loop
        v_size := v_sizes->i;

        if v_size->>'feet'=v_feet then
          v_matched := true;

          if v_size ? 'stock'
             and jsonb_typeof(v_size->'stock') <> 'null' then
            begin
              v_current_stock := (v_size->>'stock')::numeric;
            exception
              when invalid_text_representation then
                raise exception 'Invalid stock value for product % size %', v_product_id, v_feet
                  using errcode='22023';
            end;

            if lower(v_current_stock::text) in ('nan','infinity','-infinity') then
              raise exception 'Non-finite stock detected for product % size %', v_product_id, v_feet
                using errcode='23514';
            end if;

            if v_current_stock < 0 then
              raise exception 'Negative stock detected for product % size %', v_product_id, v_feet
                using errcode='23514';
            end if;

            if p_direction=-1 and v_current_stock < v_qty then
              raise exception
                'Insufficient stock for product % (size %): have %, need %',
                v_product_id, v_feet, v_current_stock, v_qty
                using errcode='23514';
            end if;

            v_size := jsonb_set(
              v_size,
              '{stock}',
              to_jsonb(v_current_stock + (p_direction * v_qty)),
              true
            );
          end if;
        end if;

        v_new_sizes := v_new_sizes || jsonb_build_array(v_size);
      end loop;
    end if;

    if not v_matched then
      if p_direction=1 then
        continue;
      end if;
      raise exception 'Size % not found for product %', v_feet, v_product_id
        using errcode='23503';
    end if;

    update public.products
       set sizes=v_new_sizes
     where id=v_product_id;
  end loop;
end;
$$;

revoke all on function dagoldol_private.apply_stock_lines(jsonb,integer) from public;
revoke all on function dagoldol_private.apply_stock_lines(jsonb,integer) from anon;
revoke all on function dagoldol_private.apply_stock_lines(jsonb,integer) from authenticated;

-- --------------------------------------------------------------------------
-- 4. Internal helper: expand canonical order JSON to stock lines.
-- --------------------------------------------------------------------------
create or replace function dagoldol_private.stock_lines_from_order_items(
  p_items jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_component jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_qty numeric;
  v_component_qty numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Order items must be a JSON array' using errcode='22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_qty := nullif(trim(v_item->>'qty'),'')::numeric;
    if v_qty is null
       or lower(v_qty::text) in ('nan','infinity','-infinity')
       or v_qty <= 0
       or v_qty <> trunc(v_qty) then
      raise exception 'Invalid order item quantity' using errcode='22023';
    end if;

    if coalesce((v_item->>'isBundle')::boolean,false) then
      if jsonb_typeof(coalesce(v_item->'components','[]'::jsonb)) <> 'array' then
        raise exception 'Bundle components must be an array' using errcode='22023';
      end if;

      for v_component in
        select value from jsonb_array_elements(coalesce(v_item->'components','[]'::jsonb))
      loop
        v_component_qty := nullif(trim(v_component->>'qty'),'')::numeric;
        if nullif(trim(v_component->>'productId'),'') is null
           or nullif(trim(v_component->>'feet'),'') is null
           or v_component_qty is null
           or lower(v_component_qty::text) in ('nan','infinity','-infinity')
           or v_component_qty <= 0
           or v_component_qty <> trunc(v_component_qty) then
          raise exception 'Invalid bundle component in saved order' using errcode='22023';
        end if;

        v_lines := v_lines || jsonb_build_object(
          'productId', v_component->>'productId',
          'feet', v_component->'feet',
          'qty', v_component_qty * v_qty
        );
      end loop;
    else
      if nullif(trim(v_item->>'productId'),'') is null
         or nullif(trim(v_item->>'feet'),'') is null then
        raise exception 'Invalid saved product order line' using errcode='22023';
      end if;

      v_lines := v_lines || jsonb_build_object(
        'productId', v_item->>'productId',
        'feet', v_item->'feet',
        'qty', v_qty
      );
    end if;
  end loop;

  return v_lines;
end;
$$;

revoke all on function dagoldol_private.stock_lines_from_order_items(jsonb) from public;
revoke all on function dagoldol_private.stock_lines_from_order_items(jsonb) from anon;
revoke all on function dagoldol_private.stock_lines_from_order_items(jsonb) from authenticated;

-- --------------------------------------------------------------------------
-- 5. Browser compatibility helper: decrement_stock_for_order()
--
--    This RPC no longer mutates inventory for any caller. It performs only a
--    best-effort availability validation. The authoritative lock/decrement is
--    performed by the order trigger in the same transaction as the INSERT.
-- --------------------------------------------------------------------------
create or replace function public.decrement_stock_for_order(p_lines jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_line jsonb;
  v_product_id text;
  v_feet text;
  v_qty numeric;
  v_sizes jsonb;
  v_size jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'p_lines must be a JSON array' using errcode='22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_product_id := nullif(trim(v_line->>'productId'),'');
    v_feet := nullif(trim(v_line->>'feet'),'');
    v_qty := nullif(trim(v_line->>'qty'),'')::numeric;

    if v_product_id is null
       or v_feet is null
       or v_qty is null
       or lower(v_qty::text) in ('nan','infinity','-infinity')
       or v_qty <= 0
       or v_qty <> trunc(v_qty) then
      raise exception 'Invalid order line: %', v_line using errcode='22023';
    end if;

    select p.sizes
      into v_sizes
    from public.products p
    where p.id=v_product_id;

    if not found then
      raise exception 'Product % not found', v_product_id using errcode='23503';
    end if;

    select value
      into v_size
    from jsonb_array_elements(coalesce(v_sizes,'[]'::jsonb))
    where value->>'feet'=v_feet
    limit 1;

    if v_size is null then
      raise exception 'Size % not found for product %', v_feet, v_product_id
        using errcode='23503';
    end if;

    if v_size ? 'stock' and jsonb_typeof(v_size->'stock') <> 'null' then
      begin
        if lower(((v_size->>'stock')::numeric)::text) in ('nan','infinity','-infinity') then
          raise exception 'Invalid stock value for product % size %', v_product_id, v_feet
            using errcode='23514';
        end if;
        if (v_size->>'stock')::numeric < v_qty then
          raise exception
            'Insufficient stock for product % (size %): have %, need %',
            v_product_id, v_feet, (v_size->>'stock')::numeric, v_qty
            using errcode='23514';
        end if;
      exception
        when invalid_text_representation then
          raise exception 'Invalid stock value for product % size %', v_product_id, v_feet
            using errcode='23514';
      end;
    end if;
  end loop;
end;
$$;

revoke all on function public.decrement_stock_for_order(jsonb) from public;
revoke all on function public.decrement_stock_for_order(jsonb) from anon;
revoke all on function public.decrement_stock_for_order(jsonb) from authenticated;
grant execute on function public.decrement_stock_for_order(jsonb) to authenticated, service_role;

comment on function public.decrement_stock_for_order(jsonb) is
'Phase 4.2B browser compatibility validator only. Does not mutate inventory. Actual decrement is atomic in orders_guard_customer_write.';

-- --------------------------------------------------------------------------
-- 6. Browser compatibility helper: restore_stock_for_order()
--
--    Cancellation restoration is now atomic inside the order UPDATE trigger.
--    Keeping this no-op prevents older Dagoldol clients from double-restoring.
-- --------------------------------------------------------------------------
create or replace function public.restore_stock_for_order(p_lines jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'p_lines must be a JSON array' using errcode='22023';
  end if;

  -- Intentionally no mutation. The order cancellation trigger is authoritative.
  return;
end;
$$;

revoke all on function public.restore_stock_for_order(jsonb) from public;
revoke all on function public.restore_stock_for_order(jsonb) from anon;
revoke all on function public.restore_stock_for_order(jsonb) from authenticated;
grant execute on function public.restore_stock_for_order(jsonb) to authenticated, service_role;

comment on function public.restore_stock_for_order(jsonb) is
'Phase 4.2B compatibility no-op. Actual cancellation restoration is atomic in orders_guard_customer_write.';

-- --------------------------------------------------------------------------
-- 7. Canonical customer order write trigger.
--
--    INSERT authority:
--      * canonical authenticated identity
--      * canonical product/bundle identity and price
--      * active flash-sale price
--      * bulk fee
--      * promo validation + atomic usage increment
--      * amount due values
--      * stock decrement under row lock
--
--    UPDATE authority:
--      * protected order fields immutable to customer
--      * cancellation eligibility validated
--      * stock restoration in the SAME transaction as cancellation
--      * order rating-state append-only protection preserved
-- --------------------------------------------------------------------------
create or replace function public.guard_customer_order_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_profile_username text;

  v_item jsonb;
  v_component jsonb;
  v_product record;
  v_bundle record;
  v_size jsonb;
  v_qty numeric;
  v_component_qty numeric;
  v_line_price numeric;
  v_sale_count integer;
  v_sale_discount numeric;

  v_canonical_items jsonb := '[]'::jsonb;
  v_stock_lines jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_total_qty numeric := 0;

  v_bulk_rate numeric := 0;
  v_bulk_fee numeric := 0;

  v_promo record;
  v_promo_discount numeric := 0;

  v_delivery_fee numeric;
  v_total numeric;

  v_cancel_lines jsonb;
  v_cancel_cutoff_ms numeric;

  v_key text;
  v_value jsonb;
begin
  -- Trusted database/service operations without an end-user identity preserve
  -- their existing behavior. Normal Data API customer requests have auth.uid().
  if v_uid is null then
    return new;
  end if;

  -- Verified admins retain explicit management authority.
  if public.is_admin() then
    return new;
  end if;

  if tg_op='INSERT' then
    if new.user_id is distinct from v_uid then
      raise exception 'order user_id must match the authenticated user'
        using errcode='42501';
    end if;

    select p.username
      into v_profile_username
    from public.profiles p
    where p.id=v_uid;

    if v_profile_username is null then
      raise exception 'authenticated user has no Dagoldol profile'
        using errcode='23503';
    end if;

    if new.id is null
       or length(new.id) > 120
       or new.id !~ '^ORD-[A-Za-z0-9-]+$' then
      raise exception 'invalid order id' using errcode='22023';
    end if;

    if new.items is null
       or jsonb_typeof(new.items) <> 'array'
       or jsonb_array_length(new.items)=0 then
      raise exception 'orders.items must be a non-empty JSON array'
        using errcode='22023';
    end if;

    if new.address is null or jsonb_typeof(new.address) <> 'object' then
      raise exception 'orders.address must be a JSON object'
        using errcode='22023';
    end if;

    if length(trim(coalesce(new.address->>'name','')))=0
       or length(trim(coalesce(new.address->>'phone','')))=0
       or length(trim(coalesce(new.address->>'address','')))=0
       or length(trim(coalesce(new.address->>'city','')))=0
       or length(trim(coalesce(new.address->>'postal','')))=0
       or length(trim(coalesce(new.address->>'landmark','')))=0 then
      raise exception 'order delivery address is incomplete'
        using errcode='22023';
    end if;

    if new.payment_method not in ('gcash','bank') then
      raise exception 'unsupported payment method' using errcode='22023';
    end if;

    new.payment_reference := nullif(trim(coalesce(new.payment_reference,'')),'');
    if new.payment_reference is null then
      raise exception 'payment reference is required' using errcode='22023';
    end if;
    if length(new.payment_reference) > 200 then
      raise exception 'payment reference is too long' using errcode='22001';
    end if;

    new.payment_proof := nullif(trim(coalesce(new.payment_proof,'')),'');
    if new.payment_proof is not null
       and split_part(new.payment_proof,'/',1) <> v_uid::text then
      raise exception 'payment proof must belong to the authenticated user namespace'
        using errcode='42501';
    end if;

    v_delivery_fee := coalesce(new.delivery_fee,0);
    -- Phase 4.2B does not invent a maximum route fee: the current browser
    -- contract is 5 km free / PHP 60 per road-km / PHP 600 fallback and may
    -- legitimately exceed PHP 3,000 for long routes. Reject only invalid or
    -- negative numeric values here; Phase 4.3 will move route calculation
    -- behind the trusted checkout boundary.
    if lower(v_delivery_fee::text) in ('nan','infinity','-infinity')
       or v_delivery_fee < 0 then
      raise exception 'delivery fee must be a finite non-negative amount' using errcode='22023';
    end if;

    -- Canonicalize every order line from database state.
    for v_item in select value from jsonb_array_elements(new.items)
    loop
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'order item must be a JSON object' using errcode='22023';
      end if;

      v_qty := nullif(trim(v_item->>'qty'),'')::numeric;
      if v_qty is null
         or lower(v_qty::text) in ('nan','infinity','-infinity')
         or v_qty <= 0
         or v_qty <> trunc(v_qty)
         or v_qty > 10000 then
        raise exception 'invalid order quantity' using errcode='22023';
      end if;

      if coalesce((v_item->>'isBundle')::boolean,false) then
        select b.*
          into v_bundle
        from public.bundles b
        where b.id=nullif(trim(v_item->>'bundleId'),'')
          and b.active=true;

        if not found then
          raise exception 'bundle is unavailable' using errcode='23503';
        end if;

        if v_bundle.bundle_price is null
           or lower(v_bundle.bundle_price::text) in ('nan','infinity','-infinity')
           or v_bundle.bundle_price < 0 then
          raise exception 'bundle has invalid price' using errcode='23514';
        end if;

        if v_bundle.items is null
           or jsonb_typeof(v_bundle.items) <> 'array'
           or jsonb_array_length(v_bundle.items)=0 then
          raise exception 'bundle has no valid components' using errcode='23514';
        end if;

        v_line_price := v_bundle.bundle_price;

        v_canonical_items := v_canonical_items || jsonb_build_object(
          'isBundle', true,
          'bundleId', v_bundle.id,
          'name', v_bundle.name,
          'price', v_line_price,
          'qty', v_qty,
          'components', v_bundle.items
        );

        for v_component in select value from jsonb_array_elements(v_bundle.items)
        loop
          v_component_qty := nullif(trim(v_component->>'qty'),'')::numeric;
          if nullif(trim(v_component->>'productId'),'') is null
             or nullif(trim(v_component->>'feet'),'') is null
             or v_component_qty is null
             or lower(v_component_qty::text) in ('nan','infinity','-infinity')
             or v_component_qty <= 0
             or v_component_qty <> trunc(v_component_qty) then
            raise exception 'bundle contains invalid inventory component'
              using errcode='23514';
          end if;

          -- Validate component identity against live product/size data now.
          select p.*
            into v_product
          from public.products p
          where p.id=v_component->>'productId';

          if not found then
            raise exception 'bundle component product is unavailable'
              using errcode='23503';
          end if;

          select value
            into v_size
          from jsonb_array_elements(coalesce(v_product.sizes,'[]'::jsonb))
          where value->>'feet'=v_component->>'feet'
          limit 1;

          if v_size is null then
            raise exception 'bundle component size is unavailable'
              using errcode='23503';
          end if;

          v_stock_lines := v_stock_lines || jsonb_build_object(
            'productId', v_component->>'productId',
            'feet', v_component->'feet',
            'qty', v_component_qty * v_qty
          );
        end loop;

      else
        select p.*
          into v_product
        from public.products p
        where p.id=nullif(trim(v_item->>'productId'),'');

        if not found then
          raise exception 'product is unavailable' using errcode='23503';
        end if;

        select value
          into v_size
        from jsonb_array_elements(coalesce(v_product.sizes,'[]'::jsonb))
        where value->>'feet'=nullif(trim(v_item->>'feet'),'')
        limit 1;

        if v_size is null then
          raise exception 'product size is unavailable' using errcode='23503';
        end if;

        begin
          v_line_price := (v_size->>'price')::numeric;
        exception
          when invalid_text_representation then
            raise exception 'product size has invalid price' using errcode='23514';
        end;

        if v_line_price is null
           or lower(v_line_price::text) in ('nan','infinity','-infinity')
           or v_line_price < 0 then
          raise exception 'product size has invalid price' using errcode='23514';
        end if;

        -- A single active flash sale may alter the canonical price. Multiple
        -- overlapping sales are treated as configuration error rather than
        -- choosing an arbitrary browser/order.
        select count(*)::integer, max(fs.discount_percent)
          into v_sale_count, v_sale_discount
        from public.flash_sales fs
        where fs.product_id=v_product.id
          and fs.active=true
          and fs.start_at <= v_now_ms
          and fs.end_at >= v_now_ms;

        if v_sale_count > 1 then
          raise exception 'multiple overlapping flash sales exist for product %', v_product.id
            using errcode='23514';
        end if;

        if v_sale_count=1 then
          if v_sale_discount is null
             or lower(v_sale_discount::text) in ('nan','infinity','-infinity')
             or v_sale_discount < 0
             or v_sale_discount > 100 then
            raise exception 'invalid flash sale discount for product %', v_product.id
              using errcode='23514';
          end if;
          v_line_price := greatest(0, v_line_price * (1 - (v_sale_discount/100)));
        end if;

        v_canonical_items := v_canonical_items || jsonb_build_object(
          'productId', v_product.id,
          'feet', v_item->'feet',
          'name',
            v_product.name || ' (' ||
            case
              when v_product.unit_type='size' then v_item->>'feet'
              when v_product.unit_type='sqm' then (v_item->>'feet') || ' sqm'
              else (v_item->>'feet') || ' ft'
            end || ')',
          'price', v_line_price,
          'qty', v_qty
        );

        v_stock_lines := v_stock_lines || jsonb_build_object(
          'productId', v_product.id,
          'feet', v_item->'feet',
          'qty', v_qty
        );
      end if;

      v_subtotal := v_subtotal + (v_line_price * v_qty);
      v_total_qty := v_total_qty + v_qty;
    end loop;

    if v_subtotal <= 0 then
      raise exception 'order has no positive-value items' using errcode='23514';
    end if;

    if v_total_qty >= 256 then
      v_bulk_rate := 0.02;
    elsif v_total_qty >= 250 then
      v_bulk_rate := 0.05;
    else
      v_bulk_rate := 0;
    end if;

    v_bulk_fee := v_subtotal * v_bulk_rate;

    -- Promo is revalidated and consumed under a row lock. Any later stock/order
    -- failure rolls this increment back in the same transaction.
    if nullif(trim(coalesce(new.promo_code,'')),'') is not null then
      select pc.*
        into v_promo
      from public.promo_codes pc
      where upper(trim(pc.code))=upper(trim(new.promo_code))
      for update;

      if not found then
        raise exception 'promo code not found' using errcode='23503';
      end if;

      if not v_promo.active then
        raise exception 'promo code is not active' using errcode='23514';
      end if;

      if v_promo.expires_at is not null and v_now_ms > v_promo.expires_at then
        raise exception 'promo code has expired' using errcode='23514';
      end if;

      if v_promo.max_uses is not null and v_promo.used_count >= v_promo.max_uses then
        raise exception 'promo code usage limit reached' using errcode='23514';
      end if;

      if lower(coalesce(v_promo.min_spend,0)::text) in ('nan','infinity','-infinity')
         or coalesce(v_promo.min_spend,0) < 0 then
        raise exception 'promo minimum spend is invalid' using errcode='23514';
      end if;

      if lower(v_promo.value::text) in ('nan','infinity','-infinity') then
        raise exception 'promo value is invalid' using errcode='23514';
      end if;

      if v_subtotal < coalesce(v_promo.min_spend,0) then
        raise exception 'promo minimum spend not met' using errcode='23514';
      end if;

      if v_promo.discount_type='percent' then
        if v_promo.value < 0 or v_promo.value > 100 then
          raise exception 'promo percent is invalid' using errcode='23514';
        end if;
        v_promo_discount := v_subtotal * (v_promo.value/100);
      elsif v_promo.discount_type='fixed' then
        if v_promo.value < 0 then
          raise exception 'promo value is invalid' using errcode='23514';
        end if;
        v_promo_discount := v_promo.value;
      else
        raise exception 'promo discount type is invalid' using errcode='23514';
      end if;

      v_promo_discount := greatest(0, least(v_promo_discount,v_subtotal));

      update public.promo_codes
         set used_count=used_count+1
       where id=v_promo.id;

      new.promo_code := v_promo.code;
    else
      new.promo_code := null;
      v_promo_discount := 0;
    end if;

    -- Atomic inventory authority.
    perform dagoldol_private.apply_stock_lines(v_stock_lines,-1);

    v_total := greatest(
      0,
      v_subtotal
      - v_promo_discount
      + v_delivery_fee
      + v_bulk_fee
    );

    -- Browser-supplied trusted fields are replaced with canonical DB values.
    new.user_id := v_uid;
    new.username := v_profile_username;
    new.items := v_canonical_items;
    new.subtotal := v_subtotal;
    new.delivery_fee := v_delivery_fee;
    new.bulk_fee_rate := v_bulk_rate;
    new.bulk_fee := v_bulk_fee;
    new.cod_fee := 0;
    new.promo_discount := v_promo_discount;
    new.total := v_total;
    new.half_payment := coalesce(new.half_payment,false);
    new.amount_due_now := case when new.half_payment then v_total/2 else v_total end;
    new.amount_due_later := case when new.half_payment then v_total-(v_total/2) else 0 end;
    new.placed_at := v_now_ms;
    new.delivery_days := 6;
    new.status_override := 0;
    new.cancelled := false;
    new.rated := '{}'::jsonb;

    return new;
  end if;

  -- ------------------------------------------------------------------------
  -- Customer UPDATE: everything except cancellation and rated-state remains
  -- immutable. This includes all Phase 4.2B payment fields automatically.
  -- ------------------------------------------------------------------------
  if (to_jsonb(new)-'cancelled'-'rated')
       is distinct from
     (to_jsonb(old)-'cancelled'-'rated') then
    raise exception 'customers may not modify protected order fields'
      using errcode='42501';
  end if;

  -- Do not allow one UPDATE to combine cancellation and rating-state mutation.
  if new.cancelled is distinct from old.cancelled
     and new.rated is distinct from old.rated then
    raise exception 'cancellation and rating changes must be separate operations'
      using errcode='42501';
  end if;

  if new.cancelled is distinct from old.cancelled then
    if old.cancelled=true and new.cancelled=false then
      raise exception 'a cancelled order cannot be reopened by the customer'
        using errcode='42501';
    end if;

    if new.cancelled=true then
      -- Preserve the pre-4.2B cancellation contract for historical rows that
      -- may still have NULL status_override. Current 3.3.5 orders use an
      -- explicit status index, while older orders derived shipping from time.
      if old.status_override is not null then
        if old.status_override >= 2 then
          raise exception 'order can no longer be cancelled at its current status'
            using errcode='42501';
        end if;
      else
        v_cancel_cutoff_ms :=
          old.placed_at::numeric
          + (old.delivery_days::numeric * 86400000::numeric * 0.45::numeric);

        if v_now_ms::numeric >= v_cancel_cutoff_ms then
          raise exception 'order can no longer be cancelled after shipping has begun'
            using errcode='42501';
        end if;
      end if;

      v_cancel_lines := dagoldol_private.stock_lines_from_order_items(old.items);
      perform dagoldol_private.apply_stock_lines(v_cancel_lines,1);
    end if;
  end if;

  -- Preserve existing per-order rating-state safety used by the UI.
  if new.rated is distinct from old.rated then
    if old.cancelled then
      raise exception 'cancelled orders cannot be rated'
        using errcode='42501';
    end if;

    -- Preserve historical NULL-status rows: they become delivered after their
    -- stored delivery window. Current orders use explicit status_override=0..4.
    if not (
      coalesce(old.status_override=4,false)
      or (
        old.status_override is null
        and v_now_ms >= (
          old.placed_at
          + (old.delivery_days::bigint * 86400000::bigint)
        )
      )
    ) then
      raise exception 'order cannot be rated before delivery'
        using errcode='42501';
    end if;

    if jsonb_typeof(new.rated) <> 'object' then
      raise exception 'orders.rated must be a JSON object'
        using errcode='22023';
    end if;

    if not (new.rated @> old.rated) then
      raise exception 'existing order ratings cannot be changed or removed'
        using errcode='42501';
    end if;

    for v_key,v_value in
      select e.key,e.value from jsonb_each(new.rated) e(key,value)
    loop
      if jsonb_typeof(v_value) <> 'number'
         or (v_value #>> '{}') !~ '^[1-5]$' then
        raise exception 'rating for product % must be an integer from 1 to 5', v_key
          using errcode='22023';
      end if;

      if not exists (
        select 1
        from jsonb_array_elements(old.items) item
        where coalesce(item->>'isBundle','false') <> 'true'
          and item->>'productId'=v_key
      ) then
        raise exception 'product % is not a rateable item in this order', v_key
          using errcode='42501';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_customer_order_write() from public;
revoke all on function public.guard_customer_order_write() from anon;
revoke all on function public.guard_customer_order_write() from authenticated;

comment on function public.guard_customer_order_write() is
'Phase 4.2B commerce authority: canonical customer order insert, atomic promo/stock, protected updates, atomic cancellation restore.';

-- Trigger should already exist, but recreate deterministically.
drop trigger if exists orders_guard_customer_write on public.orders;
create trigger orders_guard_customer_write
before insert or update on public.orders
for each row execute function public.guard_customer_order_write();

-- --------------------------------------------------------------------------
-- 8. Repair the existing place_order() API so it matches the live schema.
--
--    It intentionally uses SECURITY INVOKER. RLS + the Phase 4.2B trigger are
--    the authority. The function supplies placeholders for canonical fields;
--    the trigger recalculates them before constraint enforcement.
-- --------------------------------------------------------------------------
create or replace function public.place_order(
  p_order_id text,
  p_items jsonb,
  p_address jsonb,
  p_payment_method text,
  p_payment_reference text,
  p_payment_proof text,
  p_half_payment boolean,
  p_delivery_fee numeric,
  p_promo_code text,
  p_delivery_days integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  insert into public.orders(
    id,
    user_id,
    username,
    items,
    subtotal,
    delivery_fee,
    bulk_fee_rate,
    bulk_fee,
    cod_fee,
    total,
    payment_method,
    payment_reference,
    payment_proof,
    half_payment,
    amount_due_now,
    amount_due_later,
    address,
    placed_at,
    delivery_days,
    status_override,
    cancelled,
    rated,
    promo_code,
    promo_discount
  )
  values (
    p_order_id,
    auth.uid(),
    '',
    p_items,
    0,
    coalesce(p_delivery_fee,0),
    0,
    0,
    0,
    0,
    p_payment_method,
    p_payment_reference,
    p_payment_proof,
    coalesce(p_half_payment,false),
    0,
    0,
    p_address,
    0,
    coalesce(p_delivery_days,6),
    0,
    false,
    '{}'::jsonb,
    nullif(trim(coalesce(p_promo_code,'')),''),
    0
  )
  returning * into v_row;

  return jsonb_build_object(
    'orderId', v_row.id,
    'subtotal', v_row.subtotal,
    'bulkFee', v_row.bulk_fee,
    'bulkFeeRate', v_row.bulk_fee_rate,
    'promoDiscount', coalesce(v_row.promo_discount,0),
    'deliveryFee', v_row.delivery_fee,
    'total', v_row.total,
    'amountDueNow', v_row.amount_due_now,
    'amountDueLater', v_row.amount_due_later,
    'placedAt', v_row.placed_at
  );
end;
$$;

revoke all on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) from public;
revoke all on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) from anon;
revoke all on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) from authenticated;
grant execute on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer)
  to authenticated, service_role;

comment on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) is
'Phase 4.2B authenticated convenience RPC. SECURITY INVOKER; RLS + orders_guard_customer_write enforce commerce authority.';

-- --------------------------------------------------------------------------
-- 9. Rename the temporary Phase 4.2A policy to its stable Phase 4.2B contract.
--    Direct customer INSERT remains because current 3.3.5 uses it; the trigger
--    now strips customer authority over trusted fields before the row is saved.
-- --------------------------------------------------------------------------
drop policy if exists p42_orders_insert_owner_compat_phase42a on public.orders;
drop policy if exists p42_orders_insert_owner on public.orders;

create policy p42_orders_insert_owner
on public.orders
for insert
to authenticated
with check (user_id=auth.uid());

-- --------------------------------------------------------------------------
-- 10. Post-migration fail-closed structural assertions.
-- --------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_def text;
begin
  select string_agg(required_name, ', ' order by required_name)
    into v_missing
  from (
    select required_name
    from unnest(array[
      'payment_reference','payment_proof','half_payment','amount_due_now','amount_due_later'
    ]) r(required_name)
    where not exists (
      select 1 from information_schema.columns c
      where c.table_schema='public'
        and c.table_name='orders'
        and c.column_name=r.required_name
    )
  ) m;

  if v_missing is not null then
    raise exception 'Phase 4.2B stopped: required order columns missing after migration: %', v_missing;
  end if;

  select pg_get_functiondef('public.decrement_stock_for_order(jsonb)'::regprocedure)
    into v_def;
  if lower(v_def) like '%update public.products%' then
    raise exception 'Phase 4.2B stopped: public decrement helper still mutates products.';
  end if;

  select pg_get_functiondef('public.restore_stock_for_order(jsonb)'::regprocedure)
    into v_def;
  if lower(v_def) like '%update public.products%' then
    raise exception 'Phase 4.2B stopped: public restore helper still mutates products.';
  end if;

  select pg_get_functiondef('public.guard_customer_order_write()'::regprocedure)
    into v_def;
  if lower(v_def) not like '%dagoldol_private.apply_stock_lines%'
     or lower(v_def) not like '%update public.promo_codes%' then
    raise exception 'Phase 4.2B stopped: order guard is missing atomic stock/promo authority.';
  end if;

  if has_function_privilege(
    'authenticated',
    'dagoldol_private.apply_stock_lines(jsonb,integer)',
    'EXECUTE'
  ) then
    raise exception 'Phase 4.2B stopped: authenticated can execute private stock mutator.';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname in ('decrement_stock_for_order','restore_stock_for_order','place_order')
      and p.prosecdef
  ) then
    raise exception 'Phase 4.2B stopped: browser-facing commerce RPC remains SECURITY DEFINER.';
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname='public'
      and tablename='orders'
      and policyname='p42_orders_insert_owner_compat_phase42a'
  ) then
    raise exception 'Phase 4.2B stopped: temporary Phase 4.2A order policy still exists.';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname='public'
      and tablename='orders'
      and policyname='p42_orders_insert_owner'
      and cmd='INSERT'
  ) then
    raise exception 'Phase 4.2B stopped: canonical owned-order INSERT policy missing.';
  end if;
end
$$;

commit;

-- ============================================================================
-- PHASE 4.2B RESULTING AUTHORITY
--
-- * Browser decrement_stock_for_order(): availability validation only.
-- * Browser restore_stock_for_order(): no-op compatibility shim.
-- * Customer order INSERT: allowed only for owner; trusted fields canonicalized
--   by DB; promo increment + stock decrement are atomic.
-- * Customer cancellation UPDATE: cancellation validation + stock restore atomic.
-- * Customer cannot mutate protected saved order/payment/commercial fields.
-- * Delivery road-route quote remains client-produced and is only validated
--   as finite/non-negative here.
--   Move route quote calculation to the trusted checkout service in Phase 4.3.
-- ============================================================================
