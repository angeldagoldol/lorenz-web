# Dagoldol Phase 4.3 Verification Record

Status: **STAGE A STAGING BEHAVIOR VERIFIED; PRODUCTION PROMOTION STILL BLOCKED**

## Source baseline

- Uploaded source archive: `web - project(1).zip`
- Archive SHA-256: `d49b137bffb9f794c0477f265903d8b543fc06c0625cfed8cbd1d3e1920fb4b7`
- Source-declared version: `3.3.5`
- Local imported baseline commit: `b78c0bc89375064627b66083970fac60c936ad60`
- Isolated local branch: `phase4-3-server-checkout`
- Local execution tree: `/mnt/data/dagoldol-phase43-work/repo`
- The ZIP contained no original `.git` history. The local commit is an execution baseline only and is not represented as the original Vercel/Git production revision.

## Inherited 3.3.5 source gate

Fresh execution of `npm run verify` on the additive Stage A tree returns status 1 at the untouched inherited `tests/multidevice-auth-contract.test.mjs` suite: 4/4 tests fail against the uploaded `script.js`. Phase 4.3 Stage A has not modified `script.js`, so this remains inherited baseline drift.

Fresh `npm run build` returns status 1 because this sandbox cannot resolve the production Supabase hostname; the catalogue generator reports `getaddrinfo EAI_AGAIN rvrjkfbenramappteuae.supabase.co`.

Therefore Stage B browser modification remains blocked until the inherited release/test inconsistency is explicitly resolved or accepted as a separate repair scope.

## Phase 4.1 production release gate

The required rollback evidence is still not closed in this conversation. Before Phase 4.3 production mutation, retain:

1. production database backup/export point;
2. Storage backup/export point;
3. exact deployed Vercel deployment identifier and original Git SHA/revision;
4. immutable production baseline tag/release marker.

## Isolated staging environment

- Supabase project: `Dagoldol Phase 4.3 Staging`
- Project ref: `genlmsbvcwzlgjpdeqdl`
- Region: `ap-southeast-1`
- Project cost confirmed at creation: `$0/month`
- No production business rows were copied into staging.

## Database Stage A evidence

The staging database was reconstructed to the Phase 4.2 commerce contract needed by Phase 4.3 and then exercised with the Phase 4.3 schema/functions.

Fresh clean structural probe after the corrected consolidated migration replay, RLS hardening, Edge v4 restoration, and removal of test extensions: **PASS**.

Verified:

- `public.orders.delivery_quote` exists as JSONB;
- `dagoldol_private.checkout_requests`, `delivery_config`, and `delivery_free_zones` exist;
- all three private tables have RLS enabled with no browser/client policies;
- `(user_id,idempotency_key UUID)` is the idempotency key;
- `request_fingerprint` exists;
- `checkout_requests_order_id_idx` covers the order foreign key;
- `p43_delivery_config_hash`, request normalizer/fingerprint, resolver, routing config RPC, quote RPC, and commit RPC exist;
- routing config returns the database-owned `freeKmThreshold` and it matches `delivery_config`;
- `service_role` can execute the three Phase 4.3 public RPCs;
- `anon` and ordinary `authenticated` cannot execute those RPCs;
- temporary `dblink`, `pg_cron`, and `pg_net` test extensions are absent after cleanup.

The latest read-only result was `phase43_contract_status = PASS` with every listed boolean true.

### Canonical resolver behavior

Rollback-only resolver suite: **PASS**.

Covered:

- authoritative product/variant price;
- authoritative bundle price/components;
- active flash-sale price;
- insufficient-stock rejection;
- expired/exhausted promo handling;
- preserved 250–255 and 256+ bulk tiers;
- confirmed-pin validation;
- free-zone, distance-rate, and fallback delivery rules;
- full/half-payment amounts;
- forged browser prices/totals/discounts ignored.

### Transaction behavior

Transactional commit suite: **PASS**.

Covered:

- server-generated order ID;
- canonical stored totals and delivery snapshot;
- stock decrement;
- promo consumption;
- payment reference/proof namespace validation;
- optional profile-address save;
- same-key retry returning the same committed response;
- changed-intent reuse of a key rejected.

Failure/rollback matrix: **PASS**.

Validated that payment-reference failure, foreign proof path, insufficient stock, expired/exhausted promo, delivery configuration drift, and forced order-insert failure leave no partial stock/promo/profile/order/idempotency mutation.

## Independent concurrency evidence

Concurrency was proven with independent staging PostgreSQL worker sessions using temporary `pg_cron`, then all jobs, fixtures, functions/triggers, capture rows, and the test extension were removed.

- Final stock = 1: **PASS**. Two worker PIDs began about 1.2 ms apart; one committed, one received SQLSTATE `P4304`, final stock = 0, one order existed.
- Final promo use = 1: **PASS**. Two worker PIDs began about 2.3 ms apart on different products; one committed, one received `P4308`, promo `used_count` became 1, loser stock was unchanged.
- Same user/key/request: **PASS**. Two worker PIDs began about 0.65 ms apart; both resolved to the same order ID, one order/ledger row existed, stock decremented once.

## Edge Function Stage A evidence

Local modular source under `supabase/functions/checkout/`:

- `node --experimental-strip-types --test supabase/functions/checkout/*.test.ts`: **PASS — 21 tests, 0 failures**.
- `tsc -p supabase/functions/checkout/tsconfig.json`: **PASS**.

The suite covers request allowlisting, forged monetary fields, confirmed coordinate requirements, stable SQLSTATE mapping, privacy-safe unknown errors, JWT requirement, CORS, invalid JSON, quote orchestration, idempotent transient retry, configuration-change refresh, OSRM success/retry/permanent failure, fallback behavior, free-zone failure handling, and use of the trusted database `freeKmThreshold` rather than a hard-coded 5 km branch.

### Staging deployment

Checkout Edge Function:

- version: `4`
- status: `ACTIVE`
- `verify_jwt=true`
- deployed source SHA reported by Supabase: `051da9f7c1fedd38752733bf1edc90cda50c44c14bd1ccf31ca9e5a4b91fc941`

Version 4 is the exact modular package source and consumes `config.freeKmThreshold` returned by the database. Version 3 was a temporary fail-closed maintenance deployment used only while the approved destructive staging reset was in progress.

Fresh runtime probe after version 4 restoration: **PASS for runtime/auth/CORS rejection path**. A non-user anon JWT passed the platform JWT layer, reached the Edge runtime, and the function returned `401 AUTH_REQUIRED`; response headers contained the expected production CORS origin and `x-checkout-request-id` correlation ID. The temporary `pg_net` transport used for the probe was dropped immediately afterward.

### Authenticated Edge quote/commit integration

**NOT YET PROVEN in this tool environment.** The environment does not expose a normal staging user access token, and the credential-safety layer blocks manufacturing/signing-in a disposable password account through the tool. No bypass was attempted.

Reusable tests are included:

- `tests/phase4-3-edge-integration.test.mjs`
- `tests/phase4-3-concurrency.test.mjs`

They require externally supplied staging user JWTs and fixture payloads in a credential-capable release environment.

## RLS hardening

Explicitly approved and applied in staging:

- `dagoldol_private.checkout_requests` RLS enabled;
- `dagoldol_private.delivery_config` RLS enabled;
- `dagoldol_private.delivery_free_zones` RLS enabled.

No client policies were created. `PUBLIC`, `anon`, and `authenticated` table access remains revoked. `service_role` remains the trusted role and has hosted Supabase `BYPASSRLS`.

Supabase may report informational `rls_enabled_no_policy` notices for these private tables. That fail-closed state is intentional.

## Advisor review

Phase 4.3-specific performance finding for the idempotency ledger order foreign key was corrected with `checkout_requests_order_id_idx`.

Remaining staging advisor items are inherited/reconstruction items outside this new Stage A boundary. The private Phase 4.3 tables intentionally report INFO `rls_enabled_no_policy` because they are RLS-enabled with no client policies. The performance advisor reports the new `checkout_requests_order_id_idx` only as unused because staging retains zero checkout rows; the earlier missing-FK-index finding is resolved. Reconstructed Phase 4.2 baseline notices include public-table policy/index optimization items and SECURITY DEFINER warnings. A read-only comparison with production confirmed that production already denies both `anon` and `authenticated` execution of `guard_customer_order_write()`; that warning is staging scaffold noise. Production intentionally allows authenticated `is_admin()` and denies anonymous execution. None of these inherited notices is represented as fixed by Phase 4.3.

## Consolidated production candidate

`database/20260820_phase4_3_server_authoritative_checkout.sql` consolidates the additive Stage A schema/functions/grants/RLS into one production-candidate migration.

The consolidated candidate was destructively clean-replayed in the isolated staging project from a reconstructed Phase 4.2B commerce baseline. The first replay exposed two packaging defects: the service role lacked the lock-capable `UPDATE` privilege required by `FOR SHARE` on the private delivery tables, and the contract test assumed one exact internal `proconfig` representation for `SET search_path=''`. Both were corrected. The corrected candidate migration SHA-256 is `a0e696f5dc67fb0633073a61a141355a04cd7393e13c1ef496129a99f10b5e4c`.

Corrected clean replay evidence: **PASS**. The packaged structural contract returned `phase43_contract_status = PASS`; the rollback-only `database/tests/phase4_3_clean_replay_behavior.sql` returned `phase43_clean_replay_behavior_status = PASS`, proving canonical totals, stock/promo mutation, same-key retry, idempotency conflict, insufficient-stock rollback, and no retained failed-checkout ledger state.

The first corrected replay behavior run exposed the missing lock-capable private delivery-table privilege and therefore failed before certification. The package was corrected to grant `service_role` `SELECT, UPDATE` on `dagoldol_private.delivery_config` and `dagoldol_private.delivery_free_zones`, staging was reset a second time, and the corrected migration was replayed from the clean Phase 4.2B baseline. The final structural and rollback-only behavior runs both passed. Final hygiene showed `orders=0`, `products=0`, `promos=0`, `bundles=0`, `checkout_requests=0`, no replay Auth fixture, and no temporary test extensions.

## Current gate summary

```text
Stage A inherited source suite: FAIL — pre-existing uploaded 3.3.5 drift
Stage A local Edge unit tests: PASS (21/21)
Stage A Edge TypeScript compile: PASS
Stage A DB structural contract: PASS
Stage A resolver behavior: PASS
Stage A transaction/rollback behavior: PASS
Stage A stock concurrency: PASS
Stage A promo concurrency: PASS
Stage A idempotency concurrency: PASS
Stage A private-table RLS: PASS
Stage A Edge v4 deployment: ACTIVE / verify_jwt=true
Stage A Edge runtime/auth/CORS probe: PASS
Stage A authenticated Edge quote/commit integration: NOT PROVEN
Consolidated candidate SQL clean replay: PASS
Phase 4.1 production rollback evidence: OPEN
Stage B frontend cutover: BLOCKED
Production Phase 4.3 mutation: NOT AUTHORIZED
```

No Phase 4.3 schema/function/Edge/frontend change has been applied to the production Supabase project.
