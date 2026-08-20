-- DAGOLDOL PHASE 4.3 — SERVER-AUTHORITATIVE CHECKOUT & TRANSACTIONAL INVENTORY
-- Additive Stage A migration. This migration is designed to run only after the verified Phase 4.2B baseline.
-- It does not revoke the legacy browser compatibility path; that is a separate post-cutover migration.

begin;

create schema if not exists dagoldol_private authorization postgres;
revoke all on schema dagoldol_private from public, anon, authenticated;
grant usage on schema dagoldol_private to service_role;

alter table public.orders
  add column if not exists delivery_quote jsonb;

create table if not exists dagoldol_private.delivery_config (
  id boolean primary key default true check (id),
  free_km_threshold numeric(10,3) not null check (free_km_threshold >= 0),
  rate_per_km numeric(12,2) not null check (rate_per_km >= 0),
  fallback_fee numeric(12,2) not null check (fallback_fee >= 0),
  updated_at timestamptz not null default now()
);

insert into dagoldol_private.delivery_config(id, free_km_threshold, rate_per_km, fallback_fee)
values (true, 5, 60, 600)
on conflict (id) do update
set free_km_threshold = excluded.free_km_threshold,
    rate_per_km = excluded.rate_per_km,
    fallback_fee = excluded.fallback_fee,
    updated_at = now();

create table if not exists dagoldol_private.delivery_free_zones (
  id text primary key,
  name text not null,
  latitude numeric(9,6) not null check (latitude between -90 and 90),
  longitude numeric(9,6) not null check (longitude between -180 and 180),
  radius_km numeric(10,3) not null default 5 check (radius_km >= 0),
  active boolean not null default true
);

insert into dagoldol_private.delivery_free_zones(id, name, latitude, longitude, radius_km, active)
values
  ('katipunan-nhs-arakan', 'Katipunan National High School, Arakan', 7.423760, 125.233630, 5, true),
  ('kimasog-marilog', 'Kimasog / Crossing Quimasog, Marilog', 7.316345, 125.299076, 5, true)
on conflict (id) do update
set name = excluded.name,
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    radius_km = excluded.radius_km,
    active = excluded.active;

create table if not exists dagoldol_private.checkout_requests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key uuid not null,
  request_fingerprint text not null check (length(request_fingerprint) = 64),
  order_id text null references public.orders(id) on delete restrict,
  response_json jsonb null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  primary key (user_id, idempotency_key),
  check ((completed_at is null and order_id is null and response_json is null)
      or (completed_at is not null and order_id is not null and response_json is not null))
);

create index if not exists checkout_requests_order_id_idx
  on dagoldol_private.checkout_requests(order_id)
  where order_id is not null;

alter table dagoldol_private.checkout_requests enable row level security;
alter table dagoldol_private.delivery_config enable row level security;
alter table dagoldol_private.delivery_free_zones enable row level security;

revoke all on table dagoldol_private.checkout_requests,
                    dagoldol_private.delivery_config,
                    dagoldol_private.delivery_free_zones
from public, anon, authenticated;

grant select, insert, update on dagoldol_private.checkout_requests to service_role;
grant select, update on dagoldol_private.delivery_config, dagoldol_private.delivery_free_zones to service_role;

create or replace function dagoldol_private.p43_delivery_config_hash()
returns text
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  v_origin_lat numeric;
  v_origin_lon numeric;
  v_free_km numeric;
  v_rate numeric;
  v_fallback numeric;
  v_zones jsonb;
  v_config jsonb;
begin
  begin
    select nullif(trim(s.value),'')::numeric into v_origin_lat
      from public.settings s where s.key='delivery_origin_latitude';
    select nullif(trim(s.value),'')::numeric into v_origin_lon
      from public.settings s where s.key='delivery_origin_longitude';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Phase 4.3 delivery origin settings are not numeric.' using errcode='P4315';
  end;

  if v_origin_lat is null or v_origin_lon is null
     or lower(v_origin_lat::text) in ('nan','infinity','-infinity')
     or lower(v_origin_lon::text) in ('nan','infinity','-infinity')
     or v_origin_lat < -90 or v_origin_lat > 90
     or v_origin_lon < -180 or v_origin_lon > 180 then
    raise exception 'Phase 4.3 delivery origin settings are missing or invalid.' using errcode='P4315';
  end if;

  select dc.free_km_threshold, dc.rate_per_km, dc.fallback_fee
    into v_free_km, v_rate, v_fallback
  from dagoldol_private.delivery_config dc where dc.id=true;
  if not found then
    raise exception 'Phase 4.3 delivery configuration is missing.' using errcode='P4315';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',z.id,'name',z.name,'latitude',round(z.latitude,6),
        'longitude',round(z.longitude,6),'radiusKm',round(z.radius_km,3)
      ) order by z.id
    ), '[]'::jsonb
  ) into v_zones
  from dagoldol_private.delivery_free_zones z where z.active=true;

  v_config := jsonb_build_object(
    'originLatitude',round(v_origin_lat,6),
    'originLongitude',round(v_origin_lon,6),
    'freeKmThreshold',round(v_free_km,3),
    'ratePerKm',round(v_rate,2),
    'fallbackFee',round(v_fallback,2),
    'zones',v_zones
  );

  return pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_config::text,'UTF8'),'sha256'),
    'hex'
  );
end;
$$;

create or replace function dagoldol_private.p43_request_fingerprint(p_normalized jsonb)
returns text
language sql
immutable
security invoker
set search_path=''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_normalized::text,'UTF8'),'sha256'),
    'hex'
  );
$$;

create or replace function dagoldol_private.p43_normalize_request(
  p_request jsonb,
  p_include_payment boolean
)
returns jsonb
language plpgsql
immutable
security invoker
set search_path=''
as $$
declare
  v_items jsonb;
  v_item jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_normalized_items jsonb;
  v_kind text;
  v_product_id text;
  v_bundle_id text;
  v_variant text;
  v_quantity numeric;
  v_delivery jsonb;
  v_location jsonb;
  v_name text;
  v_phone text;
  v_address text;
  v_city text;
  v_postal text;
  v_landmark text;
  v_latitude numeric;
  v_longitude numeric;
  v_accuracy numeric;
  v_normalized_delivery jsonb;
  v_promo_code text;
  v_half_payment boolean := false;
  v_payment jsonb;
  v_payment_method text;
  v_payment_reference text;
  v_proof_path text;
  v_save_address boolean := false;
  v_result jsonb;
begin
  if p_request is null
     or jsonb_typeof(p_request) <> 'object'
     or pg_catalog.octet_length(p_request::text) > 65536 then
    raise exception 'Checkout request must be a JSON object within the allowed size.' using errcode='P4315';
  end if;

  v_items := p_request->'items';
  if v_items is null or jsonb_typeof(v_items) <> 'array'
     or jsonb_array_length(v_items) < 1 or jsonb_array_length(v_items) > 100 then
    raise exception 'Checkout must contain between 1 and 100 semantic item lines.' using errcode='P4315';
  end if;

  for v_item in select value from jsonb_array_elements(v_items)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each checkout item must be a JSON object.' using errcode='P4315';
    end if;

    v_kind := lower(trim(coalesce(v_item->>'kind','')));
    begin
      v_quantity := nullif(trim(v_item->>'quantity'),'')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Item quantity must be a positive integer.' using errcode='P4315';
    end;

    if v_quantity is null or lower(v_quantity::text) in ('nan','infinity','-infinity')
       or v_quantity <= 0 or v_quantity <> trunc(v_quantity) or v_quantity > 10000 then
      raise exception 'Item quantity must be an integer from 1 to 10000.' using errcode='P4315';
    end if;

    if v_kind='product' then
      v_product_id := nullif(trim(v_item->>'productId'),'');
      v_variant := nullif(trim(v_item->>'variant'),'');
      if v_product_id is null or length(v_product_id)>120
         or v_variant is null or length(v_variant)>120 then
        raise exception 'Product identifier and variant are required.' using errcode='P4315';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'kind','product','productId',v_product_id,'variant',v_variant,'quantity',v_quantity
      ));
    elsif v_kind='bundle' then
      v_bundle_id := nullif(trim(v_item->>'bundleId'),'');
      if v_bundle_id is null or length(v_bundle_id)>120 then
        raise exception 'Bundle identifier is required.' using errcode='P4315';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'kind','bundle','bundleId',v_bundle_id,'quantity',v_quantity
      ));
    else
      raise exception 'Item kind must be product or bundle.' using errcode='P4315';
    end if;
  end loop;

  select coalesce(jsonb_agg(
    case when q.kind='product' then
      jsonb_build_object('kind','product','productId',q.product_id,'variant',q.variant,'quantity',q.quantity)
    else
      jsonb_build_object('kind','bundle','bundleId',q.bundle_id,'quantity',q.quantity)
    end
    order by q.kind,coalesce(q.product_id,q.bundle_id),coalesce(q.variant,'')
  ), '[]'::jsonb)
  into v_normalized_items
  from (
    select line->>'kind' as kind,
           nullif(line->>'productId','') as product_id,
           nullif(line->>'bundleId','') as bundle_id,
           nullif(line->>'variant','') as variant,
           sum((line->>'quantity')::numeric) as quantity
    from jsonb_array_elements(v_lines) line
    group by line->>'kind',line->>'productId',line->>'bundleId',line->>'variant'
  ) q;

  if exists (
    select 1 from jsonb_array_elements(v_normalized_items) line
    where (line->>'quantity')::numeric > 10000
  ) then
    raise exception 'Aggregated item quantity exceeds 10000.' using errcode='P4315';
  end if;

  v_delivery := p_request->'delivery';
  if v_delivery is null or jsonb_typeof(v_delivery) <> 'object' then
    raise exception 'Delivery details are required.' using errcode='P4315';
  end if;

  v_name := trim(coalesce(v_delivery->>'name',''));
  v_phone := trim(coalesce(v_delivery->>'phone',''));
  v_address := trim(coalesce(v_delivery->>'address',''));
  v_city := trim(coalesce(v_delivery->>'city',''));
  v_postal := trim(coalesce(v_delivery->>'postal',''));
  v_landmark := trim(coalesce(v_delivery->>'landmark',''));

  if v_name='' or v_phone='' or v_address='' or v_city='' or v_postal='' then
    raise exception 'Name, phone, street, city and postal code are required.' using errcode='P4315';
  end if;
  if length(v_name)>200 or length(v_phone)>50 or length(v_address)>500
     or length(v_city)>200 or length(v_postal)>50 or length(v_landmark)>500 then
    raise exception 'Delivery text exceeds allowed length.' using errcode='P4315';
  end if;

  v_location := v_delivery->'location';
  if v_location is null or jsonb_typeof(v_location)<>'object'
     or jsonb_typeof(v_location->'confirmed') is distinct from 'boolean'
     or not coalesce((v_location->>'confirmed')::boolean,false) then
    raise exception 'A confirmed delivery map pin is required.' using errcode='P4314';
  end if;

  begin
    v_latitude := nullif(trim(v_location->>'latitude'),'')::numeric;
    v_longitude := nullif(trim(v_location->>'longitude'),'')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Delivery coordinates are invalid.' using errcode='P4314';
  end;

  if v_latitude is null or v_longitude is null
     or lower(v_latitude::text) in ('nan','infinity','-infinity')
     or lower(v_longitude::text) in ('nan','infinity','-infinity')
     or v_latitude<4.0 or v_latitude>21.5 or v_longitude<116.0 or v_longitude>127.5 then
    raise exception 'Confirmed delivery coordinates are outside the supported Philippine map envelope.' using errcode='P4314';
  end if;

  if v_location ? 'accuracy' and jsonb_typeof(v_location->'accuracy') <> 'null' then
    begin
      v_accuracy := nullif(trim(v_location->>'accuracy'),'')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Location accuracy is invalid.' using errcode='P4315';
    end;
    if v_accuracy is null or lower(v_accuracy::text) in ('nan','infinity','-infinity')
       or v_accuracy<0 or v_accuracy>100000 then
      raise exception 'Location accuracy is invalid.' using errcode='P4315';
    end if;
  else
    v_accuracy := null;
  end if;

  v_normalized_delivery := jsonb_build_object(
    'name',v_name,'phone',v_phone,'address',v_address,'city',v_city,
    'postal',v_postal,'landmark',v_landmark,
    'location',jsonb_strip_nulls(jsonb_build_object(
      'latitude',round(v_latitude,6),'longitude',round(v_longitude,6),
      'confirmed',true,'accuracy',case when v_accuracy is null then null else round(v_accuracy,2) end
    ))
  );

  v_promo_code := nullif(upper(trim(coalesce(p_request->>'promoCode',''))),'');
  if v_promo_code is not null and length(v_promo_code)>100 then
    raise exception 'Promo code is too long.' using errcode='P4315';
  end if;

  if p_include_payment then
    v_payment := p_request->'payment';
    if v_payment is null or jsonb_typeof(v_payment)<>'object' then
      raise exception 'Payment details are required for commit.' using errcode='P4315';
    end if;
    v_payment_method := nullif(lower(trim(coalesce(v_payment->>'method',''))),'');
    v_payment_reference := nullif(trim(coalesce(v_payment->>'reference','')),'');
    v_proof_path := nullif(trim(coalesce(v_payment->>'proofPath','')),'');

    if v_payment ? 'halfPayment' then
      if jsonb_typeof(v_payment->'halfPayment') is distinct from 'boolean' then
        raise exception 'halfPayment must be boolean.' using errcode='P4315';
      end if;
      v_half_payment := (v_payment->>'halfPayment')::boolean;
    end if;

    if p_request ? 'saveAddress' then
      if jsonb_typeof(p_request->'saveAddress') is distinct from 'boolean' then
        raise exception 'saveAddress must be boolean.' using errcode='P4315';
      end if;
      v_save_address := (p_request->>'saveAddress')::boolean;
    end if;

    v_result := jsonb_build_object(
      'items',v_normalized_items,'delivery',v_normalized_delivery,'promoCode',v_promo_code,
      'halfPayment',v_half_payment,
      'payment',jsonb_build_object('method',v_payment_method,'reference',v_payment_reference,
                                   'proofPath',v_proof_path,'halfPayment',v_half_payment),
      'saveAddress',v_save_address
    );
  else
    if p_request ? 'halfPayment' then
      if jsonb_typeof(p_request->'halfPayment') is distinct from 'boolean' then
        raise exception 'halfPayment must be boolean.' using errcode='P4315';
      end if;
      v_half_payment := (p_request->>'halfPayment')::boolean;
    end if;
    v_result := jsonb_build_object(
      'items',v_normalized_items,'delivery',v_normalized_delivery,
      'promoCode',v_promo_code,'halfPayment',v_half_payment
    );
  end if;

  return v_result;
end;
$$;

create or replace function dagoldol_private.p43_lock_flash_sale_product()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare v_product_id text;
begin
  if tg_op='INSERT' then
    if new.product_id is not null then perform 1 from public.products p where p.id=new.product_id for update; end if;
    return new;
  elsif tg_op='DELETE' then
    if old.product_id is not null then perform 1 from public.products p where p.id=old.product_id for update; end if;
    return old;
  end if;

  for v_product_id in
    select distinct product_id from (
      select old.product_id as product_id
      union all
      select new.product_id as product_id
    ) ids
    where product_id is not null
    order by product_id
  loop
    perform 1 from public.products p where p.id=v_product_id for update;
  end loop;
  return new;
end;
$$;

drop trigger if exists p43_flash_sales_lock_product on public.flash_sales;
create trigger p43_flash_sales_lock_product
before insert or update or delete on public.flash_sales
for each row execute function dagoldol_private.p43_lock_flash_sale_product();

create or replace function dagoldol_private.p43_resolve_checkout(
  p_user_id uuid,
  p_request jsonb,
  p_route jsonb,
  p_config_hash text,
  p_lock_commerce boolean
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_now_ms bigint := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  v_username text;
  v_current_hash text;
  v_origin_lat numeric;
  v_origin_lon numeric;
  v_free_km numeric;
  v_rate numeric;
  v_fallback numeric;
  v_item jsonb;
  v_component jsonb;
  v_bundle public.bundles%rowtype;
  v_product public.products%rowtype;
  v_size jsonb;
  v_components jsonb;
  v_product_ids jsonb := '[]'::jsonb;
  v_stock_lines_raw jsonb := '[]'::jsonb;
  v_stock_lines jsonb := '[]'::jsonb;
  v_canonical_items jsonb := '[]'::jsonb;
  v_quantity numeric;
  v_component_qty numeric;
  v_size_price numeric;
  v_line_price numeric;
  v_sale_count integer;
  v_sale_discount numeric;
  v_subtotal numeric := 0;
  v_total_qty numeric := 0;
  v_bulk_rate numeric := 0;
  v_bulk_fee numeric := 0;
  v_promo public.promo_codes%rowtype;
  v_promo_code text;
  v_promo_discount numeric := 0;
  v_main jsonb;
  v_main_ok boolean := false;
  v_main_km numeric;
  v_route_source text;
  v_zone_measurement jsonb;
  v_zone_radius numeric;
  v_zone_km numeric;
  v_matched_zone_id text;
  v_delivery_fee numeric;
  v_delivery_reason text;
  v_delivery_snapshot jsonb;
  v_total numeric;
  v_half_payment boolean;
  v_due_now numeric;
  v_due_later numeric;
  v_stock_line jsonb;
  v_current_stock numeric;
begin
  if p_user_id is null then raise exception 'Authenticated customer identity is required.' using errcode='P4315'; end if;
  select p.username into v_username from public.profiles p where p.id=p_user_id;
  if v_username is null then raise exception 'Customer profile does not exist.' using errcode='P4315'; end if;

  if p_request is null or jsonb_typeof(p_request)<>'object'
     or p_request->'items' is null or jsonb_typeof(p_request->'items')<>'array'
     or p_request->'delivery' is null or jsonb_typeof(p_request->'delivery')<>'object' then
    raise exception 'Normalized checkout request is invalid.' using errcode='P4315';
  end if;
  if p_route is null or jsonb_typeof(p_route)<>'object' then
    raise exception 'Trusted route measurements are invalid.' using errcode='P4315';
  end if;

  if p_lock_commerce then
    perform 1 from dagoldol_private.delivery_config dc where dc.id=true for share;
    perform 1 from public.settings s where s.key in ('delivery_origin_latitude','delivery_origin_longitude') order by s.key for share;
    perform 1 from dagoldol_private.delivery_free_zones z where z.active=true order by z.id for share;
  end if;

  v_current_hash := dagoldol_private.p43_delivery_config_hash();
  if p_config_hash is null or p_config_hash is distinct from v_current_hash then
    raise exception 'Delivery configuration changed; refresh routing configuration.' using errcode='P4313';
  end if;

  begin
    select nullif(trim(s.value),'')::numeric into v_origin_lat from public.settings s where s.key='delivery_origin_latitude';
    select nullif(trim(s.value),'')::numeric into v_origin_lon from public.settings s where s.key='delivery_origin_longitude';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Delivery origin is invalid.' using errcode='P4315';
  end;
  if v_origin_lat is null or v_origin_lon is null
     or lower(v_origin_lat::text) in ('nan','infinity','-infinity')
     or lower(v_origin_lon::text) in ('nan','infinity','-infinity')
     or v_origin_lat < -90 or v_origin_lat > 90 or v_origin_lon < -180 or v_origin_lon > 180 then
    raise exception 'Delivery origin is invalid.' using errcode='P4315';
  end if;

  select dc.free_km_threshold,dc.rate_per_km,dc.fallback_fee into v_free_km,v_rate,v_fallback
    from dagoldol_private.delivery_config dc where dc.id=true;
  if not found then raise exception 'Delivery configuration is missing.' using errcode='P4315'; end if;

  if p_lock_commerce then
    perform 1 from public.bundles b
    where b.id in (
      select line->>'bundleId' from jsonb_array_elements(p_request->'items') line where line->>'kind'='bundle'
    ) order by b.id for update;
  end if;

  for v_item in select value from jsonb_array_elements(p_request->'items')
  loop
    if v_item->>'kind'='product' then
      v_product_ids := v_product_ids || jsonb_build_array(v_item->>'productId');
    elsif v_item->>'kind'='bundle' then
      select b.* into v_bundle from public.bundles b where b.id=v_item->>'bundleId';
      if not found or not v_bundle.active or v_bundle.items is null or jsonb_typeof(v_bundle.items)<>'array'
         or jsonb_array_length(v_bundle.items)=0 or v_bundle.bundle_price is null
         or lower(v_bundle.bundle_price::text) in ('nan','infinity','-infinity') or v_bundle.bundle_price<=0 then
        raise exception 'Bundle is unavailable or invalid.' using errcode='P4303';
      end if;
      for v_component in select value from jsonb_array_elements(v_bundle.items)
      loop
        if jsonb_typeof(v_component)<>'object' or nullif(trim(v_component->>'productId'),'') is null
           or nullif(trim(v_component->>'feet'),'') is null then
          raise exception 'Bundle contains an invalid component.' using errcode='P4303';
        end if;
        begin v_component_qty := nullif(trim(v_component->>'qty'),'')::numeric;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'Bundle contains an invalid component quantity.' using errcode='P4303';
        end;
        if v_component_qty is null or lower(v_component_qty::text) in ('nan','infinity','-infinity')
           or v_component_qty<=0 or v_component_qty<>trunc(v_component_qty) or v_component_qty>10000 then
          raise exception 'Bundle contains an invalid component quantity.' using errcode='P4303';
        end if;
        v_product_ids := v_product_ids || jsonb_build_array(v_component->>'productId');
      end loop;
    else
      raise exception 'Normalized checkout item kind is invalid.' using errcode='P4315';
    end if;
  end loop;

  if p_lock_commerce then
    perform 1 from public.products p
    where p.id in (select distinct value from jsonb_array_elements_text(v_product_ids))
    order by p.id for update;
  end if;

  for v_item in select value from jsonb_array_elements(p_request->'items')
  loop
    begin v_quantity := (v_item->>'quantity')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Normalized item quantity is invalid.' using errcode='P4315';
    end;
    if v_quantity is null or v_quantity<=0 or v_quantity<>trunc(v_quantity) or v_quantity>10000 then
      raise exception 'Normalized item quantity is invalid.' using errcode='P4315';
    end if;

    if v_item->>'kind'='product' then
      select p.* into v_product from public.products p where p.id=v_item->>'productId';
      if not found then raise exception 'Product is unavailable.' using errcode='P4301'; end if;
      select s.value into v_size from jsonb_array_elements(coalesce(v_product.sizes,'[]'::jsonb)) s(value)
      where s.value->>'feet'=v_item->>'variant' limit 1;
      if v_size is null then raise exception 'Product variant is unavailable.' using errcode='P4302'; end if;
      begin v_size_price := nullif(trim(v_size->>'price'),'')::numeric;
      exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'Product variant price is invalid.' using errcode='P4315';
      end;
      if v_size_price is null or lower(v_size_price::text) in ('nan','infinity','-infinity') or v_size_price<0 then
        raise exception 'Product variant price is invalid.' using errcode='P4315';
      end if;

      select count(*)::integer,max(fs.discount_percent) into v_sale_count,v_sale_discount
      from public.flash_sales fs
      where fs.product_id=v_product.id and fs.active=true and fs.start_at<=v_now_ms and fs.end_at>=v_now_ms;
      if v_sale_count>1 then raise exception 'Multiple overlapping flash sales exist for one product.' using errcode='P4315'; end if;
      if v_sale_count=1 then
        if v_sale_discount is null or lower(v_sale_discount::text) in ('nan','infinity','-infinity')
           or v_sale_discount<0 or v_sale_discount>100 then
          raise exception 'Flash sale discount is invalid.' using errcode='P4315';
        end if;
        v_line_price := round(greatest(0,v_size_price*(1-(v_sale_discount/100))),2);
      else
        v_line_price := round(v_size_price,2);
      end if;

      v_canonical_items := v_canonical_items || jsonb_build_array(jsonb_build_object(
        'productId',v_product.id,'feet',v_size->'feet',
        'name',v_product.name || ' (' || case
          when v_product.unit_type='size' then v_size->>'feet'
          when v_product.unit_type='sqm' then (v_size->>'feet') || ' sqm'
          else (v_size->>'feet') || ' ft' end || ')',
        'price',v_line_price,'qty',v_quantity
      ));
      v_stock_lines_raw := v_stock_lines_raw || jsonb_build_array(jsonb_build_object(
        'productId',v_product.id,'feet',v_size->>'feet','qty',v_quantity
      ));
    else
      select b.* into v_bundle from public.bundles b where b.id=v_item->>'bundleId';
      if not found or not v_bundle.active or v_bundle.items is null or jsonb_typeof(v_bundle.items)<>'array'
         or jsonb_array_length(v_bundle.items)=0 or v_bundle.bundle_price is null
         or lower(v_bundle.bundle_price::text) in ('nan','infinity','-infinity') or v_bundle.bundle_price<=0 then
        raise exception 'Bundle price or components are invalid.' using errcode='P4303';
      end if;
      v_line_price := round(v_bundle.bundle_price,2);
      v_components := '[]'::jsonb;
      for v_component in select value from jsonb_array_elements(v_bundle.items)
      loop
        begin v_component_qty := nullif(trim(v_component->>'qty'),'')::numeric;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'Bundle component quantity is invalid.' using errcode='P4303';
        end;
        if v_component_qty is null or v_component_qty<=0 or v_component_qty<>trunc(v_component_qty) or v_component_qty>10000 then
          raise exception 'Bundle component quantity is invalid.' using errcode='P4303';
        end if;
        select p.* into v_product from public.products p where p.id=v_component->>'productId';
        if not found then raise exception 'Bundle component product is unavailable.' using errcode='P4303'; end if;
        select s.value into v_size from jsonb_array_elements(coalesce(v_product.sizes,'[]'::jsonb)) s(value)
        where s.value->>'feet'=v_component->>'feet' limit 1;
        if v_size is null then raise exception 'Bundle component variant is unavailable.' using errcode='P4303'; end if;
        v_components := v_components || jsonb_build_array(jsonb_build_object(
          'productId',v_product.id,'feet',v_size->'feet','qty',v_component_qty
        ));
        v_stock_lines_raw := v_stock_lines_raw || jsonb_build_array(jsonb_build_object(
          'productId',v_product.id,'feet',v_size->>'feet','qty',v_component_qty*v_quantity
        ));
      end loop;
      v_canonical_items := v_canonical_items || jsonb_build_array(jsonb_build_object(
        'isBundle',true,'bundleId',v_bundle.id,'name',v_bundle.name,
        'price',v_line_price,'qty',v_quantity,'components',v_components
      ));
    end if;

    v_subtotal := v_subtotal + round(v_line_price*v_quantity,2);
    v_total_qty := v_total_qty + v_quantity;
  end loop;

  v_subtotal := round(v_subtotal,2);
  if v_subtotal<=0 then raise exception 'Checkout has no positive-value items.' using errcode='P4315'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'productId',q.product_id,'feet',q.feet,'qty',q.qty
  ) order by q.product_id,q.feet),'[]'::jsonb)
  into v_stock_lines
  from (
    select line->>'productId' as product_id,line->>'feet' as feet,sum((line->>'qty')::numeric) as qty
    from jsonb_array_elements(v_stock_lines_raw) line
    group by line->>'productId',line->>'feet'
  ) q;

  if p_lock_commerce then
    for v_stock_line in select value from jsonb_array_elements(v_stock_lines)
    loop
      select p.* into v_product from public.products p where p.id=v_stock_line->>'productId';
      select s.value into v_size from jsonb_array_elements(coalesce(v_product.sizes,'[]'::jsonb)) s(value)
      where s.value->>'feet'=v_stock_line->>'feet' limit 1;
      if v_size ? 'stock' and jsonb_typeof(v_size->'stock')<>'null' then
        begin v_current_stock := (v_size->>'stock')::numeric;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'Inventory value is invalid.' using errcode='P4315';
        end;
        if lower(v_current_stock::text) in ('nan','infinity','-infinity') or v_current_stock<0 then
          raise exception 'Inventory value is invalid.' using errcode='P4315';
        end if;
        if v_current_stock < (v_stock_line->>'qty')::numeric then
          raise exception 'Insufficient stock.' using errcode='P4304';
        end if;
      end if;
    end loop;
  end if;

  if v_total_qty>=256 then v_bulk_rate:=0.02;
  elsif v_total_qty>=250 then v_bulk_rate:=0.05;
  else v_bulk_rate:=0;
  end if;
  v_bulk_fee := round(v_subtotal*v_bulk_rate,2);

  v_promo_code := nullif(trim(coalesce(p_request->>'promoCode','')),'');
  if v_promo_code is not null then
    if p_lock_commerce then
      select pc.* into v_promo from public.promo_codes pc
      where upper(trim(pc.code))=upper(v_promo_code) for update;
    else
      select pc.* into v_promo from public.promo_codes pc
      where upper(trim(pc.code))=upper(v_promo_code);
    end if;
    if not found then raise exception 'Promo code not found.' using errcode='P4305'; end if;
    if not v_promo.active then raise exception 'Promo code is inactive.' using errcode='P4306'; end if;
    if v_promo.expires_at is not null and v_now_ms>v_promo.expires_at then raise exception 'Promo code has expired.' using errcode='P4307'; end if;
    if v_promo.max_uses is not null and v_promo.used_count>=v_promo.max_uses then raise exception 'Promo code is exhausted.' using errcode='P4308'; end if;
    if v_subtotal<coalesce(v_promo.min_spend,0) then raise exception 'Promo minimum spend is not met.' using errcode='P4309'; end if;
    if v_promo.value is null or lower(v_promo.value::text) in ('nan','infinity','-infinity') or v_promo.value<0 then raise exception 'Promo value is invalid.' using errcode='P4315'; end if;
    if v_promo.discount_type='percent' then
      if v_promo.value>100 then raise exception 'Promo percentage is invalid.' using errcode='P4315'; end if;
      v_promo_discount := round(v_subtotal*(v_promo.value/100),2);
    elsif v_promo.discount_type='fixed' then
      v_promo_discount := round(v_promo.value,2);
    else
      raise exception 'Promo discount type is invalid.' using errcode='P4315';
    end if;
    v_promo_discount := round(greatest(0,least(v_promo_discount,v_subtotal)),2);
  else
    v_promo_discount := 0;
  end if;

  v_route_source := nullif(trim(coalesce(p_route->>'source','')),'');
  v_main := p_route->'main';
  if v_main is null or jsonb_typeof(v_main)<>'object' or jsonb_typeof(v_main->'ok') is distinct from 'boolean' then
    raise exception 'Main route result is invalid.' using errcode='P4315';
  end if;
  v_main_ok := (v_main->>'ok')::boolean;
  if v_main_ok then
    begin v_main_km := nullif(trim(v_main->>'roadDistanceKm'),'')::numeric;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Main route distance is invalid.' using errcode='P4315';
    end;
    if v_main_km is null or lower(v_main_km::text) in ('nan','infinity','-infinity') or v_main_km<0 or v_main_km>10000 then
      raise exception 'Main route distance is invalid.' using errcode='P4315';
    end if;
  else
    v_main_km := null;
  end if;

  if p_route ? 'freeZones' and jsonb_typeof(p_route->'freeZones')<>'array' then
    raise exception 'Free-zone route results are invalid.' using errcode='P4315';
  end if;

  v_matched_zone_id := null;
  if v_main_ok and v_main_km>v_free_km then
    for v_zone_measurement in select value from jsonb_array_elements(coalesce(p_route->'freeZones','[]'::jsonb))
    loop
      if jsonb_typeof(v_zone_measurement)<>'object' or jsonb_typeof(v_zone_measurement->'ok') is distinct from 'boolean' then
        raise exception 'Free-zone route result is invalid.' using errcode='P4315';
      end if;
      if (v_zone_measurement->>'ok')::boolean then
        begin v_zone_km := nullif(trim(v_zone_measurement->>'roadDistanceKm'),'')::numeric;
        exception when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'Free-zone route distance is invalid.' using errcode='P4315';
        end;
        if v_zone_km is null or lower(v_zone_km::text) in ('nan','infinity','-infinity') or v_zone_km<0 or v_zone_km>10000 then
          raise exception 'Free-zone route distance is invalid.' using errcode='P4315';
        end if;
        select z.radius_km into v_zone_radius from dagoldol_private.delivery_free_zones z
        where z.active=true and z.id=v_zone_measurement->>'id';
        if found and v_zone_km<=v_zone_radius then v_matched_zone_id:=v_zone_measurement->>'id'; exit; end if;
      end if;
    end loop;
  end if;

  if not v_main_ok then v_delivery_fee:=round(v_fallback,2); v_delivery_reason:='fallback';
  elsif v_main_km<=v_free_km then v_delivery_fee:=0; v_delivery_reason:='origin_free_threshold';
  elsif v_matched_zone_id is not null then v_delivery_fee:=0; v_delivery_reason:='free_zone';
  else v_delivery_fee:=round(v_rate*v_main_km,2); v_delivery_reason:='distance_rate';
  end if;

  v_total := round(greatest(0,v_subtotal-v_promo_discount+v_delivery_fee+v_bulk_fee),2);
  v_half_payment := coalesce((p_request->>'halfPayment')::boolean,false);
  if v_half_payment then v_due_now:=round(v_total/2,2); v_due_later:=round(v_total-v_due_now,2);
  else v_due_now:=v_total; v_due_later:=0; end if;

  v_delivery_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'source',coalesce(v_route_source,case when v_main_ok then 'router' else 'fallback' end),
    'reason',v_delivery_reason,'configHash',v_current_hash,
    'origin',jsonb_build_object('latitude',round(v_origin_lat,6),'longitude',round(v_origin_lon,6)),
    'destination',p_request->'delivery'->'location',
    'mainRoadDistanceKm',case when v_main_km is null then null else round(v_main_km,3) end,
    'matchedFreeZoneId',v_matched_zone_id,
    'freeKmThreshold',round(v_free_km,3),'ratePerKm',round(v_rate,2),
    'fallbackFee',round(v_fallback,2),'finalFee',round(v_delivery_fee,2)
  ));

  return jsonb_build_object(
    'username',v_username,'items',v_canonical_items,'stockLines',v_stock_lines,
    'subtotal',round(v_subtotal,2),'bulkFeeRate',round(v_bulk_rate,2),'bulkFee',round(v_bulk_fee,2),
    'promoId',case when v_promo.id is null then null else v_promo.id end,
    'promoCode',case when v_promo.id is null then null else v_promo.code end,
    'promoDiscount',round(v_promo_discount,2),'deliveryFee',round(v_delivery_fee,2),
    'deliveryQuote',v_delivery_snapshot,'total',round(v_total,2),'halfPayment',v_half_payment,
    'amountDueNow',round(v_due_now,2),'amountDueLater',round(v_due_later,2),
    'address',p_request->'delivery','resolvedAt',v_now_ms
  );
end;
$$;

create or replace function public.p43_get_routing_config()
returns jsonb
language plpgsql
stable
security invoker
set search_path=''
as $$
declare
  v_origin_lat numeric;
  v_origin_lon numeric;
  v_free_km numeric;
  v_zones jsonb;
  v_hash text;
begin
  v_hash := dagoldol_private.p43_delivery_config_hash();
  begin
    select nullif(trim(s.value),'')::numeric into v_origin_lat from public.settings s where s.key='delivery_origin_latitude';
    select nullif(trim(s.value),'')::numeric into v_origin_lon from public.settings s where s.key='delivery_origin_longitude';
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Delivery origin is invalid.' using errcode='P4315';
  end;
  if v_origin_lat is null or v_origin_lon is null
     or lower(v_origin_lat::text) in ('nan','infinity','-infinity')
     or lower(v_origin_lon::text) in ('nan','infinity','-infinity')
     or v_origin_lat<-90 or v_origin_lat>90 or v_origin_lon<-180 or v_origin_lon>180 then
    raise exception 'Delivery origin is invalid.' using errcode='P4315';
  end if;
  select dc.free_km_threshold into v_free_km from dagoldol_private.delivery_config dc where dc.id=true;
  if not found then raise exception 'Delivery configuration is missing.' using errcode='P4315'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',z.id,'name',z.name,'latitude',round(z.latitude,6),
    'longitude',round(z.longitude,6),'radiusKm',round(z.radius_km,3)
  ) order by z.id),'[]'::jsonb)
  into v_zones from dagoldol_private.delivery_free_zones z where z.active=true;
  return jsonb_build_object(
    'origin',jsonb_build_object('latitude',round(v_origin_lat,6),'longitude',round(v_origin_lon,6)),
    'freeKmThreshold',round(v_free_km,3),'freeZones',v_zones,'configHash',v_hash
  );
end;
$$;

create or replace function public.p43_quote_checkout(
  p_user_id uuid,
  p_request jsonb,
  p_route jsonb,
  p_config_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare v_normalized jsonb; v_resolved jsonb;
begin
  if p_user_id is null then raise exception 'Customer identity is required.' using errcode='P4315'; end if;
  v_normalized := dagoldol_private.p43_normalize_request(p_request,false);
  v_resolved := dagoldol_private.p43_resolve_checkout(p_user_id,v_normalized,p_route,p_config_hash,false);
  return jsonb_build_object(
    'items',v_resolved->'items','subtotal',v_resolved->'subtotal',
    'bulkFeeRate',v_resolved->'bulkFeeRate','bulkFee',v_resolved->'bulkFee',
    'promoCode',v_resolved->'promoCode','promoDiscount',v_resolved->'promoDiscount',
    'deliveryFee',v_resolved->'deliveryFee','deliveryQuote',v_resolved->'deliveryQuote',
    'total',v_resolved->'total','halfPayment',v_resolved->'halfPayment',
    'amountDueNow',v_resolved->'amountDueNow','amountDueLater',v_resolved->'amountDueLater'
  );
end;
$$;

create or replace function public.p43_commit_checkout(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_request jsonb,
  p_route jsonb,
  p_config_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $$
declare
  v_normalized jsonb;
  v_fingerprint text;
  v_ledger dagoldol_private.checkout_requests%rowtype;
  v_payment jsonb;
  v_payment_method text;
  v_payment_reference text;
  v_payment_proof text;
  v_save_address boolean;
  v_resolved jsonb;
  v_order_id text;
  v_now_ms bigint;
  v_response jsonb;
  v_promo_id text;
  v_updated integer;
begin
  if p_user_id is null or p_idempotency_key is null then
    raise exception 'Customer identity and idempotency key are required.' using errcode='P4315';
  end if;

  v_normalized := dagoldol_private.p43_normalize_request(p_request,true);
  v_fingerprint := dagoldol_private.p43_request_fingerprint(v_normalized);

  insert into dagoldol_private.checkout_requests(user_id,idempotency_key,request_fingerprint)
  values(p_user_id,p_idempotency_key,v_fingerprint)
  on conflict(user_id,idempotency_key) do nothing;

  select cr.* into v_ledger from dagoldol_private.checkout_requests cr
  where cr.user_id=p_user_id and cr.idempotency_key=p_idempotency_key for update;
  if not found then raise exception 'Unable to claim checkout idempotency key.' using errcode='P4315'; end if;
  if v_ledger.request_fingerprint is distinct from v_fingerprint then
    raise exception 'Idempotency key was already used for different checkout intent.' using errcode='P4312';
  end if;
  if v_ledger.completed_at is not null then
    if v_ledger.response_json is null or v_ledger.order_id is null then
      raise exception 'Completed checkout ledger entry is inconsistent.' using errcode='P4315';
    end if;
    return v_ledger.response_json;
  end if;

  v_payment := v_normalized->'payment';
  v_payment_method := nullif(lower(trim(coalesce(v_payment->>'method',''))),'');
  v_payment_reference := nullif(trim(coalesce(v_payment->>'reference','')),'');
  v_payment_proof := nullif(trim(coalesce(v_payment->>'proofPath','')),'');
  v_save_address := coalesce((v_normalized->>'saveAddress')::boolean,false);

  if v_payment_method not in ('gcash','bank') then raise exception 'Unsupported payment method.' using errcode='P4315'; end if;
  if v_payment_reference is null or length(v_payment_reference)>200 then
    raise exception 'Payment reference is required and must not exceed 200 characters.' using errcode='P4310';
  end if;
  if v_payment_proof is not null and (length(v_payment_proof)>1024 or split_part(v_payment_proof,'/',1)<>p_user_id::text) then
    raise exception 'Payment proof must belong to the authenticated customer namespace.' using errcode='P4311';
  end if;

  v_resolved := dagoldol_private.p43_resolve_checkout(p_user_id,v_normalized,p_route,p_config_hash,true);

  begin
    perform dagoldol_private.apply_stock_lines(v_resolved->'stockLines',-1);
  exception when sqlstate '23514' then
    raise exception 'Insufficient stock.' using errcode='P4304';
  end;

  v_promo_id := nullif(v_resolved->>'promoId','');
  if v_promo_id is not null then
    update public.promo_codes pc set used_count=pc.used_count+1
    where pc.id=v_promo_id and (pc.max_uses is null or pc.used_count<pc.max_uses);
    get diagnostics v_updated=row_count;
    if v_updated<>1 then raise exception 'Promo code is exhausted.' using errcode='P4308'; end if;
  end if;

  v_order_id := 'ORD-' || upper(replace(extensions.gen_random_uuid()::text,'-',''));
  v_now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;

  insert into public.orders(
    id,user_id,username,items,subtotal,delivery_fee,bulk_fee_rate,bulk_fee,cod_fee,total,
    payment_method,payment_reference,payment_proof,half_payment,amount_due_now,amount_due_later,
    address,delivery_quote,placed_at,delivery_days,status_override,cancelled,rated,promo_code,promo_discount
  ) values(
    v_order_id,p_user_id,v_resolved->>'username',v_resolved->'items',
    (v_resolved->>'subtotal')::numeric,(v_resolved->>'deliveryFee')::numeric,
    (v_resolved->>'bulkFeeRate')::numeric,(v_resolved->>'bulkFee')::numeric,0,(v_resolved->>'total')::numeric,
    v_payment_method,v_payment_reference,v_payment_proof,(v_resolved->>'halfPayment')::boolean,
    (v_resolved->>'amountDueNow')::numeric,(v_resolved->>'amountDueLater')::numeric,
    v_resolved->'address',v_resolved->'deliveryQuote',v_now_ms,6,0,false,'{}'::jsonb,
    nullif(v_resolved->>'promoCode',''),(v_resolved->>'promoDiscount')::numeric
  );

  if v_save_address then
    update public.profiles p set address=v_resolved->'address' where p.id=p_user_id;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then raise exception 'Customer profile disappeared during checkout.' using errcode='P4315'; end if;
  end if;

  v_response := jsonb_build_object(
    'orderId',v_order_id,'items',v_resolved->'items','subtotal',v_resolved->'subtotal',
    'bulkFeeRate',v_resolved->'bulkFeeRate','bulkFee',v_resolved->'bulkFee',
    'promoCode',v_resolved->'promoCode','promoDiscount',v_resolved->'promoDiscount',
    'deliveryFee',v_resolved->'deliveryFee','deliveryQuote',v_resolved->'deliveryQuote',
    'total',v_resolved->'total','halfPayment',v_resolved->'halfPayment',
    'amountDueNow',v_resolved->'amountDueNow','amountDueLater',v_resolved->'amountDueLater','placedAt',v_now_ms
  );

  update dagoldol_private.checkout_requests cr
  set order_id=v_order_id,response_json=v_response,completed_at=now()
  where cr.user_id=p_user_id and cr.idempotency_key=p_idempotency_key;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'Checkout idempotency ledger completion failed.' using errcode='P4315'; end if;

  return v_response;
end;
$$;

revoke all on function dagoldol_private.p43_delivery_config_hash() from public, anon, authenticated;
revoke all on function dagoldol_private.p43_request_fingerprint(jsonb) from public, anon, authenticated;
revoke all on function dagoldol_private.p43_normalize_request(jsonb,boolean) from public, anon, authenticated;
revoke all on function dagoldol_private.p43_resolve_checkout(uuid,jsonb,jsonb,text,boolean) from public, anon, authenticated;
revoke all on function dagoldol_private.p43_lock_flash_sale_product() from public, anon, authenticated;

grant execute on function dagoldol_private.p43_delivery_config_hash() to service_role;
grant execute on function dagoldol_private.p43_request_fingerprint(jsonb) to service_role;
grant execute on function dagoldol_private.p43_normalize_request(jsonb,boolean) to service_role;
grant execute on function dagoldol_private.p43_resolve_checkout(uuid,jsonb,jsonb,text,boolean) to service_role;

-- SECURITY INVOKER RPCs require the trusted service role to hold the underlying lock/write privileges.
grant select, update on public.products to service_role;
grant select, update on public.bundles to service_role;
grant select, update on public.promo_codes to service_role;
grant select, update on public.flash_sales to service_role;
grant select, update on public.settings to service_role;
grant select, insert, update on public.orders to service_role;
grant select, update on public.profiles to service_role;
grant execute on function dagoldol_private.apply_stock_lines(jsonb,integer) to service_role;

revoke all on function public.p43_get_routing_config() from public, anon, authenticated;
revoke all on function public.p43_quote_checkout(uuid,jsonb,jsonb,text) from public, anon, authenticated;
revoke all on function public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text) from public, anon, authenticated;
grant execute on function public.p43_get_routing_config() to service_role;
grant execute on function public.p43_quote_checkout(uuid,jsonb,jsonb,text) to service_role;
grant execute on function public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text) to service_role;

commit;
