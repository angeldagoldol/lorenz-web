-- ============================================================================
-- DAGOLDOL PHASE 4.2A11 — PUBLIC DATABASE ZERO-TRUST RLS HARDENING
-- Version: 2026-08-20
-- Target: Supabase project rvrjkfbenramappteuae
--
-- STATUS: IMPLEMENTATION CANDIDATE — STAGING FIRST. DO NOT RUN IN PRODUCTION
-- until Phase 4.1 backup/deployment evidence is closed and the exact current
-- Dagoldol 3.3.5 frontend is paired with the profile-directory RPC changes.
--
-- This migration intentionally does NOT close the checkout/stock boundary.
-- The retrievable frontend still calls decrement_stock_for_order(),
-- restore_stock_for_order(), and direct orders INSERT/UPDATE. The exact 3.3.5
-- script.js is not available in the writable workspace, and the live
-- public.orders schema is inconsistent with the live place_order() body.
-- Phase 4.2B must remove those browser authorities before Phase 4.2 can close.
--
-- No business rows are deleted by this migration.
--
-- IMPORTANT HOSTED-SUPABASE OWNERSHIP NOTE:
-- This file intentionally does NOT ALTER storage.objects and does NOT CREATE or
-- DROP Storage policies. In this hosted project, storage.objects/storage.buckets
-- are owned by the managed supabase_storage_admin role while SQL Editor runs as
-- postgres. Storage policy hardening is therefore performed separately through
-- Storage -> Policies using the companion Phase 4.2A2 checklist.
-- ============================================================================

begin;

-- --------------------------------------------------------------------------
-- 0. Fail-closed preflight against the verified live contract.
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
      'activity','brands','bundles','chat_messages','chat_threads',
      'dm_messages','dm_threads','flash_sales','gift_card_transactions',
      'gift_cards','messages','orders','products','profiles','promo_codes',
      'ratings','settings','subscription_orders','subscriptions'
    ]) as r(required_name)
    where to_regclass('public.' || required_name) is null
  ) missing;

  if v_missing is not null then
    raise exception 'Phase 4.2A1 stopped: required public table(s) missing: %', v_missing;
  end if;

  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception 'Phase 4.2A1 stopped: Supabase Storage catalog is unavailable.';
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='is_admin') then
    raise exception 'Phase 4.2A1 stopped: public.is_admin() is missing.';
  end if;

  if not exists (select 1 from pg_trigger where tgrelid='public.profiles'::regclass and tgname='profiles_guard_role_client' and not tgisinternal) then
    raise exception 'Phase 4.2A1 stopped: profiles_guard_role_client trigger is missing.';
  end if;

  if not exists (select 1 from pg_trigger where tgrelid='public.orders'::regclass and tgname='orders_guard_customer_write' and not tgisinternal) then
    raise exception 'Phase 4.2A1 stopped: orders_guard_customer_write trigger is missing.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='role'
  ) then
    raise exception 'Phase 4.2A1 stopped: profiles.role is missing.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name='user_id'
  ) then
    raise exception 'Phase 4.2A1 stopped: orders.user_id is missing.';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='ratings' and column_name='user_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='ratings' and column_name='order_id'
  ) then
    raise exception 'Phase 4.2A1 stopped: Phase 3 ratings ownership columns are missing.';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='ratings' and indexname='ratings_order_product_unique'
  ) then
    raise exception 'Phase 4.2A1 stopped: ratings_order_product_unique is missing.';
  end if;

  if (select count(*) from storage.buckets where id in ('avatars','brand-logos','payment-proofs','payment-settings','product-images')) <> 5 then
    raise exception 'Phase 4.2A1 stopped: one or more expected Dagoldol Storage buckets are missing.';
  end if;

  if exists (
    select 1 from storage.buckets
    where id='payment-proofs' and public is distinct from false
  ) then
    raise exception 'Phase 4.2A1 stopped: payment-proofs must be a private bucket before policy hardening.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 1. Canonical admin predicate. Authorization data is sourced from the DB,
--    never user-editable JWT metadata. Fixed search_path blocks object-shadowing.
-- --------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as p
    where p.id = auth.uid()
      and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
revoke all on function public.is_admin() from authenticated;
grant execute on function public.is_admin() to authenticated;

-- --------------------------------------------------------------------------
-- 2. Safe cross-user directory commands. These are the only customer-facing
--    way to resolve another account. They deliberately return no address,
--    cart, profile JSON, email, phone, role, or other private profile fields.
-- --------------------------------------------------------------------------
create or replace function public.p42_lookup_profile_directory(p_username text)
returns table(id uuid, username text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username
  from public.profiles as p
  where auth.uid() is not null
    and length(trim(coalesce(p_username, ''))) between 1 and 120
    and lower(p.username) = lower(trim(p_username))
  limit 1;
$$;

revoke all on function public.p42_lookup_profile_directory(text) from public;
revoke all on function public.p42_lookup_profile_directory(text) from anon;
revoke all on function public.p42_lookup_profile_directory(text) from authenticated;
grant execute on function public.p42_lookup_profile_directory(text) to authenticated;

create or replace function public.p42_get_seller_directory_profile()
returns table(id uuid, username text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username
  from public.profiles as p
  where auth.uid() is not null
    and p.role = 'admin'
  order by p.created_at asc, p.id asc
  limit 1;
$$;

revoke all on function public.p42_get_seller_directory_profile() from public;
revoke all on function public.p42_get_seller_directory_profile() from anon;
revoke all on function public.p42_get_seller_directory_profile() from authenticated;
grant execute on function public.p42_get_seller_directory_profile() to authenticated;

-- --------------------------------------------------------------------------
-- 3. Direct-message field/state integrity.
--    RLS restricts rows. These triggers make participant identity, sender
--    identity, message body, and timestamps server-authoritative/immutable.
-- --------------------------------------------------------------------------
create or replace function public.p42_dm_reactions_without_user(
  p_reactions jsonb,
  p_user_id uuid
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_arr jsonb;
  v_filtered jsonb;
  v_result jsonb := '{}'::jsonb;
begin
  if p_reactions is null then
    return '{}'::jsonb;
  end if;

  if jsonb_typeof(p_reactions) <> 'object' then
    raise exception 'DM reactions must be a JSON object' using errcode='22023';
  end if;

  for v_key, v_arr in
    select key, value from jsonb_each(p_reactions)
  loop
    if jsonb_typeof(v_arr) <> 'array' then
      raise exception 'DM reaction values must be arrays' using errcode='22023';
    end if;

    if exists (
      select 1
      from jsonb_array_elements_text(v_arr) as item(value)
      where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
      raise exception 'DM reaction identities must be UUIDs' using errcode='22023';
    end if;

    select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
      into v_filtered
    from (
      select distinct value
      from jsonb_array_elements_text(v_arr) as item(value)
      where value <> p_user_id::text
    ) filtered;

    if jsonb_array_length(v_filtered) > 0 then
      v_result := jsonb_set(v_result, array[v_key], v_filtered, true);
    end if;
  end loop;

  return v_result;
end;
$$;

revoke all on function public.p42_dm_reactions_without_user(jsonb, uuid) from public;
revoke all on function public.p42_dm_reactions_without_user(jsonb, uuid) from anon;
revoke all on function public.p42_dm_reactions_without_user(jsonb, uuid) from authenticated;

create or replace function public.p42_guard_dm_thread_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_a uuid;
  v_b uuid;
  v_a_username text;
  v_b_username text;
  v_latest public.dm_messages%rowtype;
begin
  -- Trusted SQL/service operations are outside the browser-session guard.
  if v_uid is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.user_a_id is null or new.user_b_id is null or new.user_a_id = new.user_b_id then
      raise exception 'A DM thread requires two distinct participants' using errcode='22023';
    end if;

    if v_uid <> new.user_a_id and v_uid <> new.user_b_id then
      raise exception 'The authenticated user must be a DM participant' using errcode='42501';
    end if;

    if new.user_a_id::text < new.user_b_id::text then
      v_a := new.user_a_id;
      v_b := new.user_b_id;
    else
      v_a := new.user_b_id;
      v_b := new.user_a_id;
    end if;

    select p.username into v_a_username from public.profiles p where p.id=v_a;
    select p.username into v_b_username from public.profiles p where p.id=v_b;

    if v_a_username is null or v_b_username is null then
      raise exception 'Both DM participants must have Dagoldol profiles' using errcode='23503';
    end if;

    new.id := v_a::text || '::' || v_b::text;
    new.user_a_id := v_a;
    new.user_a_username := v_a_username;
    new.user_b_id := v_b;
    new.user_b_username := v_b_username;
    new.created_at := v_now_ms;
    new.last_message_at := null;
    new.last_message_preview := '';
    new.user_a_last_read_at := case when v_uid=v_a then v_now_ms else null end;
    new.user_b_last_read_at := case when v_uid=v_b then v_now_ms else null end;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.user_a_id is distinct from old.user_a_id
     or new.user_b_id is distinct from old.user_b_id
     or new.user_a_username is distinct from old.user_a_username
     or new.user_b_username is distinct from old.user_b_username
     or new.created_at is distinct from old.created_at then
    raise exception 'DM participant identity and creation metadata are immutable' using errcode='42501';
  end if;

  if v_uid <> old.user_a_id and v_uid <> old.user_b_id then
    raise exception 'Only DM participants may update a thread' using errcode='42501';
  end if;

  if v_uid = old.user_a_id and new.user_b_last_read_at is distinct from old.user_b_last_read_at then
    raise exception 'A participant cannot alter the other participant read marker' using errcode='42501';
  end if;
  if v_uid = old.user_b_id and new.user_a_last_read_at is distinct from old.user_a_last_read_at then
    raise exception 'A participant cannot alter the other participant read marker' using errcode='42501';
  end if;

  if v_uid = old.user_a_id and new.user_a_last_read_at is distinct from old.user_a_last_read_at then
    new.user_a_last_read_at := v_now_ms;
  end if;
  if v_uid = old.user_b_id and new.user_b_last_read_at is distinct from old.user_b_last_read_at then
    new.user_b_last_read_at := v_now_ms;
  end if;

  if new.last_message_at is distinct from old.last_message_at
     or new.last_message_preview is distinct from old.last_message_preview then
    select m.*
      into v_latest
    from public.dm_messages m
    where m.thread_id=old.id
    order by m.sent_at desc, m.id desc
    limit 1;

    if v_latest.id is null or v_latest.sender_id <> v_uid then
      raise exception 'Thread preview may only reflect the caller''s latest saved message' using errcode='42501';
    end if;

    new.last_message_at := v_latest.sent_at;
    new.last_message_preview := left(v_latest.body, 80);
  end if;

  if (to_jsonb(new) - 'last_message_at' - 'last_message_preview' - 'user_a_last_read_at' - 'user_b_last_read_at')
       is distinct from
     (to_jsonb(old) - 'last_message_at' - 'last_message_preview' - 'user_a_last_read_at' - 'user_b_last_read_at') then
    raise exception 'Unsupported DM thread field mutation' using errcode='42501';
  end if;

  return new;
end;
$$;

revoke all on function public.p42_guard_dm_thread_write() from public;
revoke all on function public.p42_guard_dm_thread_write() from anon;
revoke all on function public.p42_guard_dm_thread_write() from authenticated;

drop trigger if exists p42_dm_thread_guard on public.dm_threads;
create trigger p42_dm_thread_guard
before insert or update on public.dm_threads
for each row execute function public.p42_guard_dm_thread_write();

create or replace function public.p42_guard_dm_message_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_username text;
  v_occurrences integer;
begin
  if v_uid is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not exists (
      select 1
      from public.dm_threads t
      where t.id=new.thread_id
        and (t.user_a_id=v_uid or t.user_b_id=v_uid)
    ) then
      raise exception 'The authenticated user is not a participant in this DM thread' using errcode='42501';
    end if;

    if new.body is null or length(trim(new.body))=0 then
      raise exception 'DM body cannot be empty' using errcode='22023';
    end if;
    if length(new.body) > 10000 then
      raise exception 'DM body exceeds 10000 characters' using errcode='22001';
    end if;

    select p.username into v_username from public.profiles p where p.id=v_uid;
    if v_username is null then
      raise exception 'Authenticated user has no Dagoldol profile' using errcode='23503';
    end if;

    new.sender_id := v_uid;
    new.sender_username := v_username;
    new.sent_at := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
    new.reactions := '{}'::jsonb;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.thread_id is distinct from old.thread_id
     or new.sender_id is distinct from old.sender_id
     or new.sender_username is distinct from old.sender_username
     or new.body is distinct from old.body
     or new.sent_at is distinct from old.sent_at then
    raise exception 'Saved DM sender/body/thread/timestamp fields are immutable' using errcode='42501';
  end if;

  if not exists (
    select 1
    from public.dm_threads t
    where t.id=old.thread_id
      and (t.user_a_id=v_uid or t.user_b_id=v_uid)
  ) then
    raise exception 'Only DM participants may update reactions' using errcode='42501';
  end if;

  if new.reactions is distinct from old.reactions then
    if public.p42_dm_reactions_without_user(new.reactions, v_uid)
       is distinct from public.p42_dm_reactions_without_user(old.reactions, v_uid) then
      raise exception 'A user may change only their own DM reaction membership' using errcode='42501';
    end if;

    select count(*)::integer
      into v_occurrences
    from jsonb_each(coalesce(new.reactions, '{}'::jsonb)) as reaction(key,value)
    cross join lateral jsonb_array_elements_text(reaction.value) as item(value)
    where item.value=v_uid::text;

    if v_occurrences > 1 then
      raise exception 'A user may have at most one active reaction per message' using errcode='22023';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.p42_guard_dm_message_write() from public;
revoke all on function public.p42_guard_dm_message_write() from anon;
revoke all on function public.p42_guard_dm_message_write() from authenticated;

drop trigger if exists p42_dm_message_guard on public.dm_messages;
create trigger p42_dm_message_guard
before insert or update on public.dm_messages
for each row execute function public.p42_guard_dm_message_write();

create or replace function public.p42_sync_dm_thread_after_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.dm_threads
     set last_message_at=new.sent_at,
         last_message_preview=left(new.body,80)
   where id=new.thread_id;
  return new;
end;
$$;

revoke all on function public.p42_sync_dm_thread_after_message() from public;
revoke all on function public.p42_sync_dm_thread_after_message() from anon;
revoke all on function public.p42_sync_dm_thread_after_message() from authenticated;

drop trigger if exists p42_dm_message_sync_thread on public.dm_messages;
create trigger p42_dm_message_sync_thread
after insert on public.dm_messages
for each row execute function public.p42_sync_dm_thread_after_message();

-- --------------------------------------------------------------------------
-- 4. Remove every current policy on the audited application tables. The live
--    project contains multiple generations of permissive policies; attempting
--    to add restrictive policies beside them is unsafe because PostgreSQL's
--    default permissive policies are OR-combined.
-- --------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname='public'
      and tablename = any(array[
        'activity','brands','bundles','chat_messages','chat_threads',
        'dm_messages','dm_threads','flash_sales','gift_card_transactions',
        'gift_cards','messages','orders','products','profiles','promo_codes',
        'ratings','settings','subscription_orders','subscriptions'
      ])
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$$;

alter table public.activity enable row level security;
alter table public.brands enable row level security;
alter table public.bundles enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_threads enable row level security;
alter table public.dm_messages enable row level security;
alter table public.dm_threads enable row level security;
alter table public.flash_sales enable row level security;
alter table public.gift_card_transactions enable row level security;
alter table public.gift_cards enable row level security;
alter table public.messages enable row level security;
alter table public.orders enable row level security;
alter table public.products enable row level security;
alter table public.profiles enable row level security;
alter table public.promo_codes enable row level security;
alter table public.ratings enable row level security;
alter table public.settings enable row level security;
alter table public.subscription_orders enable row level security;
alter table public.subscriptions enable row level security;

-- --------------------------------------------------------------------------
-- 5. Explicit public-schema table privileges. Admins are authenticated users;
--    RLS is the admin authorization check. service_role privileges are not
--    altered here.
-- --------------------------------------------------------------------------
revoke all on table public.profiles from anon, authenticated;
grant select, insert, update, delete on table public.profiles to authenticated;

revoke all on table public.products, public.brands, public.bundles, public.flash_sales from anon, authenticated;
grant select on table public.products, public.brands, public.bundles, public.flash_sales to anon, authenticated;
grant insert, update, delete on table public.products, public.brands, public.bundles, public.flash_sales to authenticated;

revoke all on table public.promo_codes from anon, authenticated;
grant select, insert, update, delete on table public.promo_codes to authenticated;

revoke all on table public.settings from anon, authenticated;
grant select on table public.settings to anon, authenticated;
grant insert, update, delete on table public.settings to authenticated;

revoke all on table public.orders from anon, authenticated;
grant select, insert, update, delete on table public.orders to authenticated;

revoke all on table public.ratings from anon, authenticated;
grant select on table public.ratings to anon, authenticated;
grant insert, update, delete on table public.ratings to authenticated;
do $$ begin
  if to_regclass('public.ratings_id_seq') is not null then
    execute 'revoke all on sequence public.ratings_id_seq from anon, authenticated';
    execute 'grant usage on sequence public.ratings_id_seq to authenticated';
  end if;
end $$;

revoke all on table public.messages from anon, authenticated;
grant select, insert, delete on table public.messages to authenticated;

revoke all on table public.activity from anon, authenticated;
grant select, insert, delete on table public.activity to authenticated;

revoke all on table public.chat_threads, public.chat_messages from anon, authenticated;
grant select, insert, update on table public.chat_threads to authenticated;
grant select, insert on table public.chat_messages to authenticated;

revoke all on table public.dm_threads, public.dm_messages from anon, authenticated;
grant select, insert, update on table public.dm_threads, public.dm_messages to authenticated;

revoke all on table public.gift_cards, public.gift_card_transactions from anon, authenticated;
grant select, insert, update, delete on table public.gift_cards, public.gift_card_transactions to authenticated;

revoke all on table public.subscriptions, public.subscription_orders from anon, authenticated;
grant select, insert, update, delete on table public.subscriptions, public.subscription_orders to authenticated;

-- --------------------------------------------------------------------------
-- 6. Canonical profiles policies.
-- --------------------------------------------------------------------------
create policy p42_profiles_select_owner_or_admin
on public.profiles for select to authenticated
using (id=auth.uid() or public.is_admin());

create policy p42_profiles_insert_self_customer
on public.profiles for insert to authenticated
with check (id=auth.uid() and role='customer');

create policy p42_profiles_update_owner_or_admin
on public.profiles for update to authenticated
using (id=auth.uid() or public.is_admin())
with check (id=auth.uid() or public.is_admin());

create policy p42_profiles_delete_admin
on public.profiles for delete to authenticated
using (public.is_admin());

-- --------------------------------------------------------------------------
-- 7. Public catalogue + admin-managed configuration.
-- --------------------------------------------------------------------------
create policy p42_products_public_read
on public.products for select to anon, authenticated using (true);
create policy p42_products_admin_write
on public.products for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_brands_public_read
on public.brands for select to anon, authenticated using (true);
create policy p42_brands_admin_write
on public.brands for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_bundles_public_read
on public.bundles for select to anon, authenticated using (true);
create policy p42_bundles_admin_write
on public.bundles for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_flash_sales_public_read
on public.flash_sales for select to anon, authenticated using (true);
create policy p42_flash_sales_admin_write
on public.flash_sales for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Promo definitions remain readable to authenticated checkout sessions for
-- current client-side code validation. used_count and all definitions are
-- admin-write-only at the table boundary; trusted atomic consumption belongs
-- to Phase 4.2B checkout.
create policy p42_promo_codes_authenticated_read
on public.promo_codes for select to authenticated using (true);
create policy p42_promo_codes_admin_write
on public.promo_codes for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_settings_public_read
on public.settings for select to anon, authenticated using (true);
create policy p42_settings_admin_write
on public.settings for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------------------
-- 8. Orders. CUSTOMER INSERT remains temporarily enabled ONLY for compatibility
--    with the currently retrievable checkout. The existing
--    orders_guard_customer_write trigger still prevents post-insert mutation of
--    trusted fields. Phase 4.2B must remove this INSERT policy and browser stock
--    RPC access before the Phase 4.2 exit gate can pass.
-- --------------------------------------------------------------------------
create policy p42_orders_select_owner_or_admin
on public.orders for select to authenticated
using (user_id=auth.uid() or public.is_admin());

create policy p42_orders_insert_owner_compat_phase42a
on public.orders for insert to authenticated
with check (user_id=auth.uid());

create policy p42_orders_update_owner_or_admin
on public.orders for update to authenticated
using (user_id=auth.uid() or public.is_admin())
with check (user_id=auth.uid() or public.is_admin());

create policy p42_orders_delete_admin
on public.orders for delete to authenticated
using (public.is_admin());

-- --------------------------------------------------------------------------
-- 9. Ratings. No generic authenticated INSERT alternative remains.
-- --------------------------------------------------------------------------
create policy p42_ratings_public_read
on public.ratings for select to anon, authenticated using (true);

create policy p42_ratings_insert_purchased_delivered
on public.ratings for insert to authenticated
with check (
  auth.uid()=user_id
  and value between 1 and 5
  and exists (
    select 1
    from public.orders o
    where o.id=ratings.order_id
      and o.user_id=auth.uid()
      and coalesce(o.cancelled,false)=false
      and coalesce(o.status_override,0)=4
      and exists (
        select 1
        from jsonb_array_elements(coalesce(o.items,'[]'::jsonb)) as item(value)
        where coalesce((item.value->>'isBundle')::boolean,false)=false
          and item.value->>'productId'=ratings.product_id
      )
  )
);

create policy p42_ratings_admin_update
on public.ratings for update to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_ratings_admin_delete
on public.ratings for delete to authenticated
using (public.is_admin());

-- --------------------------------------------------------------------------
-- 10. Contact messages and audit activity.
-- --------------------------------------------------------------------------
create policy p42_messages_insert_authenticated
on public.messages for insert to authenticated
with check (auth.uid() is not null);
create policy p42_messages_select_admin
on public.messages for select to authenticated
using (public.is_admin());
create policy p42_messages_delete_admin
on public.messages for delete to authenticated
using (public.is_admin());

create policy p42_activity_insert_authenticated
on public.activity for insert to authenticated
with check (auth.uid() is not null);
create policy p42_activity_select_admin
on public.activity for select to authenticated
using (public.is_admin());
create policy p42_activity_delete_admin
on public.activity for delete to authenticated
using (public.is_admin());

-- --------------------------------------------------------------------------
-- 11. Legacy support chat.
-- --------------------------------------------------------------------------
create policy p42_chat_threads_select_owner_or_admin
on public.chat_threads for select to authenticated
using (id=auth.uid()::text or public.is_admin());
create policy p42_chat_threads_insert_owner
on public.chat_threads for insert to authenticated
with check (id=auth.uid()::text);
create policy p42_chat_threads_update_owner_or_admin
on public.chat_threads for update to authenticated
using (id=auth.uid()::text or public.is_admin())
with check (id=auth.uid()::text or public.is_admin());

create policy p42_chat_messages_select_owner_or_admin
on public.chat_messages for select to authenticated
using (thread_id=auth.uid()::text or public.is_admin());
create policy p42_chat_messages_insert_sender
on public.chat_messages for insert to authenticated
with check (
  (sender='customer' and thread_id=auth.uid()::text)
  or (sender='admin' and public.is_admin())
);

-- --------------------------------------------------------------------------
-- 12. Direct messages. RLS restricts thread participation; triggers constrain
--     fields/reactions/read markers.
-- --------------------------------------------------------------------------
create policy p42_dm_threads_select_participant
on public.dm_threads for select to authenticated
using (auth.uid()=user_a_id or auth.uid()=user_b_id);
create policy p42_dm_threads_insert_participant
on public.dm_threads for insert to authenticated
with check (auth.uid()=user_a_id or auth.uid()=user_b_id);
create policy p42_dm_threads_update_participant
on public.dm_threads for update to authenticated
using (auth.uid()=user_a_id or auth.uid()=user_b_id)
with check (auth.uid()=user_a_id or auth.uid()=user_b_id);

create policy p42_dm_messages_select_participant
on public.dm_messages for select to authenticated
using (exists (
  select 1 from public.dm_threads t
  where t.id=dm_messages.thread_id
    and (auth.uid()=t.user_a_id or auth.uid()=t.user_b_id)
));
create policy p42_dm_messages_insert_participant
on public.dm_messages for insert to authenticated
with check (
  sender_id=auth.uid()
  and exists (
    select 1 from public.dm_threads t
    where t.id=dm_messages.thread_id
      and (auth.uid()=t.user_a_id or auth.uid()=t.user_b_id)
  )
);
create policy p42_dm_messages_update_reactions_participant
on public.dm_messages for update to authenticated
using (exists (
  select 1 from public.dm_threads t
  where t.id=dm_messages.thread_id
    and (auth.uid()=t.user_a_id or auth.uid()=t.user_b_id)
))
with check (exists (
  select 1 from public.dm_threads t
  where t.id=dm_messages.thread_id
    and (auth.uid()=t.user_a_id or auth.uid()=t.user_b_id)
));

-- --------------------------------------------------------------------------
-- 13. Gift cards. Existing stored value is visible only to purchaser,
--     recipient email from the signed JWT, or admin. Browser monetary mutation
--     is disabled; service_role is the only intended caller of gift-card state
--     functions until a trusted checkout integration is implemented.
-- --------------------------------------------------------------------------
create policy p42_gift_cards_select_owner_recipient_admin
on public.gift_cards for select to authenticated
using (
  purchaser_id=auth.uid()
  or (
    recipient_email is not null
    and lower(recipient_email)=lower(coalesce(auth.jwt()->>'email',''))
  )
  or public.is_admin()
);
create policy p42_gift_cards_admin_write
on public.gift_cards for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_gift_card_transactions_select_owner_recipient_admin
on public.gift_card_transactions for select to authenticated
using (exists (
  select 1
  from public.gift_cards g
  where g.id=gift_card_transactions.gift_card_id
    and (
      g.purchaser_id=auth.uid()
      or (
        g.recipient_email is not null
        and lower(g.recipient_email)=lower(coalesce(auth.jwt()->>'email',''))
      )
      or public.is_admin()
    )
));
create policy p42_gift_card_transactions_admin_write
on public.gift_card_transactions for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------------------
-- 14. Subscriptions. Direct customer mutation is disabled because the live
--     subscription functions reference a non-existent products.stock column
--     while live inventory is stored in products.sizes JSON. Owners retain
--     read access; admins/trusted service roles can manage rows.
-- --------------------------------------------------------------------------
create policy p42_subscriptions_select_owner_or_admin
on public.subscriptions for select to authenticated
using (user_id=auth.uid() or public.is_admin());
create policy p42_subscriptions_admin_write
on public.subscriptions for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy p42_subscription_orders_select_owner_or_admin
on public.subscription_orders for select to authenticated
using (
  exists (
    select 1 from public.subscriptions s
    where s.id=subscription_orders.subscription_id
      and (s.user_id=auth.uid() or public.is_admin())
  )
);
create policy p42_subscription_orders_admin_write
on public.subscription_orders for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------------------
-- 15. Function execution boundary.
-- --------------------------------------------------------------------------
-- Aggregate-only public recommendation signal is intentionally browser-facing.
revoke all on function public.get_public_recommendation_signals() from public;
revoke all on function public.get_public_recommendation_signals() from anon;
revoke all on function public.get_public_recommendation_signals() from authenticated;
grant execute on function public.get_public_recommendation_signals() to anon, authenticated;

-- place_order checks auth.uid(), but its live INSERT currently references
-- columns absent from public.orders. Keep it authenticated-only, not anonymous;
-- Phase 4.2B must repair/reconcile it before frontend cutover.
revoke all on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) from public;
revoke all on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) from anon;
revoke all on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) from authenticated;
grant execute on function public.place_order(text,jsonb,jsonb,text,text,text,boolean,numeric,text,integer) to authenticated, service_role;

-- TEMPORARY 4.2A COMPATIBILITY: current retrievable checkout/cancellation still
-- directly calls these helpers. Anonymous execution is removed immediately,
-- but authenticated execution remains until exact 3.3.5 is converted in 4.2B.
revoke all on function public.decrement_stock_for_order(jsonb) from public;
revoke all on function public.decrement_stock_for_order(jsonb) from anon;
revoke all on function public.decrement_stock_for_order(jsonb) from authenticated;
grant execute on function public.decrement_stock_for_order(jsonb) to authenticated, service_role;

revoke all on function public.restore_stock_for_order(jsonb) from public;
revoke all on function public.restore_stock_for_order(jsonb) from anon;
revoke all on function public.restore_stock_for_order(jsonb) from authenticated;
grant execute on function public.restore_stock_for_order(jsonb) to authenticated, service_role;

-- Monetary gift-card and stale subscription processors are server-only.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.proname = any(array[
        'purchase_gift_card','redeem_gift_card','refund_gift_card',
        'expire_gift_cards','generate_gift_card_code','validate_gift_card',
        'process_due_subscriptions','process_subscription',
        'decrement_stock_for_subscription','verify_stock_for_subscription',
        'calculate_next_order_date'
      ])
  loop
    execute format('revoke all on function %s from public', r.signature);
    execute format('revoke all on function %s from anon', r.signature);
    execute format('revoke all on function %s from authenticated', r.signature);
    execute format('grant execute on function %s to service_role', r.signature);
  end loop;
end
$$;

-- --------------------------------------------------------------------------
-- 16. Post-migration fail-closed PUBLIC DATABASE assertions.
--     Storage policy assertions are intentionally separate in
--     database/tests/phase4_2_storage_regression.sql after the Storage Policy
--     UI checklist has been applied.
-- --------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s.%s:%s',schemaname,tablename,policyname), ', ' order by tablename,policyname)
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
    raise exception 'Phase 4.2A1 stopped: non-canonical public policies remain: %', v_bad;
  end if;

  if has_function_privilege('anon','public.decrement_stock_for_order(jsonb)','EXECUTE') then
    raise exception 'Phase 4.2A1 stopped: anon can still execute decrement_stock_for_order(jsonb).';
  end if;
  if has_function_privilege('anon','public.restore_stock_for_order(jsonb)','EXECUTE') then
    raise exception 'Phase 4.2A1 stopped: anon can still execute restore_stock_for_order(jsonb).';
  end if;

  if has_function_privilege('anon','public.p42_lookup_profile_directory(text)','EXECUTE') then
    raise exception 'Phase 4.2A1 stopped: anon can execute the authenticated directory RPC.';
  end if;

  if exists (select 1 from storage.buckets where id='payment-proofs' and public) then
    raise exception 'Phase 4.2A1 stopped: payment-proofs bucket is public.';
  end if;
end
$$;

commit;

-- ============================================================================
-- PHASE 4.2A1 KNOWN OPEN GATES (INTENTIONAL, NOT A PHASE 4.2 ACCEPTANCE PASS)
-- ============================================================================
-- 1. Apply docs/phase4/PHASE4.2-STORAGE-POLICY-UI-CHECKLIST.md and then run
--    database/tests/phase4_2_storage_regression.sql.
-- 2. `authenticated` still has EXECUTE on decrement_stock_for_order(jsonb) and
--    restore_stock_for_order(jsonb), and owned-order INSERT remains temporarily
--    enabled for current checkout compatibility. Phase 4.2B must remove these.
-- 3. Exact Dagoldol 3.3.5 frontend directory/checkout integration is still
--    required before any production cutover.
-- ============================================================================
