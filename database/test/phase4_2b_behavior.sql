-- ============================================================================
-- DAGOLDOL PHASE 4.2B — COMMERCE AUTHORITY BEHAVIOR REGRESSION
-- STAGING / ISOLATED DATABASE ONLY.
--
-- This test writes temporary fixture rows and ends with ROLLBACK.
-- DO NOT RUN THIS ON PRODUCTION.
--
-- Preconditions:
--   * Phase 4.2A1 + 4.2A2 already applied.
--   * Phase 4.2B migration already applied.
--   * At least one existing customer profile is present in staging.
-- ============================================================================

begin;

-- Fail clearly if this is run before the Phase 4.2B migration.
do $$
begin
  if to_regprocedure('dagoldol_private.apply_stock_lines(jsonb,integer)') is null then
    raise exception 'TEST SETUP REQUIRED: Phase 4.2B migration is not installed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name='payment_reference'
  ) then
    raise exception 'TEST SETUP REQUIRED: Phase 4.2B order columns are missing.';
  end if;
  if not exists (select 1 from public.profiles where role='customer') then
    raise exception 'TEST SETUP REQUIRED: staging needs at least one customer profile.';
  end if;
end
$$;

select set_config(
  'p42b.customer_id',
  (select id::text from public.profiles where role='customer' order by created_at,id limit 1),
  true
);
select set_config(
  'p42b.customer_username',
  (select username from public.profiles where id=current_setting('p42b.customer_id')::uuid),
  true
);

-- Trusted fixtures. These are removed by the final transaction rollback.
insert into public.products(
  id,name,description,price,sizes,unit_type
) values (
  'p42b-regression-product',
  'Phase 4.2B Regression Product',
  'Temporary commerce-authority fixture',
  null,
  '[{"feet":"1","price":100,"stock":2}]'::jsonb,
  'feet'
)
on conflict (id) do update
set name=excluded.name,
    description=excluded.description,
    price=excluded.price,
    sizes=excluded.sizes,
    unit_type=excluded.unit_type;

insert into public.promo_codes(
  id,code,kind,discount_type,value,min_spend,max_uses,used_count,expires_at,active
) values (
  'p42b-regression-promo',
  'P42BTEST',
  'coupon',
  'fixed',
  10,
  0,
  1,
  0,
  null,
  true
)
on conflict (id) do update
set code=excluded.code,
    kind=excluded.kind,
    discount_type=excluded.discount_type,
    value=excluded.value,
    min_spend=excluded.min_spend,
    max_uses=excluded.max_uses,
    used_count=0,
    expires_at=null,
    active=true;

-- Simulate a Data API authenticated customer.
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',current_setting('p42b.customer_id'),true);
select set_config(
  'request.jwt.claims',
  json_build_object(
    'role','authenticated',
    'sub',current_setting('p42b.customer_id')
  )::text,
  true
);

-- --------------------------------------------------------------------------
-- 1. Compatibility decrement RPC must not mutate stock.
-- --------------------------------------------------------------------------
select public.decrement_stock_for_order(
  '[{"productId":"p42b-regression-product","feet":"1","qty":1}]'::jsonb
);

do $$
declare v_stock numeric;
begin
  select (s->>'stock')::numeric
    into v_stock
  from public.products p
  cross join lateral jsonb_array_elements(p.sizes) s
  where p.id='p42b-regression-product' and s->>'feet'='1';

  if v_stock <> 2 then
    raise exception 'FAIL: public decrement compatibility RPC changed inventory.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 2. Malicious browser monetary/item values are canonicalized on INSERT.
--    Delivery fee remains the current client quote boundary until Phase 4.3,
--    so this fixture intentionally uses a legitimate non-negative fee of 10.
-- --------------------------------------------------------------------------
insert into public.orders(
  id,user_id,username,items,subtotal,delivery_fee,bulk_fee_rate,bulk_fee,cod_fee,total,
  payment_method,payment_reference,payment_proof,half_payment,amount_due_now,amount_due_later,
  address,placed_at,delivery_days,status_override,cancelled,rated,promo_code,promo_discount
) values (
  'ORD-P42B-REGRESSION-1',
  current_setting('p42b.customer_id')::uuid,
  'FORGED-USERNAME',
  '[{"productId":"p42b-regression-product","feet":"1","name":"FORGED NAME","price":1,"qty":1}]'::jsonb,
  1,
  10,
  0.99,
  9999,
  9999,
  1,
  'gcash',
  'P42B-REF-1',
  null,
  false,
  9999,
  9999,
  '{"name":"Test Customer","phone":"09170000000","address":"Test Street","city":"Test City","postal":"0000","landmark":"Test Landmark"}'::jsonb,
  1,
  6,
  4,
  true,
  '{"forged":5}'::jsonb,
  'P42BTEST',
  9999
);

do $$
declare
  v_order public.orders%rowtype;
  v_stock numeric;
  v_used integer;
begin
  select * into v_order
  from public.orders
  where id='ORD-P42B-REGRESSION-1';

  if v_order.username is distinct from current_setting('p42b.customer_username') then
    raise exception 'FAIL: username was not canonicalized.';
  end if;
  if v_order.subtotal <> 100 then
    raise exception 'FAIL: subtotal was not canonicalized; got %.', v_order.subtotal;
  end if;
  if (v_order.items->0->>'price')::numeric <> 100 then
    raise exception 'FAIL: item price was not canonicalized.';
  end if;
  if v_order.bulk_fee_rate <> 0 or v_order.bulk_fee <> 0 or v_order.cod_fee <> 0 then
    raise exception 'FAIL: fee fields were not canonicalized.';
  end if;
  if coalesce(v_order.promo_discount,0) <> 10 then
    raise exception 'FAIL: promo discount was not canonicalized.';
  end if;
  if v_order.total <> 100 then
    raise exception 'FAIL: total was not canonicalized; expected 100, got %.', v_order.total;
  end if;
  if v_order.amount_due_now <> 100 or v_order.amount_due_later <> 0 then
    raise exception 'FAIL: amount-due fields were not canonicalized.';
  end if;
  if v_order.status_override <> 0 or v_order.cancelled or v_order.rated <> '{}'::jsonb then
    raise exception 'FAIL: trusted workflow fields were not canonicalized.';
  end if;

  select (s->>'stock')::numeric
    into v_stock
  from public.products p
  cross join lateral jsonb_array_elements(p.sizes) s
  where p.id='p42b-regression-product' and s->>'feet'='1';
  if v_stock <> 1 then
    raise exception 'FAIL: atomic checkout stock decrement expected 1, got %.', v_stock;
  end if;

  select used_count into v_used
  from public.promo_codes
  where id='p42b-regression-promo';
  if v_used <> 1 then
    raise exception 'FAIL: promo usage expected 1, got %.', v_used;
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 3. Browser restore compatibility RPC must be a no-op.
-- --------------------------------------------------------------------------
select public.restore_stock_for_order(
  '[{"productId":"p42b-regression-product","feet":"1","qty":1}]'::jsonb
);

do $$
declare v_stock numeric;
begin
  select (s->>'stock')::numeric
    into v_stock
  from public.products p
  cross join lateral jsonb_array_elements(p.sizes) s
  where p.id='p42b-regression-product' and s->>'feet'='1';
  if v_stock <> 1 then
    raise exception 'FAIL: public restore compatibility RPC changed inventory.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 4. Insufficient stock rejects the order and leaves inventory unchanged.
-- --------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.orders(
      id,user_id,username,items,subtotal,delivery_fee,bulk_fee_rate,bulk_fee,cod_fee,total,
      payment_method,payment_reference,payment_proof,half_payment,amount_due_now,amount_due_later,
      address,placed_at,delivery_days,status_override,cancelled,rated,promo_code,promo_discount
    ) values (
      'ORD-P42B-REGRESSION-INSUFFICIENT',
      current_setting('p42b.customer_id')::uuid,
      current_setting('p42b.customer_username'),
      '[{"productId":"p42b-regression-product","feet":"1","price":1,"qty":2}]'::jsonb,
      1,0,0,0,0,1,
      'gcash','P42B-REF-2',null,false,0,0,
      '{"name":"Test Customer","phone":"09170000000","address":"Test Street","city":"Test City","postal":"0000","landmark":"Test Landmark"}'::jsonb,
      1,6,0,false,'{}'::jsonb,null,0
    );
    raise exception 'FAIL: insufficient-stock order unexpectedly succeeded.';
  exception
    when sqlstate '23514' then null;
  end;
end
$$;

do $$
declare v_stock numeric;
begin
  if exists (select 1 from public.orders where id='ORD-P42B-REGRESSION-INSUFFICIENT') then
    raise exception 'FAIL: rejected insufficient-stock order persisted.';
  end if;

  select (s->>'stock')::numeric
    into v_stock
  from public.products p
  cross join lateral jsonb_array_elements(p.sizes) s
  where p.id='p42b-regression-product' and s->>'feet'='1';
  if v_stock <> 1 then
    raise exception 'FAIL: rejected order changed inventory; got %.', v_stock;
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 5. Customer cannot point payment proof at another first-level namespace.
-- --------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.orders(
      id,user_id,username,items,subtotal,delivery_fee,bulk_fee_rate,bulk_fee,cod_fee,total,
      payment_method,payment_reference,payment_proof,half_payment,amount_due_now,amount_due_later,
      address,placed_at,delivery_days,status_override,cancelled,rated,promo_code,promo_discount
    ) values (
      'ORD-P42B-REGRESSION-BADPROOF',
      current_setting('p42b.customer_id')::uuid,
      current_setting('p42b.customer_username'),
      '[{"productId":"p42b-regression-product","feet":"1","price":1,"qty":1}]'::jsonb,
      1,0,0,0,0,1,
      'gcash','P42B-REF-3','00000000-0000-0000-0000-000000000000/proof.jpg',false,0,0,
      '{"name":"Test Customer","phone":"09170000000","address":"Test Street","city":"Test City","postal":"0000","landmark":"Test Landmark"}'::jsonb,
      1,6,0,false,'{}'::jsonb,null,0
    );
    raise exception 'FAIL: cross-account payment-proof namespace was accepted.';
  exception
    when sqlstate '42501' then null;
  end;
end
$$;

-- --------------------------------------------------------------------------
-- 6. Customer cancellation restores stock atomically with the order UPDATE.
-- --------------------------------------------------------------------------
update public.orders
set cancelled=true
where id='ORD-P42B-REGRESSION-1';

do $$
declare v_stock numeric;
begin
  if not coalesce((select cancelled from public.orders where id='ORD-P42B-REGRESSION-1'),false) then
    raise exception 'FAIL: eligible cancellation did not persist.';
  end if;

  select (s->>'stock')::numeric
    into v_stock
  from public.products p
  cross join lateral jsonb_array_elements(p.sizes) s
  where p.id='p42b-regression-product' and s->>'feet'='1';
  if v_stock <> 2 then
    raise exception 'FAIL: cancellation did not restore stock atomically; got %.', v_stock;
  end if;
end
$$;

-- Uncancelling must remain denied and must not change inventory.
do $$
begin
  begin
    update public.orders
    set cancelled=false
    where id='ORD-P42B-REGRESSION-1';
    raise exception 'FAIL: customer reopened a cancelled order.';
  exception
    when sqlstate '42501' then null;
  end;
end
$$;

-- Protected commercial fields remain immutable after save.
do $$
begin
  begin
    update public.orders
    set total=1
    where id='ORD-P42B-REGRESSION-1';
    raise exception 'FAIL: customer changed trusted saved total.';
  exception
    when sqlstate '42501' then null;
  end;
end
$$;

-- --------------------------------------------------------------------------
-- 7. The real stock mutator must not be callable by authenticated customers.
-- --------------------------------------------------------------------------
do $$
begin
  begin
    perform dagoldol_private.apply_stock_lines(
      '[{"productId":"p42b-regression-product","feet":"1","qty":1}]'::jsonb,
      -1
    );
    raise exception 'FAIL: authenticated customer executed private stock mutator.';
  exception
    when sqlstate '42501' then null;
  end;
end
$$;

reset role;

-- Everything above is disposable staging evidence only.
rollback;
