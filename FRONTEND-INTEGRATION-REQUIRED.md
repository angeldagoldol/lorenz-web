# Dagoldol Phase 4.2 Frontend Integration Required

## Status

The exact current Dagoldol 3.3.5 `script.js` is not available in the writable workspace. Older retrievable Phase 3 files must not replace it because 3.3.5 contains later delivery/map/admin-pin behavior. This document therefore defines the required source changes without fabricating a full replacement file.

The Phase 4.2A migration is **not production-deployable with the current frontend until the profile-directory calls below are changed in the exact 3.3.5 source**.

## 1. Replace cross-user `profiles` queries

The retrievable source currently performs direct cross-user queries similar to:

- username lookup selecting `profiles.id, profiles.username`;
- seller lookup selecting `profiles.id, profiles.username, profiles.role`.

After Phase 4.2A, direct cross-user profile SELECT is intentionally denied to prevent exposure of `address`, `profile`, `cart`, and other private columns.

The exact 3.3.5 source must replace those lookups with:

- `supabase.rpc("p42_lookup_profile_directory", { p_username: username.trim() })` for an exact username lookup;
- `supabase.rpc("p42_get_seller_directory_profile")` for the seller/admin chat identity.

Only `id` and `username` may be consumed from these RPCs. Do not restore a broad `profiles` SELECT policy to avoid changing JavaScript.

## 2. Preserve own-profile operations

Own-profile load/update behavior may continue to use `public.profiles` directly because Phase 4.2 policies allow the authenticated owner to select and update their own row. `profiles.role` remains protected by the existing database trigger and canonical RLS.

## 3. DM writes may remain direct after the migration

The current direct-message UI may continue to insert/update `dm_threads` and `dm_messages` through Supabase, provided it uses the existing participant data flow. Phase 4.2 database triggers canonicalize/validate participant identity, sender identity, timestamps, preview metadata, read markers, and reaction ownership.

A client error caused by attempting a forbidden DM field change must be treated as an authorization failure; the UI must not retry using a weaker endpoint.

## 4. Phase 4.2B checkout cutover is mandatory

The retrievable frontend still performs the insecure multi-step browser sequence:

1. compute commercial totals in JavaScript;
2. call `decrement_stock_for_order` directly;
3. insert `orders` directly;
4. restore stock from the browser on insert failure;
5. increment promo usage separately.

Cancellation similarly updates `orders.cancelled` and restores stock in separate browser operations.

The exact 3.3.5 source must be changed so checkout sends only customer-controlled inputs and item identifiers/quantities to one trusted server-side command. That command must atomically:

- bind the caller to `auth.uid()`;
- load current products/bundles from the database;
- validate selected sizes and quantities;
- recompute trusted prices and totals;
- validate/consume promo usage under lock;
- validate/decrement inventory under lock;
- insert the order using the actual deployed column contract;
- return the committed order ID and server-calculated amounts.

Cancellation must likewise become one trusted command that validates ownership/current status, marks the order cancelled, and restores stock exactly once in the same transaction.

After the source cutover, remove all browser calls to:

- `decrement_stock_for_order`;
- `restore_stock_for_order`;
- direct `orders.insert(...)` checkout persistence;
- direct promo `used_count` mutation.

Then the Phase 4.2B migration must revoke authenticated `EXECUTE` on both stock helpers and remove the temporary `p42_orders_insert_owner_compat_phase42a` policy.

## 5. Resolve the live `orders` schema mismatch before checkout cutover

The live production `public.orders` contract inspected on 2026-08-20 has 19 columns and does not contain:

- `payment_reference`;
- `payment_proof`;
- `half_payment`;
- `amount_due_now`;
- `amount_due_later`.

The retrievable frontend and the live `place_order(...)` body reference those fields. Do not add columns merely to make the function compile without first confirming the exact 3.3.5 product/payment requirements and integrating the decision through schema, RPC, frontend, tests, and admin/order rendering together.

## 6. Resolve stale subscription inventory functions

Live inventory is represented in `products.sizes` JSON. The inspected subscription stock helpers reference a top-level `products.stock` column that does not exist. Phase 4.2A removes ordinary browser execution from those functions. They must not be re-enabled until subscription processing is reconciled with the actual inventory model and tested transactionally.

## 7. Source verification additions after exact 3.3.5 retrieval

Extend `scripts/verify-source.mjs` to fail the release if browser source contains any of these checkout-authority patterns outside explicitly allowed server/admin contexts:

- `.rpc("decrement_stock_for_order"`;
- `.rpc("restore_stock_for_order"`;
- checkout-time `.from("orders").insert(`;
- direct customer mutation of `promo_codes.used_count`;
- cross-user `.from("profiles").select(` directory lookup instead of the Phase 4.2 RPCs.

The verifier must be written against the exact current source structure so it does not create false positives for legitimate admin or own-profile operations.
