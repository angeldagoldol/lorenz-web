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

- [x] replay the exact production candidate `database/20260820_phase4_3_server_authoritative_checkout.sql` against a clean isolated database restored to the Phase 4.2B commerce baseline;
- [x] run `database/tests/phase4_3_contract.sql`;
- [x] run `database/tests/phase4_3_clean_replay_behavior.sql` rollback-only behavior tests;
- [ ] run independent stock/promo/idempotency concurrency tests;
- [ ] confirm no test fixtures remain.

The corrected consolidated production-candidate SQL has now been replayed atomically from a clean Phase 4.2B staging commerce baseline. The packaged contract and rollback-only clean-replay behavior test both passed, and final hygiene confirmed no test fixtures remained. Independent concurrency had already passed on the same resolver/commit logic before the clean replay; rerunning that concurrency suite after the private-table lock-grant/test-assertion correction remains a conservative release check.

## Gate C — Edge Function

- [x] deploy the exact package source under `supabase/functions/checkout/` to staging;
- [x] `verify_jwt=true`;
- [x] TypeScript compiler passes;
- [x] all Edge unit tests pass;
- [ ] authenticated staging quote succeeds with a real customer JWT;
- [x] forged monetary fields are ignored by Edge request normalization and the clean-replay database behavior test;
- [ ] authenticated commit succeeds;
- [ ] retry with same idempotency key returns the same order;
- [x] route failure uses configured fallback in the Edge unit suite and database resolver behavior;
- [x] CORS accepts the configured production/development allowlist; fresh staging v4 runtime probe returned the expected production origin;
- [x] logger source is restricted to correlation ID, operation, truncated user reference, stable error code, and duration; it does not log payment/address/token payloads.

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
