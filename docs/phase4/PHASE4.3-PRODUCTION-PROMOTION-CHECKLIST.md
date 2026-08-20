# Phase 4.3 Production Promotion Checklist

Status: **NOT AUTHORIZED YET**

This checklist is intentionally stricter than the Stage A staging gate. Do not treat a staging PASS as approval to mutate production.

## Gate A — Phase 4.1 rollback evidence

All must be retained before any Phase 4.3 production mutation:

- [ ] production database backup/export point;
- [ ] Storage backup/export point;
- [ ] exact currently deployed Vercel deployment identifier;
- [ ] exact original Git SHA/revision for that deployment;
- [ ] immutable baseline tag/release marker.

## Gate B — consolidated migration replay

- [ ] replay the exact production candidate `database/20260820_phase4_3_server_authoritative_checkout.sql` against a clean isolated database restored to the verified Phase 4.2B baseline;
- [ ] run `database/tests/phase4_3_contract.sql`;
- [ ] run database behavior/rollback tests;
- [ ] run independent stock/promo/idempotency concurrency tests;
- [ ] confirm no test fixtures remain.

The current staging environment proved the staged Phase 4.3 functions and behavior, but the consolidated production-candidate SQL file must still be replayed verbatim before production use.

## Gate C — Edge Function

- [ ] deploy the exact package source under `supabase/functions/checkout/` to staging;
- [ ] `verify_jwt=true`;
- [ ] TypeScript compiler passes;
- [ ] all Edge unit tests pass;
- [ ] authenticated staging quote succeeds with a real customer JWT;
- [ ] forged monetary fields are ignored;
- [ ] authenticated commit succeeds;
- [ ] retry with same idempotency key returns the same order;
- [ ] route failure uses configured fallback;
- [ ] CORS accepts only expected production/development origins;
- [ ] logs contain no payment/address/token secrets.

## Gate D — exact frontend baseline

The uploaded 3.3.5 ZIP is release-labeled 3.3.5 but its untouched verification suite is internally inconsistent. Before Stage B:

- [ ] resolve or explicitly approve the inherited 3.3.5 source/test drift;
- [ ] record runtime hashes before browser checkout edits;
- [ ] write failing Phase 4.3 browser source-contract tests;
- [ ] cut browser quote/commit over to the Edge Function;
- [ ] run the full source/runtime suite.

## Gate E — post-cutover authority removal

Only after the deployed frontend no longer uses the compatibility interfaces:

- [ ] revoke authenticated execution on `decrement_stock_for_order(jsonb)`;
- [ ] revoke authenticated execution on `restore_stock_for_order(jsonb)`;
- [ ] revoke authenticated execution on legacy `place_order(...)`;
- [ ] remove direct authenticated `orders` INSERT compatibility policy/grant;
- [ ] run the post-cutover contract proving browser roles cannot create orders or mutate commerce state directly.

## Production sequence

1. Freeze deployment and capture Gate A evidence.
2. Apply the verified Phase 4.3 additive migration.
3. Run read-only Phase 4.3 contract checks.
4. Deploy the verified checkout Edge Function with JWT verification.
5. Perform authenticated production quote smoke test without committing an order where practical.
6. Deploy the tested frontend cutover.
7. Perform one controlled checkout/retry smoke test.
8. Apply the post-cutover authority-removal migration.
9. Rerun security advisor, contract tests, and frontend smoke tests.
10. Retain logs/hashes/rollback evidence in the release record.
