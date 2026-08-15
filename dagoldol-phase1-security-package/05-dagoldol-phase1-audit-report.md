# Dagoldol Phase 1 — Coverage, Architecture, Security & RLS

Status: **Partial production-readiness audit**. The frontend source is newer than the supplied Supabase schema export, so modern-table and Storage policy claims remain blocked until the live export is collected with `03-dagoldol-phase1-source-gap-export.sql`.

## Executive summary

- Biggest architecture issue: the single `script.js` IIFE mixes DOM rendering, shared state, Supabase data access, client business calculations, Realtime, uploads, admin CRUD, bundles, promotions, checkout, and chat. Vanilla ES modules are sufficient; a framework migration is not justified by the inspected code.
- Biggest security issue: the supplied `profiles` UPDATE policy lets a user update their entire own row while `role` accepts `customer` or `admin`. This creates a privilege-escalation path unless DB-side role immutability exists in production.
- Most dangerous remaining issue: checkout persists client-calculated prices, discount, fees, totals and payment fields; stock decrement, order INSERT and promo usage occur across separate client/database operations.
- KEEP: Supabase Auth/session use, RLS as the intended authorization boundary, escaped HTML helpers, the move toward atomic stock RPCs, and the existing restrictive script CSP direction.
- Direction: apply the source-grounded DB guard first, export the live schema/policies/functions/storage config, then replace browser-authoritative checkout with one transactional server command. Modularize Admin → Bundles after its real schema/RLS is known.

## Step 1 — Audit coverage

| Source | Inspected | Major areas covered |
|---|---|---|
| `index.html` | Yes | CSP, authentication UI, catalogue, checkout, payment proof, admin tabs, chat DOM |
| `style.css` | Yes | active styles, repeated responsive blocks, late overrides, hidden sticker system |
| `script.js` | Partial but substantial | Auth/session, products, bundles, promos, checkout, stock RPC calls, orders, ratings, uploads, chat, admin |
| Supabase schema | Yes, but stale vs JS | profiles/products/orders/messages/activity/ratings and policies |
| RLS policies | Partial | only policies present in supplied old export |
| Storage policies | No | no storage.buckets/storage.objects export supplied |

### Verified facts

1. `script.js` uses a single Supabase client inside one IIFE and contains most application concerns.
2. Current JS expects modern DB objects/columns absent from the supplied schema: `settings`, `brands`, `bundles`, `flash_sales`, `promo_codes`, DM tables, modern product fields, modern order payment/promo fields, and stock RPCs.
3. `profiles.role` is privilege-bearing because the UI enters admin mode when the loaded profile role is `admin`.
4. Supplied profile UPDATE RLS is row-owner/admin based but does not make `role` immutable.
5. Current checkout constructs the complete order row in the browser, decrements stock by RPC, inserts the order, restores stock if insert fails, then increments promo usage separately.
6. Current customer order actions directly UPDATE `cancelled` and `rated`; admin directly UPDATEs `status_override`.
7. Current rating insertion writes only `product_id` and `value`; it is not transactionally tied to an owned order.
8. Current payment proof uploads use Supabase Storage and obtain a public URL; Storage bucket privacy/RLS is not supplied.
9. Current HTML CSP has `script-src 'self' https://cdn.jsdelivr.net` and `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`; inline style attributes/templates exist, so removing `unsafe-inline` immediately would break current styling.
10. Guest catalogue browsing is an explicit product behavior, while the supplied old `products` SELECT policy only permits authenticated sessions.

### Missing evidence and blocked fixes

- Current live DDL + constraints + grants for `orders`, `products`, `settings`, `brands`, `bundles`, `flash_sales`, `promo_codes`, `dm_threads`, `dm_messages`.
- Current complete `pg_policies` export.
- Definitions/privileges for `decrement_stock_for_order` and `restore_stock_for_order`.
- `storage.buckets` rows and every `storage.objects` policy.
- Current `delete-auth-user` Edge Function implementation.
- Exact full raw current `script.js` in a directly writable workspace if a complete byte-preserving frontend replacement is required.

These gaps block the final server-authoritative checkout RPC, atomic stock/order/promo transaction, atomic cancellation/restock operation, ratings persistence redesign, DM policies, bundle policies, promotion policies, settings policies, and Storage policies.

## Step 2 — Current system map

Architecture: **DOM/UI → shared IIFE state → client business logic → Supabase JS calls → Postgres / Storage / Realtime**.

| Feature | HTML | JS | Supabase | Architectural concern |
|---|---|---|---|---|
| Auth | login/signup/reset cards | session/login/signup/reset handlers | Auth + profiles | admin decision depends on mutable profile role under supplied RLS |
| Catalogue | `#catalogue` | product loaders/renderers | products | guest UI vs old authenticated-only SELECT policy |
| Bundles | `#bundles-section`, admin bundle tab | bundle CRUD/rendering | bundles | schema/RLS absent from export |
| Cart | cart modal | profile/guest cart state | profiles.cart | broad own-profile UPDATE policy |
| Checkout | `#order-form` | fees/totals/payment/order submit | orders + stock RPCs | browser is commercial authority |
| Promotions | checkout/admin | validation + used_count increment | promo_codes | read→modify→write race |
| Ratings | order cards | submitRating/addRating | orders + ratings | non-atomic and weak ownership binding |
| Payment proof | file input | Storage upload/public URL | Storage | privacy/RLS unknown |
| Direct messages | chat modal | thread/message + Realtime | DM tables | schema/RLS absent |
| Admin | admin tabs | direct CRUD | many tables | frontend gating must never replace RLS |

## Code classification before refactor

| Area | Classification | Reason |
|---|---|---|
| Main `script.js` IIFE | ACTIVE | current app runtime |
| Bundle admin functions | ACTIVE | wired to `data-tab="bundles"` and Supabase CRUD |
| `--charcoal-*` / brass compatibility token family | ACTIVE/LEGACY | still referenced by current selectors |
| repeated `@media (max-width:480px)` groups | DUPLICATED/ACTIVE | multiple live cascade blocks |
| `body` background followed later by transparent background | ACTIVE OVERRIDE | current LiquidChrome background architecture |
| `.page-sticker` system | DEAD/UNKNOWN | base rule sets `display:none`; no inspected active rule enables it |
| `pill-buttons.css` | ACTIVE | explicitly loaded after `style.css` |
| `liquid-chrome.js` | ACTIVE | explicitly loaded as module |

## Step 3 — Architecture

### Recommended target

```text
/
├── index.html
├── style.css
├── pill-buttons.css
├── config.js
├── liquid-chrome.js
├── script.js                     # temporary bootstrap/legacy shell
└── js/
    ├── core/
    │   ├── supabase-client.js
    │   └── format.js
    ├── data/
    │   └── bundles.js
    └── features/
        └── admin-bundles.js
```

Do **not** migrate the full application at once. Current Admin → Bundles is a suitable first slice because its boundaries are observable:

- State: `products`, bundle rows, `BUNDLE_MAX_ROWS`.
- DOM: `#admin-tab-bundles`, `#admin-add-bundle-form`, `#admin-bundle-rows`, `.bundle-builder-row`, `.bundle-builder-product`, `.bundle-builder-size`, `.bundle-builder-qty`.
- Functions: `addBundle`, `deleteBundleRow`, `toggleBundleActive`, `loadAllBundlesForAdmin`, `renderAdminBundles`, `bundleBuilderRow`, `wireBundleBuilderRow`, `renderAdminBundlesTab`.
- Supabase calls: `bundles` INSERT/SELECT/UPDATE/DELETE.
- Current row contract visible in JS: `id`, `name`, `description`, `accent`, `icon`, `items`, `bundle_price`, `active`.

**Verification status: INSUFFICIENT EVIDENCE for a deployable module migration.** The actual `bundles` DDL/RLS is still missing, and the complete raw `script.js` is not available as a byte-preserving local file in this execution workspace. Producing a replacement `script.js` would risk silently dropping unrelated working behavior, which is prohibited by the audit contract.

Vanilla ES modules remain the recommended direction; no framework migration is justified.

## Step 4 — Security findings

### [SECURITY] Block profile role escalation

Evidence: supplied `profiles.role`; supplied `update own profile` policy; current JS admin selection from profile role.

Problem: Asset → admin privileges. Threat → self-promotion. Attack surface → direct PostgREST/Supabase UPDATE. Current protection → row ownership only. Missing protection → field-level privilege integrity. Consequence → attacker can satisfy every admin policy that trusts `is_admin()`. Mitigation → DB trigger makes role immutable to customers and forces client-created profiles to customer.

Status: **Verified**.

Fix delivered: `01-dagoldol-phase1-security-hotfix.sql`.

Validation: normal profile edits still work; direct `role='admin'` customer update fails; trusted SQL admin promotion still works.

Impact: **Critical**. Effort: **S**. Risk: **Low**.

### [SECURITY] Constrain broad customer order UPDATE

Evidence: supplied customer order UPDATE policy; current `cancelOrder()` writes `cancelled`; current `submitRating()` writes `rated`; admin writes `status_override`.

Problem: Asset → order ledger/payment/commercial fields. Threat → customer alters protected columns. Attack surface → direct `orders.update(...)`. Current protection → ownership only. Missing protection → column/state transition enforcement. Consequence → forged status/total/items/payment metadata on an owned row. Mitigation → trigger allows only current customer-side `cancelled`/`rated` behavior while treating every other present/future column as immutable.

Status: **Verified**.

Fix delivered: `01-dagoldol-phase1-security-hotfix.sql`.

Validation: direct total/items/status/payment update fails; legal pre-shipping cancellation works; uncancel fails; admin status update continues.

Impact: **Critical**. Effort: **S–M**. Risk: **Medium**.

### [SECURITY] Move checkout authority to one server transaction

Evidence: current JS computes subtotal, bulk fee, delivery fee, promo discount, total, half-payment amounts, writes order; stock decrement is separate; promo increment is separate.

Problem: Asset → revenue, inventory, promo limits. Threat → tampering/race/replay/partial failure. Attack surface → browser calls. Current protection → order ownership and stock RPC intent. Missing protection → authoritative server recomputation and one transaction. Consequence → forged commercial values and inventory/order divergence. Mitigation → one DB/Edge transaction from identifiers/quantities to order commit.

Status: **Verified problem; final code blocked**.

Full corrected file: **Verification status: INSUFFICIENT EVIDENCE**. Exact live product/bundle/promo/order columns and stock RPC bodies are required. `03-...source-gap-export.sql` collects them without changing data.

Impact: **Critical**. Effort: **L**. Risk: **High**.

### [SECURITY] Make cancellation and stock restoration atomic

Evidence: current `cancelOrder()` first updates `orders.cancelled`, then calls `restoreStockForLines()`.

Problem: Asset → inventory. Threat → partial failure/direct API bypass. Attack surface → two separate operations. Current protection → UI checks cancellation status. Missing protection → database transaction. Consequence → cancelled order without stock restoration or direct cancellation bypassing restore. Mitigation → final server `cancel_order(...)` function updates state and restores inventory once in the same transaction.

Status: **Verified problem; code blocked by stock RPC/product representation**.

Impact: **Critical**. Effort: **M–L**. Risk: **High**.

### [SECURITY] Bind ratings atomically to eligible purchases

Evidence: `submitRating()` updates `orders.rated`; `addRating()` separately inserts only `{product_id,value}`; supplied RLS accepts any authenticated rating insert.

Problem: Asset → product reputation. Threat → arbitrary or repeated rating insertion. Attack surface → direct ratings INSERT. Missing protection → purchase/order ownership binding. Consequence → rating manipulation. Mitigation → one server rating command that validates owner, delivered/not-cancelled status and product membership, then writes order/rating state atomically.

Status: **Verified problem; final persistence code blocked**.

Important: the older `dagoldol-phase1-ratings-fix.sql` is not deployable because it assumed `item->>'id'`, while current normal order JSON uses `productId`.

Impact: **High**. Effort: **M**. Risk: **Medium**.

### [SECURITY] Protect payment proofs

Evidence: current upload flow uses `payment-proofs` and gets a public URL; admin later renders `order.paymentProof`.

Problem: Asset → payment evidence. Threat → disclosure/cross-user overwrite. Attack surface → Storage URLs/policies. Missing protection → verified bucket privacy, namespace ownership and `storage.objects` policies. Consequence → sensitive screenshot exposure if bucket is public or policy is broad. Mitigation → private bucket, RLS, owner/admin access as required, signed URLs.

Status: **Needs verification**.

Full corrected file: **Verification status: INSUFFICIENT EVIDENCE**. Run the Storage sections of file 03 first.

Impact: **High**. Effort: **M**. Risk: **Medium**.

### [SECURITY] Tighten CSP only after removing actual inline style dependencies

Evidence: current CSP uses `style-src 'unsafe-inline'`; current HTML and JS contain inline style attributes/templates.

Status: **Verified**.

Fix: migrate inline style declarations to CSS classes, then remove `'unsafe-inline'`. Do not tighten `img-src`/Supabase hosts blindly until the actual project/storage origins are confirmed.

Impact: **Medium**. Effort: **M**. Risk: **Medium**.

## Step 5 — RLS matrix

| Object | Who | SELECT | INSERT | UPDATE | DELETE | Current verified condition/status |
|---|---|---:|---:|---:|---:|---|
| profiles | owner | Yes | Yes | Yes | No | `auth.uid() = id`; role flaw mitigated by file 01 trigger |
| profiles | admin | Yes | — | Yes | Yes | `is_admin()` |
| products | authenticated | Yes | No | No | No | old export only; guest mismatch exists |
| products | admin | Yes | Yes | Yes | Yes | `is_admin()` writes |
| orders | owner | Yes | Yes | Yes | No | owner row; file 01 constrains UPDATE columns/states but INSERT totals remain client-authoritative |
| orders | admin | Yes | — | Yes | Yes | `is_admin()` |
| messages | authenticated | — | Yes | — | — | old contact table |
| messages | admin | Yes | — | — | Yes | `is_admin()` |
| ratings | public/auth | Yes | authenticated | No | No | INSERT lacks purchase binding |
| settings/payment settings | unknown | ? | ? | ? | ? | schema required |
| bundles | unknown | ? | ? | ? | ? | schema required |
| promotions/flash sales | unknown | ? | ? | ? | ? | schema required |
| DM chat | participants intended but unverified | ? | ? | ? | ? | schema required |
| storage.objects | unknown | ? | ? | ? | ? | Storage policy export required |

## Priority backlog

| Priority | Finding | Impact | Effort | Risk | Dependency | Code area | Expected result | Code delivered |
|---:|---|---|---|---|---|---|---|---|
| P0 | Block self-role escalation | Critical | S | Low | none | profiles/is_admin | customer cannot promote self | Yes |
| P0 | Constrain customer order UPDATE | Critical | S–M | Medium | none beyond supplied orders | orders trigger | protected fields immutable | Yes |
| P0 | Server-authoritative checkout | Critical | L | High | live schema/RPC export | checkout/orders | tampered prices/fees rejected | No — blocked |
| P0 | Atomic stock/order/promo commit | Critical | L | High | live RPC/schema | checkout/inventory | no partial commercial state | No — blocked |
| P0 | Atomic cancellation/restock | Critical | M–L | High | stock RPC/schema | orders/inventory | cancellation/restock commit together | No — blocked |
| P1 | Purchase-bound ratings | High | M | Medium | final ratings contract + full frontend integration | ratings/orders | fake ratings rejected | No — blocked |
| P1 | Private payment proofs | High | M | Medium | Storage export | storage/orders | evidence not publicly exposed | No — blocked |
| P1 | Audit modern-table RLS | High | M | Medium | live schema/policies | bundles/promos/settings/DM | DB authorization verified | Export file delivered |
| P2 | Guest catalogue/RLS alignment | Medium | S–M | Medium | current product exposure decision | products | guest UI and DB agree | No — blocked |
| P2 | Admin Bundles ES-module migration | Medium | M | Medium | bundles DDL/RLS + raw full script | architecture | lower regression surface | No — blocked |
| P2 | CSP inline-style migration | Medium | M | Medium | exact inline-style migration | HTML/CSS/JS | remove unsafe-inline safely | No |

## Delivered files

1. `01-dagoldol-phase1-security-hotfix.sql` — source-grounded DB hardening for role integrity and customer order writes.
2. `02-dagoldol-phase1-security-hotfix-rollback.sql` — rollback for file 01; reopens the original risks and is emergency-only.
3. `03-dagoldol-phase1-source-gap-export.sql` — read-only production export for tables, constraints, RLS, functions, triggers, Realtime and Storage.
4. `04-dagoldol-phase1-rls-template-NOT-SAFE-TO-DEPLOY.sql` — consolidated verified/proposed/schema-required RLS status with no speculative policies.
5. `05-dagoldol-phase1-audit-report.md` — this report.
6. `README-FIRST.md` — execution order, safety boundaries and validation checklist.

## Final engineering boundary

The hotfix materially improves the supplied authorization boundary, but it does **not** make checkout production-safe. The next legitimate implementation step is determined by the results of file 03. Any SQL that invents the missing current product sizes/stock, bundle, promo, DM or Storage schema would be less safe than stopping at this boundary.
