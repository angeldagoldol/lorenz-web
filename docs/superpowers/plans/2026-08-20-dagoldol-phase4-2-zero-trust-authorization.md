# Dagoldol Phase 4.2 Zero-Trust Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dagoldol's permissive/duplicated Supabase authorization with one fail-closed database and Storage security contract, while preserving legitimate storefront/admin flows and preventing cross-account data exposure, privilege escalation, stock manipulation, trusted-order tampering, and identity impersonation.

**Architecture:** Use explicit PostgreSQL GRANT/REVOKE as the first boundary, canonical per-operation RLS as the row boundary, fixed-search-path helper functions and triggers for field/state integrity, and narrow RPCs for safe cross-user directory lookup and derived state. Production deployment is split into a non-commerce authorization hardening migration and a checkout cutover gate because the live `orders` schema and current `place_order()` are inconsistent with the retrievable frontend checkout contract; the checkout cutover must not be applied until the exact current 3.3.5 `script.js` is available and updated as a complete file.

**Tech Stack:** PostgreSQL 17 / Supabase RLS and Storage, Supabase Auth/JWT GUCs, vanilla JavaScript/Supabase JS frontend, Node source verification.

**Spec:** `docs/2026-08-20-dagoldol-phase4-2-zero-trust-authorization-design.md`

## Global Constraints

- Production project: `rvrjkfbenramappteuae`; do not mutate it before Phase 4.1 rollback evidence is closed.
- Preserve the existing vanilla HTML/CSS/JavaScript + Supabase architecture.
- Do not delete business records as part of authorization migration.
- Preserve `profiles_guard_role_client` and `orders_guard_customer_write` as defense in depth.
- Do not expose `service_role` or privileged credentials to browser code.
- `payment-proofs` remains private and owner/admin scoped.
- The current latest confirmed release is Dagoldol 3.3.5; do not replace its `script.js` with an older Phase 3 copy.
- Phase 4.2 is not complete until customer direct stock mutation is removed and the frontend uses a server-authoritative checkout command.

---

### Task 1: Capture and codify the live authorization baseline

**Files:**
- Create: `database/20260820_phase4_2_live_contract.sql`
- Create: `database/tests/phase4_2_policy_contract.sql`

**Interfaces:**
- Consumes: live tables, policies, grants, Storage buckets, functions and triggers from Supabase project `rvrjkfbenramappteuae`.
- Produces: repeatable read-only evidence and post-migration structural assertions.

- [ ] **Step 1: Write the read-only contract export** covering all 19 public application tables, relevant functions, triggers, grants, five Storage buckets, Storage policies, and `orders` columns.
- [ ] **Step 2: Add explicit assertions for the confirmed vulnerable alternatives**: `public full access`, broad settings writes, broad payment-proof read, broad ratings INSERT, broad profile SELECT, and exposed stock helpers.
- [ ] **Step 3: Run the export against production as read-only evidence.** Expected: it reproduces the live contract already inspected in this session without changing rows or policies.
- [ ] **Step 4: Save output into Phase 4.1 evidence before any later production deployment.**

### Task 2: Canonicalize non-commerce RLS and Storage authorization

**Files:**
- Create: `database/20260820_phase4_2a_zero_trust_rls_private_data.sql`
- Test: `database/tests/phase4_2_rls_regression.sql`
- Test: `database/tests/phase4_2_storage_regression.sql`

**Interfaces:**
- Consumes: `public.is_admin()`, existing profile/order guards, current public tables and Storage buckets.
- Produces: canonical RLS names prefixed `p42_`, safe profile-directory RPCs, DM integrity triggers, explicit grants, private payment-proof policy.

- [ ] **Step 1: Write failing structural tests** that reject broad legacy policies and verify expected grants/policies do not yet exist.
- [ ] **Step 2: Run the structural tests against the current live baseline read-only.** Expected: FAIL because legacy permissive policies and stock/helper grants are present.
- [ ] **Step 3: Implement the transactional 4.2A migration.** It must preflight the verified tables/columns, normalize `is_admin()`, canonicalize policies for profiles/catalogue/promos/settings/messages/activity/chat/DM/ratings/gift-card/subscription tables, harden Storage, and install safe directory + DM guard functions.
- [ ] **Step 4: Keep current customer checkout dependencies explicitly out of 4.2A.** Do not revoke authenticated stock-helper execution or direct customer order INSERT in this migration because the exact 3.3.5 checkout file is unavailable and the current live `place_order()` references absent columns.
- [ ] **Step 5: Run SQL static/lint checks available locally and review every `SECURITY DEFINER` function for fixed `search_path` and restricted EXECUTE grants.**
- [ ] **Step 6: Apply only to an isolated Supabase branch/staging project after Phase 4.1 backup evidence exists.**
- [ ] **Step 7: Run RLS + Storage regression tests.** Expected: profile IDOR, settings/promo writes, cross-DM access, payment-proof cross-read, fake ratings and admin-media writes by customers are denied; admin and owner flows remain allowed.

### Task 3: Cut checkout over to a trusted command boundary

**Files:**
- Create: `database/20260820_phase4_2b_checkout_authorization_gate.sql`
- Modify: `script.js` only from the exact latest Dagoldol 3.3.5 source
- Modify: `scripts/verify-source.mjs`
- Test: existing checkout/payment/mobile regressions plus Phase 4.2 security tests

**Interfaces:**
- Consumes: exact 3.3.5 frontend order payload, current 19-column `orders` schema, `products.sizes`, bundles, promo codes, stock helpers.
- Produces: one authenticated browser-facing checkout RPC; stock helpers become internal-only; direct customer order INSERT is removed.

- [ ] **Step 1: Acquire the exact latest complete `script.js`.** Do not use the Aug 14/15 Phase 3 copies because 3.3.5 includes later map/address/admin-pin behavior.
- [ ] **Step 2: Write failing source tests** proving browser code no longer calls `decrement_stock_for_order`, `restore_stock_for_order`, direct `orders.insert`, or direct promo `used_count` mutation.
- [ ] **Step 3: Reconcile the live schema mismatch.** Current production `orders` has 19 columns and lacks `payment_reference`, `payment_proof`, `half_payment`, `amount_due_now`, and `amount_due_later`, while the retrievable frontend and live `place_order()` reference them. Decide from the exact latest source whether those fields must be added in the versioned migration or the checkout contract must be reduced; integrate the decision through DB/RPC/frontend/tests together.
- [ ] **Step 4: Replace/repair the checkout RPC** so it recomputes current product/bundle prices, validates promo eligibility and usage under lock, validates/decrements stock atomically, binds `user_id` to `auth.uid()`, and inserts only existing/approved order columns.
- [ ] **Step 5: Update the exact 3.3.5 `script.js` as a complete file** to call the trusted checkout RPC and consume its returned totals/order ID; remove browser stock and promo mutations.
- [ ] **Step 6: Revoke `EXECUTE` on stock helpers from PUBLIC/anon/authenticated and revoke direct customer order INSERT.** Preserve internal execution from the checkout function owner/trusted roles.
- [ ] **Step 7: Run checkout regression tests and tamper tests.** Expected: forged prices/discounts/totals/stock operations fail; legitimate checkout still succeeds.

### Task 4: Verify privilege escalation, IDOR and identity integrity behavior

**Files:**
- Test: `database/tests/phase4_2_rls_regression.sql`
- Test: `database/tests/phase4_2_storage_regression.sql`

**Interfaces:**
- Consumes: completed 4.2A + 4.2B staging schema.
- Produces: executable pass/fail evidence for the Phase 4.2 exit gate.

- [ ] **Step 1: Run customer self-promotion test.** Expected: `profiles.role = 'admin'` denied and stored role unchanged.
- [ ] **Step 2: Run Customer A → Customer B profile/order/location/message tests.** Expected: no rows / denied.
- [ ] **Step 3: Run trusted-order mutation tests.** Expected: own `total`, `items`, `delivery_fee`, status and foreign orders cannot be modified by a customer.
- [ ] **Step 4: Run DM impersonation tests.** Expected: participant IDs, sender ID/username, message body and timestamps cannot be forged/re-written; reaction changes cannot forge another UID.
- [ ] **Step 5: Run ratings tests.** Expected: fake/non-delivered/duplicate ratings denied; valid delivered purchased rating allowed.
- [ ] **Step 6: Run Storage tests.** Expected: anon/cross-user payment-proof reads denied; owner proof access and admin verification allowed; customer writes to admin media buckets denied.
- [ ] **Step 7: Run admin regressions.** Expected: legitimate catalogue/settings/promo/order/account/support/payment-proof actions remain available to verified admins.

### Task 5: Document the security boundary and production gate

**Files:**
- Create: `SECURITY.md`
- Create: `PHASE4.2-IMPLEMENTATION-STATUS.md`

**Interfaces:**
- Consumes: approved design, migration contract, test evidence, remaining known blockers.
- Produces: operational security policy and an auditable phase status.

- [ ] **Step 1: Document trust boundaries, role matrix, privileged fields, Storage rules, RPC rules, and vulnerability reporting guidance in `SECURITY.md`.**
- [ ] **Step 2: Record every remaining blocker in `PHASE4.2-IMPLEMENTATION-STATUS.md`.** In particular: exact 3.3.5 source retrieval, checkout/live-schema reconciliation, staging execution, and Phase 4.1 backup/deployment identity.
- [ ] **Step 3: Run Supabase security advisors on staging after migrations.** Resolve or explicitly justify every remaining exposed `SECURITY DEFINER` function.
- [ ] **Step 4: Run `npm run verify`, `npm run build`, existing runtime regressions, and the new security suites on the exact release tree.** Record actual outputs only.
- [ ] **Step 5: Mark Phase 4.2 CLOSED only if 4.2A and 4.2B are both applied/tested and the mandatory exit-gate tests pass.**
