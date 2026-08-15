-- ============================================================================
-- DAGOLDOL PHASE 3 — VERIFIED-SHAPE SECURITY / STORAGE MIGRATION
-- ============================================================================
-- This migration only uses table/JSON shapes that are directly exercised by
-- the supplied Phase 3 frontend:
--   profiles(id, role)
--   orders(id, user_id, items, cancelled, placed_at, status_override)
--   ratings(product_id, value)
-- and the Storage bucket names used by script.js.
--
-- Run this in Supabase SQL Editor before deploying the Phase 3 frontend.
-- It is designed to be re-runnable: named policies are dropped/recreated and
-- columns/indexes/functions use idempotent forms where PostgreSQL supports it.
-- ============================================================================

begin;

-- --------------------------------------------------------------------------
-- 0. Source-contract preflight. Fail before changing anything if the live
--    database does not expose the columns this migration is designed for.
-- --------------------------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles') is null then missing := array_append(missing, 'public.profiles'); end if;
  if to_regclass('public.orders') is null then missing := array_append(missing, 'public.orders'); end if;
  if to_regclass('public.ratings') is null then missing := array_append(missing, 'public.ratings'); end if;

  if array_length(missing, 1) is not null then
    raise exception 'Dagoldol Phase 3 migration stopped: missing required table(s): %', array_to_string(missing, ', ');
  end if;

  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='role') then
    raise exception 'Dagoldol Phase 3 migration stopped: profiles.id and profiles.role are required.';
  end if;

  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='user_id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='items')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='cancelled')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='placed_at')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='status_override') then
    raise exception 'Dagoldol Phase 3 migration stopped: required orders columns are missing.';
  end if;

  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='ratings' and column_name='product_id')
     or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='ratings' and column_name='value') then
    raise exception 'Dagoldol Phase 3 migration stopped: ratings.product_id and ratings.value are required.';
  end if;

  if exists (select 1 from public.ratings where value is null or value < 1 or value > 5) then
    raise exception 'Dagoldol Phase 3 migration stopped: ratings contains value(s) outside 1..5. Correct them before adding the constraint.';
  end if;
end
$$;

-- --------------------------------------------------------------------------
-- 1. Shared admin predicate used by Storage policies.
-- --------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role, '')) = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- --------------------------------------------------------------------------
-- 2. Purchase-bound ratings.
--    The current order JSON uses item.productId for non-bundle products.
-- --------------------------------------------------------------------------
alter table public.ratings
  add column if not exists user_id uuid references public.profiles(id) on delete cascade;

alter table public.ratings
  add column if not exists order_id text references public.orders(id) on delete cascade;

create unique index if not exists ratings_order_product_unique
  on public.ratings (order_id, product_id)
  where order_id is not null;

-- Keep the value domain explicit without assuming any other ratings columns.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ratings_value_1_to_5'
      and conrelid = 'public.ratings'::regclass
  ) then
    alter table public.ratings
      add constraint ratings_value_1_to_5 check (value between 1 and 5);
  end if;
end
$$;

alter table public.ratings enable row level security;

drop policy if exists "select ratings public" on public.ratings;
drop policy if exists "insert ratings authenticated" on public.ratings;
drop policy if exists "insert ratings for purchased items" on public.ratings;
drop policy if exists "dagoldol ratings public read" on public.ratings;
drop policy if exists "dagoldol ratings purchased insert" on public.ratings;

create policy "dagoldol ratings public read"
on public.ratings
for select
to anon, authenticated
using (true);

create policy "dagoldol ratings purchased insert"
on public.ratings
for insert
to authenticated
with check (
  auth.uid() = user_id
  and value between 1 and 5
  and exists (
    select 1
    from public.orders o
    where o.id = order_id
      and o.user_id = auth.uid()
      and coalesce(o.cancelled, false) = false
      and coalesce(o.status_override, 0) = 4
      and exists (
        select 1
        from jsonb_array_elements(coalesce(to_jsonb(o.items), '[]'::jsonb)) item
        where coalesce((item ->> 'isBundle')::boolean, false) = false
          and item ->> 'productId' = ratings.product_id::text
      )
  )
);

-- --------------------------------------------------------------------------
-- 3. Public recommendation signals without exposing raw order rows.
--    The function returns only aggregate product scores and co-occurrence.
-- --------------------------------------------------------------------------
create or replace function public.get_public_recommendation_signals()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with order_items as (
  select
    o.id as order_id,
    coalesce(o.placed_at, 0)::bigint as placed_at,
    item
  from public.orders o
  cross join lateral jsonb_array_elements(coalesce(to_jsonb(o.items), '[]'::jsonb)) item
  where coalesce(o.cancelled, false) = false
),
normal_lines as (
  select
    order_id,
    placed_at,
    item ->> 'productId' as product_id,
    greatest(coalesce((item ->> 'qty')::numeric, 0), 0) as qty
  from order_items
  where coalesce((item ->> 'isBundle')::boolean, false) = false
    and nullif(item ->> 'productId', '') is not null
),
bundle_lines as (
  select
    oi.order_id,
    oi.placed_at,
    comp ->> 'productId' as product_id,
    greatest(coalesce((comp ->> 'qty')::numeric, 0), 0)
      * greatest(coalesce((oi.item ->> 'qty')::numeric, 0), 0) as qty
  from order_items oi
  cross join lateral jsonb_array_elements(coalesce(oi.item -> 'components', '[]'::jsonb)) comp
  where coalesce((oi.item ->> 'isBundle')::boolean, false) = true
    and nullif(comp ->> 'productId', '') is not null
),
all_lines as (
  select * from normal_lines
  union all
  select * from bundle_lines
),
trending as (
  select
    product_id,
    sum(qty) as score
  from all_lines
  where placed_at >= ((extract(epoch from clock_timestamp()) * 1000)::bigint - 1209600000)
  group by product_id
),
order_products as (
  select distinct order_id, product_id
  from all_lines
),
pair_counts as (
  select
    a.product_id as source_product_id,
    b.product_id as related_product_id,
    count(*)::bigint as score
  from order_products a
  join order_products b
    on b.order_id = a.order_id
   and b.product_id <> a.product_id
  group by a.product_id, b.product_id
),
cooccurrence_by_product as (
  select
    source_product_id,
    jsonb_object_agg(related_product_id, score order by related_product_id) as related
  from pair_counts
  group by source_product_id
)
select jsonb_build_object(
  'trending',
  coalesce((select jsonb_object_agg(product_id, score order by product_id) from trending), '{}'::jsonb),
  'cooccurrence',
  coalesce((select jsonb_object_agg(source_product_id, related order by source_product_id) from cooccurrence_by_product), '{}'::jsonb)
);
$$;

revoke all on function public.get_public_recommendation_signals() from public;
grant execute on function public.get_public_recommendation_signals() to anon, authenticated;

-- --------------------------------------------------------------------------
-- 4. Storage bucket visibility.
--    payment-proofs is private. Public storefront media remains public.
--
--    Older versions stored public payment-proof URLs in orders.payment_proof.
--    Normalize URLs generated by Supabase's public payment-proofs endpoint to
--    object paths before the bucket becomes private. The original uploader
--    used <auth-user-id>/<generated-file>.jpg, so owner/admin policies below
--    can continue to authorize the migrated records.
-- --------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name='payment_proof'
  ) then
    update public.orders
    set payment_proof = regexp_replace(
      payment_proof,
      '^https?://[^/]+/storage/v1/object/public/payment-proofs/',
      ''
    )
    where payment_proof ~ '^https?://[^/]+/storage/v1/object/public/payment-proofs/';
  end if;
end
$$;

insert into storage.buckets (id, name, public)
values
  ('avatars', 'avatars', true),
  ('payment-proofs', 'payment-proofs', false),
  ('product-images', 'product-images', true),
  ('brand-logos', 'brand-logos', true),
  ('payment-settings', 'payment-settings', true)
on conflict (id) do update
set public = excluded.public;

-- Drop only Dagoldol-owned policy names so the migration is re-runnable.
drop policy if exists "dagoldol avatar owner insert" on storage.objects;
drop policy if exists "dagoldol avatar owner update" on storage.objects;
drop policy if exists "dagoldol avatar owner delete" on storage.objects;
drop policy if exists "dagoldol payment proof owner insert" on storage.objects;
drop policy if exists "dagoldol payment proof owner or admin read" on storage.objects;
drop policy if exists "dagoldol payment proof owner delete" on storage.objects;
drop policy if exists "dagoldol admin product image insert" on storage.objects;
drop policy if exists "dagoldol admin product image update" on storage.objects;
drop policy if exists "dagoldol admin product image delete" on storage.objects;
drop policy if exists "dagoldol admin brand logo insert" on storage.objects;
drop policy if exists "dagoldol admin brand logo update" on storage.objects;
drop policy if exists "dagoldol admin brand logo delete" on storage.objects;
drop policy if exists "dagoldol admin payment setting insert" on storage.objects;
drop policy if exists "dagoldol admin payment setting update" on storage.objects;
drop policy if exists "dagoldol admin payment setting delete" on storage.objects;

-- Avatars: users write only inside their own top-level folder.
create policy "dagoldol avatar owner insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'avatars'
  and split_part(name, '/', 1) = auth.uid()::text
);

create policy "dagoldol avatar owner update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'avatars'
  and split_part(name, '/', 1) = auth.uid()::text
)
with check (
  bucket_id = 'avatars'
  and split_part(name, '/', 1) = auth.uid()::text
);

create policy "dagoldol avatar owner delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'avatars'
  and split_part(name, '/', 1) = auth.uid()::text
);

-- Payment proofs: private object paths, readable only by owner or admin.
create policy "dagoldol payment proof owner insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-proofs'
  and split_part(name, '/', 1) = auth.uid()::text
);

create policy "dagoldol payment proof owner or admin read"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'payment-proofs'
  and (
    split_part(name, '/', 1) = auth.uid()::text
    or public.is_admin()
  )
);

create policy "dagoldol payment proof owner delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'payment-proofs'
  and split_part(name, '/', 1) = auth.uid()::text
);

-- Admin-owned public storefront media.
create policy "dagoldol admin product image insert"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'product-images' and public.is_admin());

create policy "dagoldol admin product image update"
on storage.objects
for update
to authenticated
using (bucket_id = 'product-images' and public.is_admin())
with check (bucket_id = 'product-images' and public.is_admin());

create policy "dagoldol admin product image delete"
on storage.objects
for delete
to authenticated
using (bucket_id = 'product-images' and public.is_admin());

create policy "dagoldol admin brand logo insert"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'brand-logos' and public.is_admin());

create policy "dagoldol admin brand logo update"
on storage.objects
for update
to authenticated
using (bucket_id = 'brand-logos' and public.is_admin())
with check (bucket_id = 'brand-logos' and public.is_admin());

create policy "dagoldol admin brand logo delete"
on storage.objects
for delete
to authenticated
using (bucket_id = 'brand-logos' and public.is_admin());

create policy "dagoldol admin payment setting insert"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'payment-settings' and public.is_admin());

create policy "dagoldol admin payment setting update"
on storage.objects
for update
to authenticated
using (bucket_id = 'payment-settings' and public.is_admin())
with check (bucket_id = 'payment-settings' and public.is_admin());

create policy "dagoldol admin payment setting delete"
on storage.objects
for delete
to authenticated
using (bucket_id = 'payment-settings' and public.is_admin());

commit;
