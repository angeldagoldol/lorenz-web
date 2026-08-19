# Dagoldol Phase 4.2 Implementation Status

**Date:** 2026-08-20  
**Phase:** 4.2 — Zero-Trust Authorization, RLS & Private Data  
**Overall status:** **OPEN / NOT DEPLOYED / NOT ACCEPTED**

## What has been completed

The live Supabase project was inspected read-only. The current tables, columns, constraints, functions, triggers, RLS policies, grants, Storage buckets/policies, Edge Function inventory, and Supabase security-advisor findings were used as the implementation basis rather than assuming the repository SQL matches production.

The package now contains:

- a read-only live-contract export query;
- a staging-first Phase 4.2A canonical RLS/private-data migration;
- a read-only Phase 4.2B checkout authorization diagnostic gate;
- structural RLS policy tests;
- transaction-wrapped staging RLS behavior tests;
- structural Storage-policy tests;
- a staging-only Storage API runtime test;
- the approved zero-trust design and implementation plan;
- `SECURITY.md`;
- exact frontend-integration requirements for the unretrieved 3.3.5 source.

No production database/Storage policy, business record, Edge Function, or frontend deployment was changed during preparation of this package.

## Live Critical findings addressed by the Phase 4.2A candidate

### Legacy permissive table policies

The live project contains overlapping legacy policy generations, including unrestricted `public full access` alternatives on multiple storefront-management tables and broad authenticated writes on settings. Phase 4.2A removes the existing policy sets on audited tables and recreates one canonical `p42_*` contract.

### Profile-private IDOR

The live broad authenticated profiles SELECT policy makes whole profile rows queryable cross-account. Phase 4.2A replaces it with owner/admin direct SELECT plus two narrow directory RPCs returning only `id` and `username`.

**Deployment dependency:** exact 3.3.5 frontend username/seller lookup must use those RPCs before production policy cutover.

### Ratings bypass

The live strong purchase-bound ratings INSERT policy is bypassed by a separate legacy generic authenticated INSERT policy. Phase 4.2A leaves exactly one customer INSERT path: owned, non-cancelled, delivered order containing the rated product, with the existing unique `(order_id, product_id)` control.

### Payment-proof exposure

The `payment-proofs` bucket is private, but a broad legacy Storage SELECT policy currently includes that bucket. Phase 4.2A removes legacy Storage policies and creates owner/admin private proof access plus owner namespaces for proof/avatar writes and admin-only management of product/brand/payment-setting media.

### DM identity/state mutation

Live participant RLS permits generic row UPDATEs. Phase 4.2A adds database triggers that canonicalize participant/sender identity and prevent rewriting saved body/timestamp/thread/sender data, another participant's read marker, or another user's reaction identity.

### Gift-card/subscription browser mutation

Gift-card balance-changing functions accept privileged monetary inputs and the live subscription stock helpers are inconsistent with the deployed inventory schema. Phase 4.2A removes ordinary browser execution from those functions until trusted server integration is verified.

## Critical findings intentionally still open after Phase 4.2A

### P0 — Authenticated customers can still call stock helpers

The retrievable frontend directly calls:

- `decrement_stock_for_order(jsonb)` during checkout;
- `restore_stock_for_order(jsonb)` on failure/cancellation.

Phase 4.2A revokes anonymous execution but intentionally retains authenticated execution so a policy-only deployment cannot silently break checkout/cancellation. This means the Phase 4.2 exit criterion "customers cannot change stock" is **not yet met**.

### P0 — Customer direct order INSERT remains temporarily enabled

`p42_orders_insert_owner_compat_phase42a` preserves the current checkout path. The existing order-write trigger protects later UPDATEs but does not make browser-computed INSERT commercial values trustworthy.

Phase 4.2B must replace direct checkout persistence with one trusted atomic command and then remove this policy.

### P0 — Live `orders` schema and live `place_order()` disagree

The inspected production `orders` table has 19 columns. It lacks `payment_reference`, `payment_proof`, `half_payment`, `amount_due_now`, and `amount_due_later`, but the retrievable frontend and live `place_order()` function reference those fields.

The checkout RPC therefore cannot be certified or used for cutover until the exact 3.3.5 source and intended payment model are reconciled with the deployed schema.

### P0 — Exact current 3.3.5 `script.js` is unavailable in the writable workspace

The latest confirmed release is 3.3.5, which contains delivery/map/admin-pin changes newer than the retrievable Phase 3 `script.js`. Replacing it with an older file would create regressions. The frontend source is therefore not modified in this package.

### Phase 4.1 rollback gate remains open

Production mutation remains blocked until the required database backup, Storage backup/export point, exact production Vercel deployment identity/Git SHA, and immutable baseline tag are documented.

## Deployment sequence required

1. Close Phase 4.1 rollback/deployment evidence.
2. Obtain the exact latest Dagoldol 3.3.5 release tree.
3. Apply Phase 4.2A only to an isolated staging/branch environment.
4. Pair the exact frontend with the safe profile-directory RPCs.
5. Run structural RLS, behavior RLS, Storage structural, and Storage runtime tests.
6. Reconcile `orders` payment columns and trusted checkout/cancellation contract.
7. Implement Phase 4.2B database + exact frontend cutover.
8. Revoke authenticated stock-helper execution and direct customer order INSERT.
9. Run all mandatory privilege escalation, IDOR, admin, anonymous, checkout, Storage, source, build, and existing regression tests.
10. Run Supabase security advisors again and resolve or explicitly justify remaining findings.
11. Promote the same tested migrations/source to production.
12. Mark Phase 4.2 CLOSED only after the exit gate passes with retained evidence.

## Acceptance status

| Requirement | Status |
|---|---|
| Customer cannot promote self to admin | Existing DB guard + 4.2 canonical RLS designed; staging regression not yet executed |
| Customer cannot read another profile/private location | 4.2A design/migration complete; frontend pairing and staging execution pending |
| Customer cannot read another order | 4.2A canonical RLS complete; staging execution pending |
| Customer cannot alter own trusted order UPDATE fields | Existing live guard verified; regression file prepared |
| Customer cannot alter settings/promo counters | 4.2A migration complete; staging execution pending |
| Customer cannot access another DM | 4.2A participant RLS/guards complete; staging execution pending |
| Customer cannot access another payment proof | 4.2A Storage contract complete; runtime staging test pending |
| Customer cannot change stock | **FAIL / OPEN until 4.2B** |
| Customer cannot submit trusted commercial INSERT values | **FAIL / OPEN until 4.2B** |
| Admin retains legitimate access | Regression prepared; staging execution pending |
| Anonymous private-data access denied | 4.2A contract prepared; staging execution pending |
| No known privilege-escalation path | Cannot certify until staging + final checkout cutover tests pass |
| No known cross-account private-data exposure | Cannot certify until staging + exact frontend pairing tests pass |

**Phase 4.2 exit gate: NOT PASSED.**
