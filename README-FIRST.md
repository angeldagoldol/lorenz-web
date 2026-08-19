# Dagoldol Phase 4.2B — Read This First

## Do not run the old Phase 4.2B diagnostic as a migration

The prior `20260820_phase4_2b_checkout_authorization_gate.sql` was read-only evidence only. This package contains the actual compatibility hardening migration.

## Files

1. `database/00_phase4_2b_preflight.sql`
   - read-only production preflight;
   - require `phase42b_preflight_status = READY` before applying the migration.

2. `database/20260820_phase4_2b_commerce_authority_compat.sql`
   - actual Phase 4.2B migration candidate;
   - adds the five checkout/payment columns missing from live `orders`;
   - makes public stock RPCs non-mutating compatibility calls;
   - moves actual stock mutation into a private database function;
   - canonicalizes product/bundle prices, flash sale, bulk fee and promo use in the order transaction;
   - restores stock atomically on cancellation;
   - repairs `place_order()` so it compiles against the reconciled order schema.

3. `database/tests/phase4_2b_contract.sql`
   - read-only structural verifier after migration.

4. `database/tests/phase4_2b_behavior.sql`
   - staging-only behavioral regression;
   - performs temporary writes and ends with `ROLLBACK`.

5. `docs/phase4/PHASE4.2B-STATUS.md`
   - exact security boundary and residual Phase 4.3 work.

6. `SECURITY.md`
   - full Phase 4.2 authorization/security contract updated for the Phase 4.2B commerce boundary.

## Deployment order

Do this on **staging / isolated Supabase first**:

```text
1. 00_phase4_2b_preflight.sql   -> require READY
2. 20260820_phase4_2b_commerce_authority_compat.sql
3. phase4_2b_contract.sql       -> require PASS
4. phase4_2b_behavior.sql       -> staging only; must complete and ROLLBACK
5. existing Phase 4.2 RLS tests
6. existing Phase 4.2 Storage tests
7. browser checkout/cancel/admin regression
```

Do not promote to production before the staging sequence passes.

## What this deliberately does not claim

The migration does not reproduce Nominatim/OSRM road-route quoting in PostgreSQL. The current delivery quote remains a browser-produced input; Phase 4.2B only rejects invalid/negative numeric values and does not invent a new maximum fee. Full server-authoritative delivery pricing and true request idempotency belong to Phase 4.3 under the master specification.
