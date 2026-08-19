# Dagoldol Phase 4.2 Security Package — Corrected 4.2A1 / 4.2A2 Split

## Current status

This package corrects the first Phase 4.2A package after the live Supabase SQL Editor returned:

```text
ERROR: must be owner of table objects
```

Root cause was verified from the live project: hosted Supabase owns `storage.objects` and `storage.buckets` with `supabase_storage_admin`, while SQL Editor runs as `postgres`. The corrected package no longer attempts owner-only DDL on the managed Storage tables.

Phase 4.2 remains **OPEN**. This is still staging-first and is not authorization to run the public policy cutover directly on production.

## Files

### Database

- `database/20260820_phase4_2_live_contract.sql` — read-only live contract export.
- `database/20260820_phase4_2a1_public_zero_trust_rls.sql` — public-schema/RPC/grant hardening only; contains no Storage policy DDL.
- `database/20260820_phase4_2b_checkout_authorization_gate.sql` — read-only checkout/schema readiness diagnostic; not a migration.
- `database/tests/phase4_2_policy_contract.sql` — read-only public authorization structural test.
- `database/tests/phase4_2_rls_regression.sql` — staging-only transaction/rollback behavior test.
- `database/tests/phase4_2_storage_regression.sql` — read-only Storage policy security test.

### Storage deployment

- `docs/phase4/PHASE4.2-STORAGE-POLICY-UI-CHECKLIST.md` — exact Storage Policy UI changes for the hosted project. This replaces Storage DDL in the failed combined migration.
- `scripts/phase4-2-storage-runtime.mjs` — staging-only Storage API owner/IDOR/admin regression.

### Security and status

- `SECURITY.md`
- `FRONTEND-INTEGRATION-REQUIRED.md`
- `PHASE4.2-IMPLEMENTATION-STATUS.md`
- `docs/phase4/evidence/PHASE4.2-LIVE-FINDINGS.md`

## Safe execution order

1. Close the Phase 4.1 rollback evidence first.
2. Obtain/use an isolated staging project/branch.
3. Run `node scripts/verify-phase4-2-package.mjs` locally.
4. Run `database/20260820_phase4_2_live_contract.sql` and retain its output.
5. Apply `database/20260820_phase4_2a1_public_zero_trust_rls.sql` to staging.
6. Run `database/tests/phase4_2_policy_contract.sql`.
7. Apply `docs/phase4/PHASE4.2-STORAGE-POLICY-UI-CHECKLIST.md` through **Storage -> Policies -> OBJECTS**.
8. Run `database/tests/phase4_2_storage_regression.sql`.
9. Pair the exact current 3.3.5 frontend with the safe directory RPCs.
10. Run `database/tests/phase4_2_rls_regression.sql` and the staging Storage runtime test.
11. Continue Phase 4.2B checkout/stock authority removal.
12. Re-run the full application regression suite and Supabase security advisors.
13. Promote only the exact staging-tested set to production after all gates pass.

## What must not be done

- Do not run the removed `20260820_phase4_2a_zero_trust_rls_private_data.sql`; it was the combined file that hit the managed Storage ownership error.
- Do not run `ALTER TABLE storage.objects ...` from the normal hosted SQL Editor migration.
- Do not change ownership of Supabase-managed Storage entities.
- Do not grant `postgres` membership in `supabase_storage_admin` as a workaround.
- Do not recreate `storage_public_read`, `storage_avatar_upload_own`, or `storage_payment_proof_upload_own`.
- Do not mark Phase 4.2 complete while authenticated customers can call the stock helper RPCs or direct commercial order INSERT remains.
