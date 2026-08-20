# Dagoldol Phase 4.3 Stage A Candidate

This package contains the additive server-authoritative checkout backend prepared from the uploaded Dagoldol 3.3.5 source.

Do **not** deploy it directly to production yet.

Read first:

1. `docs/phase4/PHASE4.3-VERIFICATION.md`
2. `docs/phase4/PHASE4.3-PRODUCTION-PROMOTION-CHECKLIST.md`
3. `SECURITY.md`

Core artifacts:

- `database/20260820_phase4_3_server_authoritative_checkout.sql`
- `database/tests/phase4_3_contract.sql`
- `supabase/functions/checkout/`
- `tests/phase4-3-edge-integration.test.mjs`
- `tests/phase4-3-concurrency.test.mjs`

Stage A staging behavior and independent database concurrency have been proven. The deployed staging Edge Function is version 2 with JWT verification enabled.

Still-open release gates:

- replay the consolidated candidate SQL verbatim from a clean Phase 4.2B database;
- run an authenticated Edge quote/commit test with a real staging customer JWT;
- close Phase 4.1 backup/deployment identity evidence;
- resolve the inherited 3.3.5 source/test drift before Stage B frontend cutover.

The package intentionally does not remove legacy Phase 4.2B checkout interfaces. Authority removal belongs after the exact frontend cutover passes.
