-- DAGOLDOL PHASE 4.3 clean-replay behavior verification.
-- STAGING ONLY. All fixtures are rolled back. Expected final row: PASS.

begin;

insert into auth.users(id) values ('43aa0000-0000-4000-8000-000000000001'::uuid);
insert into public.profiles(id,username,role)
values ('43aa0000-0000-4000-8000-000000000001'::uuid,'p43_clean_replay','customer');
insert into public.products(id,name,description,sizes,unit_type) values (
  'p43-clean-product','Clean Replay Product','fixture',
  '[{"feet":"10","price":"100","stock":2}]'::jsonb,'feet'
);
insert into public.promo_codes(id,code,discount_type,value,min_spend,max_uses,used_count,active)
values ('p43-clean-promo','P43CLEAN','fixed',10,0,1,0,true);

set local role service_role;

do $$
declare
  v_request jsonb := jsonb_build_object(
    'operation','commit',
    'items',jsonb_build_array(jsonb_build_object(
      'kind','product','productId','p43-clean-product','variant','10','quantity',1,
      'productPrice',1,'price',1,'discount',99999
    )),
    'delivery',jsonb_build_object(
      'name','Clean Replay','phone','09990000000','address','Test Street',
      'city','Davao City','postal','8000','landmark','Gate',
      'location',jsonb_build_object('latitude',7.40,'longitude',125.30,'confirmed',true)
    ),
    'promoCode','P43CLEAN',
    'payment',jsonb_build_object('method','gcash','reference','CLEAN-REF','proofPath',null,'halfPayment',false),
    'saveAddress',false,
    'total',1,'deliveryFee',0,'promoDiscount',99999,'subtotal',1
  );
  v_route jsonb := '{"source":"osrm","main":{"ok":true,"roadDistanceKm":10},"freeZones":[]}'::jsonb;
  v_hash text := public.p43_get_routing_config()->>'configHash';
  v_r1 jsonb;
  v_r2 jsonb;
  v_order_id text;
  v_stock numeric;
  v_used integer;
  v_count integer;
begin
  v_r1 := public.p43_commit_checkout(
    '43aa0000-0000-4000-8000-000000000001'::uuid,
    '43aa0000-0000-4000-8000-000000000010'::uuid,
    v_request,v_route,v_hash
  );

  v_order_id := v_r1->>'orderId';
  if v_order_id is null then raise exception 'clean replay: missing order id'; end if;
  if (v_r1->>'subtotal')::numeric <> 100 then raise exception 'clean replay: forged subtotal was trusted'; end if;
  if (v_r1->>'promoDiscount')::numeric <> 10 then raise exception 'clean replay: promo canonicalization failed'; end if;
  if (v_r1->>'deliveryFee')::numeric <> 600 then raise exception 'clean replay: delivery fee not server authoritative'; end if;
  if (v_r1->>'total')::numeric <> 690 then raise exception 'clean replay: final total incorrect'; end if;
  if (v_r1->'items'->0->>'price')::numeric <> 100 then raise exception 'clean replay: forged product price was trusted'; end if;

  select (s.value->>'stock')::numeric into v_stock
  from public.products p cross join lateral jsonb_array_elements(p.sizes) s(value)
  where p.id='p43-clean-product' and s.value->>'feet'='10';
  select used_count into v_used from public.promo_codes where id='p43-clean-promo';
  select count(*) into v_count from public.orders
  where user_id='43aa0000-0000-4000-8000-000000000001'::uuid;
  if v_stock<>1 or v_used<>1 or v_count<>1 then
    raise exception 'clean replay: commit mutations incorrect';
  end if;

  v_r2 := public.p43_commit_checkout(
    '43aa0000-0000-4000-8000-000000000001'::uuid,
    '43aa0000-0000-4000-8000-000000000010'::uuid,
    v_request,v_route,v_hash
  );
  if v_r2->>'orderId' <> v_order_id then raise exception 'clean replay: retry returned different order'; end if;

  select (s.value->>'stock')::numeric into v_stock
  from public.products p cross join lateral jsonb_array_elements(p.sizes) s(value)
  where p.id='p43-clean-product' and s.value->>'feet'='10';
  select used_count into v_used from public.promo_codes where id='p43-clean-promo';
  if v_stock<>1 or v_used<>1 then raise exception 'clean replay: retry mutated commerce twice'; end if;

  begin
    perform public.p43_commit_checkout(
      '43aa0000-0000-4000-8000-000000000001'::uuid,
      '43aa0000-0000-4000-8000-000000000010'::uuid,
      jsonb_set(v_request,'{items,0,quantity}','2'::jsonb),v_route,v_hash
    );
    raise exception 'clean replay: idempotency conflict did not fail';
  exception when sqlstate 'P4312' then null;
  end;

  begin
    perform public.p43_commit_checkout(
      '43aa0000-0000-4000-8000-000000000001'::uuid,
      '43aa0000-0000-4000-8000-000000000011'::uuid,
      jsonb_set(v_request,'{items,0,quantity}','99'::jsonb),v_route,v_hash
    );
    raise exception 'clean replay: insufficient stock did not fail';
  exception when sqlstate 'P4304' then null;
  end;

  select count(*) into v_count from dagoldol_private.checkout_requests
  where user_id='43aa0000-0000-4000-8000-000000000001'::uuid
    and idempotency_key='43aa0000-0000-4000-8000-000000000011'::uuid;
  if v_count<>0 then raise exception 'clean replay: failed checkout retained idempotency state'; end if;
end $$;

reset role;
rollback;

select 'PASS'::text as phase43_clean_replay_behavior_status;
