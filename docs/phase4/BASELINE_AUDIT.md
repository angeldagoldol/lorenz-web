# Dagoldol Phase 4.1 — Baseline Audit

Status: **PARTIAL — SOURCE BASELINE COMPLETE; LIVE DATABASE GATE OPEN**

Audit date: 2026-08-19 (+08:00 user locale)

## 1. Scope and provenance

The audited source is the complete supplied archive `DAGOLDOL-PHASE3-3-5-SMART-DELIVERY-ADMIN-PIN-FULL.zip` (Dagoldol 3.3.5), not a reconstruction from snippets.

- Archive SHA-256: `53c08fcfeb14568b8aab7ceeef08f01391db1ce886d6c448cdd1b330e3b694e4`
- Source files in archive: 125
- Reconstructed local audit Git commit: `c525246b1f227502526a85fc5beb877778b00e52`
- Reconstructed tree: `e23b0bd33f8bf06244c57306dc0fe4145c0a4d47`
- Local audit tag: `phase4-audit-baseline-2026-08-19`
- Source manifest: `docs/phase4/BASELINE_SOURCE_MANIFEST.sha256`

**Important:** the archive did not contain `.git`, and the execution environment could not resolve GitHub. Therefore the local audit commit/tag above is a reproducible audit identity, **not a claim about the current GitHub/Vercel production commit**. The actual production commit remains an open Phase 4.1 evidence item.

## 2. Application architecture observed

Current platform:

- Vanilla HTML/CSS/JavaScript storefront/admin application.
- Supabase Auth, PostgREST, RPC, Storage, Realtime and Edge Functions.
- Vercel static deployment plus rewrites.
- Leaflet/OpenStreetMap/Nominatim/OSRM delivery location stack.
- Build-time catalogue generator that queries Supabase and emits crawlable product pages.

Key source size:

| File | Lines | Primary responsibility |
|---|---:|---|
| `script.js` | 7,260 | auth, state, catalogue, cart, checkout, orders, chat, admin, uploads, analytics |
| `style.css` | 3,378 | base/UI/responsive CSS |
| `phase3-fixes.css` | 1,195 | Phase 3 responsive/route/visual overrides |
| `delivery-map.js` | 1,122 | Leaflet, reverse geocoding, reliable device location |
| `index.html` | 1,002 | storefront, checkout, account/admin and modal DOM |
| `phase2-accessibility.js` | 564 | accessibility behavior |
| `scripts/generate-public-catalogue.mjs` | 532 | deploy-time public catalogue generation |
| `database/phase3-security-and-storage.sql` | 409 | ratings + storage hardening |
| `scripts/verify-source.mjs` | 325 | source contract checks |

`script.js` contains 327 named functions and 67 `innerHTML` mutation sites. This is the principal architecture concentration risk.

## 3. Supabase surface observed in frontend

Tables directly accessed from `script.js`:

- `activity`
- `brands`
- `bundles`
- `dm_messages`
- `dm_threads`
- `flash_sales`
- `messages`
- `orders`
- `products`
- `profiles`
- `promo_codes`
- `ratings`
- `settings`

RPCs:

- `decrement_stock_for_order`
- `restore_stock_for_order`
- `get_public_recommendation_signals`

Edge Function:

- `delete-auth-user`

Realtime channels:

- order changes for recommendations;
- DM message changes;
- DM thread changes;
- chat presence.

Storage buckets referenced by source/migration:

- `avatars`
- `payment-proofs`
- `product-images`
- `brand-logos`
- `payment-settings`

## 4. Source verification baseline

### Native Node verification

Command:

```bash
npm run verify
```

Result: **PASS**.

Observed total: **72 tests passed, 0 failed** across the native Node contract suites, followed by successful `scripts/verify-source.mjs` output.

Covered areas include:

- multi-device auth/session behavior;
- auth network resilience;
- payment settings contract;
- mobile fast bootstrap;
- delivery-map contract;
- configurable delivery origin;
- Leaflet mobile reliability;
- geolocation resilience;
- current-location behavior;
- landmark map UX;
- smart address/admin pin behavior.

### Playwright/Python runtime suites

Executed directly because these files are standalone scripts rather than pytest-discoverable tests:

- `tests/delivery-location-runtime.spec.py` — PASS
- `tests/device-auth-runtime.spec.py` — PASS
- `tests/mobile-matrix.spec.py` — PASS
- `tests/mobile-resilience.spec.py` — PASS
- `tests/payment-settings-runtime.spec.py` — PASS
- `tests/runtime_mobile_fast.py` — PASS for 320/360/390/414/430 widths
- `tests/smart-delivery-runtime.spec.py` — PASS

`tests/desktop-regression.spec.py` is **BLOCKED** because it hard-codes the absent comparison directory `/mnt/data/DAGOLDOL-PASTED-TEXT1-MOBILE-FIX`.

### Production build baseline

Command:

```bash
npm run build
```

Result in this audit environment: **INFRASTRUCTURE FAILURE**.

The build-time catalogue generator attempted to resolve the live Supabase hostname and failed with `EAI_AGAIN`. This environment has no outbound DNS/network access to the project. This result is not classified as an application-code failure, but it proves the build has a live-Supabase availability dependency.

## 5. Database evidence status

The archive contains:

- an old `.vscode/Supabase schema · SQL` snapshot;
- the Phase 1 read-only source-gap export;
- `database/00-phase3-live-preflight.sql`;
- `database/phase3-security-and-storage.sql`;
- Supabase linked-project metadata identifying project ref `rvrjkfbenramappteuae`.

The old schema is **not sufficient** to represent the modern frontend. The current frontend expects modern tables/columns such as brands, bundles, promos, DM tables, variant stock, payment fields and additional order fields that are absent from that old schema snapshot.

A connected Supabase plugin is installed/enabled for this task, but the current runtime tool registry has not exposed an invokable Supabase SQL action. No live SQL result is therefore claimed.

A more complete read-only preflight has been added at:

`database/phase4/00-phase4-live-baseline-preflight.sql`

It captures:

- all public objects;
- columns/defaults;
- constraints;
- indexes;
- RLS-enabled status;
- all public policies;
- functions/security-definer status;
- triggers;
- Realtime publication membership;
- Storage buckets/limits;
- Storage policies;
- presence of known Dagoldol security guards.

**Phase 4.1 exit gate remains CLOSED until this query is executed against the live project and its results are retained.**

## 6. Security baseline observations

### Phase 1 guards are separate from the Phase 3 migration

The old schema's `profiles` UPDATE policy allows an owner to update their row without making `role` immutable, and the old `orders` UPDATE policy broadly permits owner/admin updates.

The Phase 1 hotfix package defines:

- `guard_profile_role_client()` + trigger;
- `guard_customer_order_write()` + trigger.

However, `database/phase3-security-and-storage.sql` does **not** recreate those two guards. Its main scope is purchase-bound ratings, aggregate recommendations and Storage hardening.

Therefore live deployment status of the Phase 1 guards is a P0 verification item. Source presence alone does not prove production enforcement.

### Client-authoritative checkout remains visible

`script.js` computes in the browser:

- subtotal;
- bulk fee;
- delivery fee;
- promo discount;
- total;
- payment due now/later;
- complete order JSON including item prices.

It then decrements stock by RPC, inserts the browser-built order, and increments promo usage separately. This is the top known commerce-integrity defect for Phase 4.3.

### Cancellation/restock is compensating, not transactional

The customer cancellation path updates `orders.cancelled`, then separately restores stock. On restore failure it attempts to roll cancellation back. This is not one database transaction.

### Promo consumption is non-atomic

`incrementPromoUsage()` performs SELECT `used_count`, then UPDATE `used_count + 1`. Concurrent users can race this sequence.

### Order idempotency is absent

The browser creates order IDs locally and `isSubmittingOrder` only protects the current page instance. Cross-tab/device/network retry duplication is not transactionally prevented by an explicit idempotency key.

### Direct-message authorization is live-schema dependent

The frontend filters thread queries by participant IDs, but frontend query filters are not authorization. DM-table RLS is not established by the supplied old schema or Phase 3 security migration; live policies must be inspected before Phase 4.2.

## 7. Reliability baseline observations

- Build success currently depends on reaching live Supabase during public catalogue generation.
- Map/navigation depends on external Leaflet CDNs, OpenStreetMap tiles, Nominatim and public OSRM endpoints.
- The app has meaningful local/mobile resilience and map fallback logic, but production provider/rate-limit assumptions still need formal review.
- Account deletion is protected by an Edge Function, but its destructive sequence deletes user Storage before Auth deletion and can delete the profile before a second Auth deletion attempt. A later Auth failure could leave partially deleted account state. This requires transactional/compensating redesign in a later integrity phase.

## 8. What is already worth preserving

- Explicit local-device logout rather than global session revocation.
- Source-level auth network resilience and same-origin fallback.
- Private payment-proof object path with short-lived signed preview.
- Re-encoding uploaded images to JPEG before Storage upload.
- Purchase-bound rating migration design.
- Lazy/isolated admin tab rendering.
- Customer profile pin + immutable order-address snapshot direction.
- Leaflet map cleanup and geolocation resilience tests.
- Source verification command and several regression suites.
- Private-route no-index headers and public product-page generation.

## 9. Phase 4.1 exit criteria

| Criterion | Status |
|---|---|
| Reproducible source baseline recorded | PASS |
| Baseline archive hash recorded | PASS |
| Audit Git commit/tag recorded | PASS (reconstructed audit identity) |
| Actual production Git/Vercel commit recorded | BLOCKED |
| Backups documented | PASS for supplied source archive; live DB/Storage snapshot still external |
| `npm run verify` | PASS |
| Runtime regression baseline | PASS with one historical comparison test blocked |
| Build baseline | INFRASTRUCTURE-BLOCKED (Supabase DNS unavailable here) |
| Complete live schema/RLS/Storage export | **BLOCKED — REQUIRED** |
| Critical issue register created | PASS |
| Architecture/data-flow inventory created | PASS |
| Rollback point established | PASS for source; live database backup not confirmed |

## 10. Gate decision

**PHASE 4.1 IS NOT YET CLOSED. DO NOT APPLY PHASE 4.2 SECURITY MIGRATIONS FROM ASSUMPTIONS.**

The next safe action is execution of `database/phase4/00-phase4-live-baseline-preflight.sql` through the connected Supabase project, followed by reconciliation of the result with `ISSUE_REGISTER.md`.
