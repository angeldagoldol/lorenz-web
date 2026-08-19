# Dagoldol Security Policy and Authorization Contract

## Scope

This document defines the security boundary for Dagoldol Phase 4.2. The database and Supabase Storage authorization rules are authoritative. Browser UI visibility, disabled buttons, route guards, and client-side role checks are usability controls only and must never be treated as authorization.

The latest confirmed application release for this work is Dagoldol 3.3.5. Phase 4.2 is currently **OPEN / NOT DEPLOYED**; the repository package contains a staging-first authorization migration and regression tests, but production must not be changed until the Phase 4.1 rollback evidence is complete.

## Trust boundaries

### Anonymous client

An anonymous browser may read storefront information intentionally exposed to guests. It must not read customer profiles, orders, messages, private payment evidence, gift-card ownership, subscriptions, or other customer-private records. It must not perform database or Storage mutations.

### Authenticated customer

A customer may access their own account data and legitimate customer workflows only. Customer identity is derived from `auth.uid()` and must never be accepted from arbitrary request data as an authorization fact.

A customer must not be able to:

- change `profiles.role` or create an administrator profile;
- read or modify another customer's private profile, address, cart, orders, subscriptions, stored-value records, private messages, or payment proof;
- change trusted order totals, line prices, status, delivery fee, promo consumption, inventory, or payment-verification state;
- execute internal inventory restoration/decrement commands after the Phase 4.2B checkout cutover;
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
| `orders` | none | own rows; Phase 4.2A temporary direct insert compatibility only | manage | trusted commerce command |
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

The existing `profiles_guard_role_client` and `orders_guard_customer_write` triggers remain defense-in-depth controls and must not be removed without an equivalent or stronger replacement plus regression evidence.

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

Phase 4.2A removes anonymous access to the order stock helpers but temporarily leaves authenticated execution for compatibility with the retrievable checkout/cancellation implementation. This is an acknowledged P0 and prevents Phase 4.2 closure. Phase 4.2B must move checkout and cancellation into trusted atomic commands, then revoke authenticated execution of `decrement_stock_for_order(jsonb)` and `restore_stock_for_order(jsonb)`.

Gift-card monetary functions and the currently schema-stale subscription processors are server-only in the Phase 4.2A target contract.

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
5. customer direct stock mutation is denied after Phase 4.2B;
6. DM identity/content/reaction impersonation is denied;
7. invalid/non-purchased/non-delivered/duplicate ratings are denied while a valid eligible rating succeeds;
8. anonymous access to protected customer data and payment proofs is denied;
9. verified administrators retain required management access;
10. no obsolete broad alternative RLS policy remains;
11. Supabase security advisors are reviewed after the final migration;
12. application source/build/regression tests pass on the exact release tree.

## Vulnerability reporting

Security findings should be reported privately to the repository/project owner with the affected endpoint/table/function, reproduction conditions, expected authorization, observed authorization, and impact. Do not publish credentials, customer data, payment evidence, access tokens, or a working exploit against production in a public issue.
