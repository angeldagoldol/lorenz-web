# Dagoldol Security Policy and Authorization Contract

## Scope

This document defines the security boundary for Dagoldol Phase 4.2. The database and Supabase Storage authorization rules are authoritative. Browser UI visibility, disabled buttons, route guards, and client-side role checks are usability controls only and must never be treated as authorization.

The latest confirmed application release for this work is Dagoldol 3.3.5. Phase 4.2A public/RLS and Storage hardening is deployed on the live Supabase project. Phase 4.2 remains **OPEN** until the Phase 4.2B commerce-authority migration is runtime-verified and promoted; this file describes the resulting target contract.

## Trust boundaries

### Anonymous client

An anonymous browser may read storefront information intentionally exposed to guests. It must not read customer profiles, orders, messages, private payment evidence, gift-card ownership, subscriptions, or other customer-private records. It must not perform database or Storage mutations.

### Authenticated customer

A customer may access their own account data and legitimate customer workflows only. Customer identity is derived from `auth.uid()` and must never be accepted from arbitrary request data as an authorization fact.

A customer must not be able to:

- change `profiles.role` or create an administrator profile;
- read or modify another customer's private profile, address, cart, orders, subscriptions, stored-value records, private messages, or payment proof;
- change trusted order totals, line prices, status, delivery fee, promo consumption, inventory, or payment-verification state;
- directly mutate inventory through browser-facing stock RPCs; compatibility RPCs may remain callable only when they are demonstrably non-mutating;
- change another participant's DM identity, sender identity, read marker, reaction identity, message body, thread membership, or saved timestamp;
- write storefront settings, products, brands, bundles, flash sales, promo definitions, or admin media;
- create or mutate stored-value gift-card balances through generic browser database access.

### Verified administrator

Administrators are authenticated accounts whose `public.profiles.role` is `admin`. Authorization is checked by the database helper `public.is_admin()` using `auth.uid()` and the database profile row. User-editable JWT metadata is not an authorization source.

Administrators retain legitimate management access to catalogue/configuration data, customer support records, orders, account administration, and private payment proofs required for verification. Private customer-to-customer DMs remain participant-scoped; administrator status alone does not silently grant surveillance access to conversations in which that account is not a participant.

### Trusted server process

`service_role` and database-owner operations are trusted server contexts. They may bypass RLS and therefore must never be exposed to browser code, public configuration, logs, client bundles, or user-controlled automation.

Server-only monetary/subscription processors must validate their own business invariants because bypassing RLS does not make input trustworthy.

## Canonical authorization matrix

| Resource | Anonymous | Customer | Admin | Trusted server |
|---|---|---|---|---|
| `profiles` | none | own row; safe directory RPC only for another identity | manage | manage |
| `products` | read | read | manage | manage |
| `brands` | read | read | manage | manage |
| `bundles` | read | read | manage | manage |
| `flash_sales` | read | read | manage | manage |
| `promo_codes` | none | read definitions required by current checkout; no writes | manage | manage/consume atomically |
| `settings` | read | read | manage | manage |
| `orders` | none | own rows; owner INSERT accepted only through canonical database enforcement; protected saved fields immutable except legal cancellation/rating transitions | manage | trusted commerce operations |
| `ratings` | read | insert only for owned delivered purchased item | correct/delete | manage |
| `messages` | none | authenticated submission | read/delete | manage |
| `activity` | none | authenticated append | read/delete | manage |
| `chat_threads` / `chat_messages` | none | own support thread | legitimate support access | manage |
| `dm_threads` / `dm_messages` | none | participant only | participant only unless separately authorized | manage |
| `gift_cards` / transactions | none | own/recipient read only | manage | monetary commands |
| `subscriptions` / generated orders | none | own read only during 4.2 hardening | manage | processing commands |
| `payment-proofs` Storage | none | own namespace | read for verification | manage |
| `avatars` Storage | public object delivery; no metadata-list policy | own namespace writes | normal public delivery | manage |
| admin media Storage | public object delivery; no mutation | no mutation | manage | manage |

## Privilege-bearing and trusted fields

The following values are protected at the database/server boundary, not merely in the UI:

- `profiles.role`;
- `orders.user_id`, `username`, `items`, `subtotal`, `delivery_fee`, `bulk_fee_rate`, `bulk_fee`, `cod_fee`, `total`, `status_override`, `placed_at`, promo state, and payment-verification fields that exist in the deployed schema;
- product inventory inside `products.sizes`;
- `promo_codes.used_count` and promo eligibility state;
- gift-card initial/current balances and transaction history;
- subscription pricing, processing state, failure counters, next processing dates, and generated-order relationships;
- DM participant identities, sender identity, message body, saved timestamp, and another user's read/reaction state;
- private Storage object namespace and payment-proof access.

The existing `profiles_guard_role_client` remains a defense-in-depth control. Phase 4.2B strengthens `orders_guard_customer_write` into the customer commerce-authority trigger: it canonicalizes line identity/pricing and trusted totals, consumes promos atomically, performs authoritative stock mutation through a private helper, restores stock atomically on cancellation, and protects saved order fields. It must not be weakened or removed without equivalent or stronger regression-proven controls.

## RLS policy rules

1. Every application table exposed through the Supabase Data API must have RLS enabled.
2. Policy sets are canonicalized rather than layered over unknown legacy policies. Permissive PostgreSQL policies are OR-combined, so one broad legacy policy can defeat multiple restrictive policies.
3. `anon` and `authenticated` table privileges are explicitly revoked and re-granted only for operations required by the role matrix.
4. Cross-account profile discovery must use `p42_lookup_profile_directory(text)` or `p42_get_seller_directory_profile()`. Direct cross-user `profiles` SELECT is prohibited because RLS is row-oriented and cannot safely expose only `id` and `username` while hiding private columns in the same row.
5. Admin authorization uses `public.is_admin()` with a fixed `search_path` and database-backed role lookup.
6. Customer UPDATE permission never implies permission to modify every column of an owned row. Field/state guards or narrow commands are required when only selected transitions are legitimate.

## Database function and RPC rules

`SECURITY DEFINER` functions are privileged code. Each such function must have a fixed `search_path`, a reviewed body, and explicit `EXECUTE` grants.

Browser execution is allowed only for functions deliberately designed as a browser API. Internal helpers must not be executable by `PUBLIC`, `anon`, or ordinary `authenticated` users.

Phase 4.2A removed anonymous access to the legacy order stock helpers. Phase 4.2B preserves the current 3.3.5 browser call shape without preserving its authority: `decrement_stock_for_order(jsonb)` becomes a `SECURITY INVOKER` read-only availability validator and `restore_stock_for_order(jsonb)` becomes a `SECURITY INVOKER` no-op compatibility shim. The only real stock mutator is `dagoldol_private.apply_stock_lines(jsonb, integer)`, which is not executable by ordinary authenticated clients. Authoritative decrement occurs in the order INSERT transaction and authoritative restoration occurs in the cancellation UPDATE transaction.

Gift-card monetary functions and the currently schema-stale subscription processors are server-only in the Phase 4.2A target contract.

### Phase 4.3 commerce boundary

Phase 4.2B does not claim to make road-route delivery pricing server-authoritative. The current browser still supplies the route-derived delivery quote; Phase 4.2B validates it as finite/non-negative, freezes it after INSERT, and derives the saved total from database-canonical product/bundle/promo values plus that quote. Phase 4.3 must move route quoting, final checkout request idempotency, and the complete server-authoritative checkout orchestration behind one trusted service boundary.

## Direct-message integrity

DM RLS grants row access only to participants. Database triggers additionally enforce:

- two distinct valid participants;
- canonical participant ordering and usernames;
- server-bound sender ID and username;
- server timestamp on new messages;
- immutable saved sender/thread/body/timestamp fields;
- one participant cannot change the other participant's read marker;
- one participant cannot forge another user's reaction membership;
- thread preview metadata is derived from the latest saved message rather than arbitrary client text.

## Storage security

### Hosted Supabase Storage ownership boundary

On the hosted Dagoldol project, `storage.objects` and `storage.buckets` are owned by Supabase's managed `supabase_storage_admin` role while SQL Editor runs as `postgres`. Phase 4.2 must not change that ownership, grant managed-role membership, or issue `ALTER TABLE storage.objects` from normal project migrations. Storage access policies are deployed through **Storage -> Policies -> OBJECTS** using `docs/phase4/PHASE4.2-STORAGE-POLICY-UI-CHECKLIST.md`, then verified read-only with `database/tests/phase4_2_storage_regression.sql`.


`payment-proofs` is private. Its object path begins with the authenticated owner's UUID. Only that owner and a verified administrator may read the object; only the owner may perform ordinary customer writes to that namespace.

`avatars` uses the same UUID-first owner namespace for customer writes.

`brand-logos`, `payment-settings`, and `product-images` are admin-managed. Public bucket delivery may serve their public URLs, but the database does not grant anonymous `storage.objects` metadata/list access merely because object delivery is public.

Storage object deletion must be performed through the Storage API, not by deleting `storage.objects` rows directly.

## Secrets

Never expose any of the following in frontend source, public environment variables, screenshots, issue reports, or logs:

- service-role/secret keys;
- database passwords or connection strings containing credentials;
- private JWT signing material;
- third-party API secrets;
- administrator session tokens.

Browser code may use only the project's intended public/publishable client key and the authenticated user's session token.

## Mandatory Phase 4.2 regression gates

Before production deployment, staging must prove all of the following:

1. customer self-promotion to admin is denied;
2. Customer A cannot read Customer B profile-private data, order, location, messages, subscription data, or payment proof;
3. customer trusted-order field tampering is denied;
4. customer storefront settings and promo-counter writes are denied;
5. customer direct stock mutation is denied after Phase 4.2B, including proof that browser-facing compatibility RPCs do not update `products`;
6. DM identity/content/reaction impersonation is denied;
7. invalid/non-purchased/non-delivered/duplicate ratings are denied while a valid eligible rating succeeds;
8. anonymous access to protected customer data and payment proofs is denied;
9. verified administrators retain required management access;
10. no obsolete broad alternative RLS policy remains;
11. Supabase security advisors are reviewed after the final migration;
12. application source/build/regression tests pass on the exact release tree.

## Vulnerability reporting

Security findings should be reported privately to the repository/project owner with the affected endpoint/table/function, reproduction conditions, expected authorization, observed authorization, and impact. Do not publish credentials, customer data, payment evidence, access tokens, or a working exploit against production in a public issue.

## Phase 4.3 server-authoritative checkout

Phase 4.3 adds a second, stricter checkout path without immediately removing the Phase 4.2B browser-compatibility path. Production must not remove the compatibility path until the exact deployed frontend has been cut over and verified.

The trusted Stage A boundary is:

`authenticated browser -> checkout Edge Function -> service-role-only Phase 4.3 RPC -> one PostgreSQL transaction`.

The browser may submit semantic checkout intent only: product/bundle identifiers, existing variant discriminator, quantities, delivery text, confirmed coordinates, promo code, payment selection/reference/proof path, half-payment choice, address-save choice, and a client-generated UUID idempotency key. Browser-supplied prices, discounts, stock values, promo counters, delivery fee, bulk fee, subtotal, final total, payment amounts, order ID, timestamps, and privileged order state are not authoritative.

### Phase 4.3 RPC exposure

The following RPCs are deliberately callable only by `service_role`:

- `public.p43_get_routing_config()`;
- `public.p43_quote_checkout(uuid,jsonb,jsonb,text)`;
- `public.p43_commit_checkout(uuid,uuid,jsonb,jsonb,text)`.

`PUBLIC`, `anon`, and ordinary `authenticated` roles have `EXECUTE` revoked. The Edge Function verifies the incoming user JWT with Auth and supplies the verified user UUID to these service RPCs. The service-role secret must never be returned to, logged for, or embedded in the browser.

The public Phase 4.3 RPCs are `SECURITY INVOKER` with fixed empty `search_path`. Internal request normalization, configuration hashing, pricing resolution, flash-sale lock coordination, the idempotency ledger, and delivery configuration live under `dagoldol_private`.

### Private-table fail-closed policy

`dagoldol_private.checkout_requests`, `dagoldol_private.delivery_config`, and `dagoldol_private.delivery_free_zones` have RLS enabled with no browser/client policies. `PUBLIC`, `anon`, and `authenticated` privileges are explicitly revoked. `service_role` is the trusted execution role and has `BYPASSRLS` in hosted Supabase.

The absence of client RLS policies on these private tables is intentional. Do not create permissive policies merely to clear an informational linter message.

### Idempotency and transaction integrity

`checkout_requests` uses `(user_id, idempotency_key UUID)` as its primary key and stores a SHA-256 fingerprint of normalized semantic intent. Same user/key/same intent returns the previously committed response. Same user/key/different intent fails with `IDEMPOTENCY_CONFLICT`.

The commit transaction locks and resolves authoritative commerce state, decrements inventory, consumes the promo, creates the canonical order, optionally saves the address, and completes the idempotency ledger before commit. Any exception rolls all of those changes back together.

### Delivery authority

The Edge Function owns external routing, bounded timeout/retry, origin allowlisting, JWT verification, and request-size limits. It sends route measurements and a database configuration hash; it does not calculate the PHP fee. PostgreSQL owns the configured free-kilometre threshold, free-zone radii, PHP/km rate, fallback fee, and final delivery amount.

The current configured contract is 5 km free, PHP 60 per full road-kilometre when chargeable, and PHP 600 fallback. The Edge Function must consume `freeKmThreshold` returned by `p43_get_routing_config()` and must not hard-code 5 km as routing control logic.

### Payment proof and logging

A submitted payment proof path must start with the authenticated user's UUID namespace. Payment proof storage remains private. Uploading proof is not equivalent to payment verification.

Checkout logs may contain correlation ID, operation, truncated user reference, stable error code, duration, and upstream status when useful. They must not contain access tokens, service keys, payment references, proof paths, full address text, or precise delivery coordinates.
