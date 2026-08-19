# Dagoldol Phase 4.2 Security Package

## Current status

This package is a **staging-first implementation package**, not a production deployment. Phase 4.2 remains open because the exact Dagoldol 3.3.5 frontend source is not available in the writable workspace and the live checkout/function schema is inconsistent.

No production Supabase mutation was performed while creating this package.

## Files

### Database

- `database/20260820_phase4_2_live_contract.sql` — read-only live contract export.
- `database/20260820_phase4_2a_zero_trust_rls_private_data.sql` — canonical RLS/Storage/private-data migration candidate.
- `database/20260820_phase4_2b_checkout_authorization_gate.sql` — read-only checkout/schema readiness diagnostic; not a migration.
- `database/tests/phase4_2_policy_contract.sql` — structural authorization contract test.
- `database/tests/phase4_2_rls_regression.sql` — staging-only transaction/rollback behavior test.
- `database/tests/phase4_2_storage_regression.sql` — read-only Storage policy structural test.

### Runtime verification

- `scripts/phase4-2-storage-runtime.mjs` — staging-only Storage API owner/IDOR/admin regression.
- `scripts/verify-phase4-2-package.mjs` — local package/source consistency check.

### Security and status

- `SECURITY.md` — Dagoldol security boundary and role matrix.
- `FRONTEND-INTEGRATION-REQUIRED.md` — exact source changes required once the current 3.3.5 tree is available.
- `PHASE4.2-IMPLEMENTATION-STATUS.md` — authoritative current phase status.
- `docs/phase4/evidence/PHASE4.2-LIVE-FINDINGS.md` — read-only findings captured from the connected production project.

### Design / plan

- `docs/2026-08-20-dagoldol-phase4-2-zero-trust-authorization-design.md`
- `docs/superpowers/plans/2026-08-20-dagoldol-phase4-2-zero-trust-authorization.md`

## Safe execution order

1. Close Phase 4.1 backup, Storage backup, Vercel deployment-SHA, and immutable-tag evidence.
2. Copy this package into the exact current Dagoldol 3.3.5 repository tree.
3. Run `node scripts/verify-phase4-2-package.mjs`.
4. Run `database/20260820_phase4_2_live_contract.sql` against the target environment and retain its output.
5. Confirm the staging schema still matches the migration preflight.
6. Apply `database/20260820_phase4_2a_zero_trust_rls_private_data.sql` to **staging only**.
7. Update the exact 3.3.5 `script.js` to use the two safe profile-directory RPCs before browser testing.
8. Run the policy/RLS/Storage tests on staging.
9. Run the Phase 4.2B diagnostic and reconcile the real 3.3.5 checkout/payment contract with the live `orders` schema.
10. Implement trusted checkout + cancellation and remove browser stock/order authority.
11. Run the full existing Dagoldol verification/build/runtime regression suite plus the Phase 4.2 tests.
12. Re-run Supabase security advisors.
13. Only after the exit gate is clean, promote the exact tested source/migrations to production.

## What must not be done

- Do not run the 4.2A migration directly on production before the Phase 4.1 rollback point exists.
- Do not replace the 3.3.5 `script.js` with an older Phase 3 copy.
- Do not mark Phase 4.2 complete while authenticated customers can execute the stock helper RPCs.
- Do not restore broad profile SELECT, Storage read, settings-write, promo-write, or generic ratings policies to make frontend errors disappear.
- Do not manually delete rows from `storage.objects` to remove files; use the Storage API.
