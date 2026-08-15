-- ============================================================
-- DAGOLDOL — Phase 1 patch: ratings ownership + anti-abuse
-- Paste into: Supabase Dashboard → SQL Editor → New query → Run
-- Safe to re-run: uses "if not exists" / drop-then-create for policies.
--
-- SQL STATUS: PROPOSED POLICY (schema change) — the ownership check
-- below makes an ASSUMPTION about the shape of orders.items that is
-- NOT verified against your actual data. See the TODO comment inside
-- the insert policy before running this in production.
-- ============================================================

-- ---------- 1. Add ownership columns to ratings ----------

alter table public.ratings
  add column if not exists user_id uuid references public.profiles(id) on delete cascade;

alter table public.ratings
  add column if not exists order_id text references public.orders(id) on delete cascade;

-- One rating per (order, product) pair — stops the same purchase being
-- used to spam multiple ratings for the same item.
create unique index if not exists ratings_order_product_unique
  on public.ratings (order_id, product_id)
  where order_id is not null;

-- ---------- 2. Replace the old ratings policies ----------

drop policy if exists "insert ratings authenticated" on public.ratings;
drop policy if exists "select ratings public" on public.ratings;

-- Ratings stay publicly readable (unchanged behavior — product cards
-- show ratings to logged-out visitors too).
create policy "select ratings public" on public.ratings
  for select using (true);

-- PROPOSED — ownership-gated insert.
-- TODO (needs verification from you): this assumes each element of
-- orders.items is a JSON object containing the product id under the
-- key "id", e.g.  [{"id": "p1", "qty": 2, ...}, {"id": "p3", ...}]
-- If your actual items shape differs, the "exists (...)" clause below
-- must be rewritten to match it before this is safe to deploy.
create policy "insert ratings for purchased items" on public.ratings
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.orders o
      where o.id = order_id
        and o.user_id = auth.uid()
        and o.cancelled = false
        -- TODO: verify this matches your real items jsonb shape
        and exists (
          select 1
          from jsonb_array_elements(o.items) as item
          where item ->> 'id' = ratings.product_id
        )
    )
  );

-- No update/delete policy is added deliberately — once a rating is
-- submitted for a purchase it should not be editable by the buyer
-- (prevents a "rate low to get a discount, then flip to 5 stars"
-- pattern). Admin-only correction can be added later if you need it —
-- flag if you want that policy included.

-- ============================================================
-- STILL BLOCKED — not included in this file, needs info from you:
--
-- 1. Storage bucket policies (payment-proof screenshots, profile
--    avatars). index.html shows upload UI for both
--    (#order-payment-proof-input, #profile-avatar-input) but the
--    schema file you sent has no storage.buckets / storage.objects
--    policies at all. I need: your bucket name(s), whether they're
--    public or private, and any existing storage policies — or
--    confirmation that none exist yet.
--
-- 2. Everything in script.js — cart logic, order placement, admin
--    gating, promo/bulk-fee calculation, the actual Supabase calls
--    behind every button in index.html. This is Phase 1's biggest
--    blocker; most Step 3/4 findings can't be produced without it.
-- ============================================================
