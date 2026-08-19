-- ============================================================================
-- DAGOLDOL PHASE 4.2A — RLS / AUTHORIZATION BEHAVIOR REGRESSION
-- STAGING ONLY. This test performs writes inside one transaction and ROLLS BACK.
-- Do not run on production. Requires at least 2 existing customer profiles and
-- 1 existing admin profile in the staging project so auth.uid()-backed RLS can
-- be simulated without fabricating auth.users rows.
-- ============================================================================

begin;

-- --------------------------------------------------------------------------
-- 0. Fixture identity preflight and capture while running as database owner.
-- --------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.profiles where role='customer') < 2 then
    raise exception 'TEST SETUP REQUIRED: staging needs at least two customer accounts.';
  end if;
  if (select count(*) from public.profiles where role='admin') < 1 then
    raise exception 'TEST SETUP REQUIRED: staging needs at least one admin account.';
  end if;
end
$$;

select set_config(
  'p42.customer_a',
  (select id::text from public.profiles where role='customer' order by created_at,id limit 1),
  true
);
select set_config(
  'p42.customer_b',
  (select id::text from public.profiles where role='customer' and id::text<>current_setting('p42.customer_a') order by created_at,id limit 1),
  true
);
select set_config(
  'p42.customer_a_username',
  (select username from public.profiles where id=current_setting('p42.customer_a')::uuid),
  true
);
select set_config(
  'p42.customer_b_username',
  (select username from public.profiles where id=current_setting('p42.customer_b')::uuid),
  true
);
select set_config(
  'p42.admin_id',
  (select id::text from public.profiles where role='admin' order by created_at,id limit 1),
  true
);
select set_config(
  'p42.admin_username',
  (select username from public.profiles where id=current_setting('p42.admin_id')::uuid),
  true
);
select set_config(
  'p42.thread_id',
  least(current_setting('p42.customer_a'),current_setting('p42.customer_b'))
    || '::' ||
  greatest(current_setting('p42.customer_a'),current_setting('p42.customer_b')),
  true
);

-- Test rows created as trusted SQL; all are removed by the final ROLLBACK.
insert into public.settings(key,value)
values ('p42-regression-setting','original')
on conflict (key) do update set value=excluded.value;

insert into public.promo_codes(
  id,code,kind,discount_type,value,min_spend,max_uses,used_count,expires_at,active
) values (
  'p42-regression-promo','P42REGRESSION','coupon','fixed',10,0,100,0,null,true
)
on conflict (id) do update set used_count=0, active=true;

insert into public.products(id,name,description,price,sizes,unit_type)
values (
  'p42-regression-product','P42 Regression Product','Authorization regression fixture',null,
  '[{"feet":"1","price":100,"stock":10}]'::jsonb,'feet'
)
on conflict (id) do update set name=excluded.name,description=excluded.description,sizes=excluded.sizes;

insert into public.orders(
  id,user_id,username,items,subtotal,delivery_fee,bulk_fee_rate,bulk_fee,cod_fee,total,
  payment_method,address,placed_at,delivery_days,status_override,cancelled,rated,promo_code,promo_discount
) values
(
  'P42-ORDER-A',
  current_setting('p42.customer_a')::uuid,
  current_setting('p42.customer_a_username'),
  '[{"productId":"p42-regression-product","feet":"1","name":"P42 Regression Product","price":100,"qty":1}]'::jsonb,
  100,0,0,0,0,100,'gcash','{}'::jsonb,
  floor(extract(epoch from clock_timestamp())*1000)::bigint,3,4,false,'{}'::jsonb,null,0
),
(
  'P42-ORDER-B',
  current_setting('p42.customer_b')::uuid,
  current_setting('p42.customer_b_username'),
  '[{"productId":"p42-regression-product","feet":"1","name":"P42 Regression Product","price":100,"qty":1}]'::jsonb,
  100,0,0,0,0,100,'gcash','{}'::jsonb,
  floor(extract(epoch from clock_timestamp())*1000)::bigint,3,4,false,'{}'::jsonb,null,0
)
on conflict (id) do nothing;

-- --------------------------------------------------------------------------
-- Helper pattern: set Supabase-compatible JWT claims, then SET ROLE.
-- --------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', current_setting('p42.customer_a'), true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',current_setting('p42.customer_a'),'role','authenticated')::text,
  true
);
set local role authenticated;

-- --------------------------------------------------------------------------
-- 1. Privilege escalation: customer -> admin must fail.
-- --------------------------------------------------------------------------
do $$
begin
  begin
    update public.profiles
       set role='admin'
     where id=current_setting('p42.customer_a')::uuid;
    raise exception 'FAIL: customer role escalation UPDATE unexpectedly completed.';
  exception
    when sqlstate '42501' then null;
  end;

  if exists (
    select 1 from public.profiles
    where id=current_setting('p42.customer_a')::uuid and role='admin'
  ) then
    raise exception 'FAIL: customer role persisted as admin.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 2. Profile IDOR: Customer A cannot query Customer B's row/private fields.
-- --------------------------------------------------------------------------
do $$
declare v_count integer;
begin
  select count(*) into v_count
  from public.profiles
  where id=current_setting('p42.customer_b')::uuid;
  if v_count <> 0 then
    raise exception 'FAIL: Customer A can read Customer B profile row.';
  end if;
end
$$;

-- Safe exact username directory lookup remains available without private fields.
do $$
declare
  v_id uuid;
  v_username text;
begin
  select d.id,d.username into v_id,v_username
  from public.p42_lookup_profile_directory(current_setting('p42.customer_b_username')) d;
  if v_id is distinct from current_setting('p42.customer_b')::uuid
     or v_username is distinct from current_setting('p42.customer_b_username') then
    raise exception 'FAIL: safe profile directory lookup did not return Customer B identity.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 3. Order IDOR and trusted-field integrity.
-- --------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_rows integer;
begin
  select count(*) into v_count from public.orders where id='P42-ORDER-B';
  if v_count <> 0 then
    raise exception 'FAIL: Customer A can read Customer B order.';
  end if;

  update public.orders set cancelled=true where id='P42-ORDER-B';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FAIL: Customer A updated Customer B order.';
  end if;

  begin
    update public.orders set total=1 where id='P42-ORDER-A';
    raise exception 'FAIL: customer changed trusted own-order total.';
  exception
    when sqlstate '42501' then null;
  end;

  if (select total from public.orders where id='P42-ORDER-A') <> 100 then
    raise exception 'FAIL: own-order total changed despite guard.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 4. Customer cannot alter storefront settings or promo usage counters.
-- --------------------------------------------------------------------------
do $$
declare v_rows integer;
begin
  update public.settings set value='attacker' where key='p42-regression-setting';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FAIL: customer updated storefront settings.';
  end if;
  if (select value from public.settings where key='p42-regression-setting') <> 'original' then
    raise exception 'FAIL: settings value changed.';
  end if;

  update public.promo_codes set used_count=99 where id='p42-regression-promo';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FAIL: customer updated promo usage counter.';
  end if;
  if (select used_count from public.promo_codes where id='p42-regression-promo') <> 0 then
    raise exception 'FAIL: promo used_count changed.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 5. Direct-message identity and immutable content.
-- --------------------------------------------------------------------------
insert into public.dm_threads(
  id,user_a_id,user_a_username,user_b_id,user_b_username,created_at,
  last_message_at,last_message_preview,user_a_last_read_at,user_b_last_read_at
) values (
  current_setting('p42.thread_id'),
  current_setting('p42.customer_a')::uuid,current_setting('p42.customer_a_username'),
  current_setting('p42.customer_b')::uuid,current_setting('p42.customer_b_username'),
  1,null,'',1,1
);

-- Deliberately submit the other customer's identity. Trigger must canonicalize.
insert into public.dm_messages(
  id,thread_id,sender_id,sender_username,body,sent_at,reactions
) values (
  'P42-DM-1',current_setting('p42.thread_id'),
  current_setting('p42.customer_b')::uuid,current_setting('p42.customer_b_username'),
  'phase 4.2 identity test',1,'{}'::jsonb
);

do $$
declare
  v_sender uuid;
  v_sender_username text;
begin
  select sender_id,sender_username into v_sender,v_sender_username
  from public.dm_messages where id='P42-DM-1';
  if v_sender is distinct from current_setting('p42.customer_a')::uuid
     or v_sender_username is distinct from current_setting('p42.customer_a_username') then
    raise exception 'FAIL: DM sender impersonation was not canonicalized.';
  end if;

  begin
    update public.dm_messages set body='rewritten' where id='P42-DM-1';
    raise exception 'FAIL: saved DM body was rewritten.';
  exception
    when sqlstate '42501' then null;
  end;

  begin
    update public.dm_messages
       set reactions=jsonb_build_object('👍',jsonb_build_array(current_setting('p42.customer_b')))
     where id='P42-DM-1';
    raise exception 'FAIL: Customer A forged Customer B reaction identity.';
  exception
    when sqlstate '42501' then null;
  end;
end
$$;

-- Customer A can add/remove only their own reaction identity.
update public.dm_messages
set reactions=jsonb_build_object('👍',jsonb_build_array(current_setting('p42.customer_a')))
where id='P42-DM-1';

-- --------------------------------------------------------------------------
-- 6. Ratings: other customer's order denied; own delivered purchase allowed;
--    duplicate rating denied by unique order/product index.
-- --------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.ratings(user_id,order_id,product_id,value)
    values (
      current_setting('p42.customer_a')::uuid,'P42-ORDER-B','p42-regression-product',5
    );
    raise exception 'FAIL: Customer A rated Customer B order.';
  exception
    when sqlstate '42501' then null;
  end;
end
$$;

insert into public.ratings(user_id,order_id,product_id,value)
values (
  current_setting('p42.customer_a')::uuid,'P42-ORDER-A','p42-regression-product',5
);

do $$
begin
  begin
    insert into public.ratings(user_id,order_id,product_id,value)
    values (
      current_setting('p42.customer_a')::uuid,'P42-ORDER-A','p42-regression-product',4
    );
    raise exception 'FAIL: duplicate order/product rating was accepted.';
  exception
    when unique_violation then null;
  end;
end
$$;

-- --------------------------------------------------------------------------
-- 7. A non-participant cannot inspect another DM thread. Here the admin test
-- account is deliberately not a participant; DM privacy is participant-based.
-- --------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', current_setting('p42.admin_id'), true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub',current_setting('p42.admin_id'),'role','authenticated')::text,
  true
);
set local role authenticated;

do $$
declare v_count integer;
begin
  select count(*) into v_count
  from public.dm_threads
  where id=current_setting('p42.thread_id');
  if v_count <> 0 then
    raise exception 'FAIL: non-participant admin can read a private customer DM thread.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 8. Verified admin retains legitimate management access.
-- --------------------------------------------------------------------------
update public.settings set value='admin-ok' where key='p42-regression-setting';
update public.products set name='P42 Admin Updated Product' where id='p42-regression-product';

do $$
begin
  if (select value from public.settings where key='p42-regression-setting') <> 'admin-ok' then
    raise exception 'FAIL: admin could not update settings.';
  end if;
  if (select name from public.products where id='p42-regression-product') <> 'P42 Admin Updated Product' then
    raise exception 'FAIL: admin could not update product.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 9. Anonymous role cannot access customer profiles/orders.
-- --------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"anon"}',true);
set local role anon;

do $$
begin
  if has_table_privilege('anon','public.profiles','SELECT') then
    raise exception 'FAIL: anon has direct profiles SELECT privilege.';
  end if;
  if has_table_privilege('anon','public.orders','SELECT') then
    raise exception 'FAIL: anon has direct orders SELECT privilege.';
  end if;
  if has_function_privilege('anon','public.p42_lookup_profile_directory(text)','EXECUTE') then
    raise exception 'FAIL: anon can execute authenticated profile directory RPC.';
  end if;
end
$$;

reset role;
rollback;

-- PASS: script reaches ROLLBACK without exception. No fixture writes persist.
