# Dagoldol Phase 3 Complete Source

This folder is the Phase 3 integration baseline built from the supplied Dagoldol storefront files. It keeps the existing vanilla HTML/CSS/JavaScript + Supabase architecture and applies the source-level SEO, UX/IA, code-quality, data-flow, and deployment changes that can be implemented without inventing an unverified production database schema.

## What is included

- Public-first storefront HTML and updated metadata.
- Public information pages: Products, About, FAQ, Shipping & Delivery, Returns, Contact, Terms, Privacy.
- Build-time product-page generator and generated sitemap support.
- Routed authenticated checkout at `/checkout`.
- Routed authenticated order history at `/account/orders`.
- `/admin` route support and Vercel no-index headers for private application routes.
- Phase 2 accessibility/performance integration retained.
- Phase 3 tablet header/filter hierarchy.
- Persistent, seller-controlled order status instead of time-simulated fulfillment stages.
- Privacy-preserving aggregate recommendation RPC integration.
- Private payment-proof path/signed-URL integration.
- Purchase-bound rating integration.
- Historical-price analytics correction.
- Lazy admin-tab loading with independent account order counts.
- Catalogue event delegation and recommendation refresh locking.
- Direct-message duplicate-render guard.
- Protected `delete-auth-user` Supabase Edge Function source.
- Read-only database preflight and Phase 3 security/storage migration.
- Source-verification command.

## Required deployment order

### 1. Back up the current deployment and database

Do not overwrite the only working copy. Keep the currently working Vercel deployment or a local ZIP before replacing files.

### 2. Inspect the live database

Run:

`database/00-phase3-live-preflight.sql`

This is read-only. It reports the table columns, current RLS policies, functions, Storage buckets, and Storage policies used by Dagoldol.

### 3. Apply the Phase 3 database migration

Run:

`database/phase3-security-and-storage.sql`

The migration is wrapped in a transaction and starts with source-contract checks. If the required tables/columns do not match the supplied application contract, it raises an exception before the Phase 3 changes are applied.

This migration provides:

- purchase-bound ratings columns/policy;
- public aggregate recommendation signals without exposing raw order rows;
- private `payment-proofs` Storage configuration;
- owner/admin payment-proof access;
- owner avatar writes;
- admin storefront-media writes;
- migration of legacy Supabase public payment-proof URLs to object paths when they match the old Dagoldol upload pattern.

### 4. Deploy the account-deletion Edge Function

Function source:

`supabase/functions/delete-auth-user/index.ts`

With the Supabase CLI, deploy it from the project root with:

`supabase functions deploy delete-auth-user`

The frontend invokes this function from the Accounts admin tab. There is deliberately no browser-side/profile-only deletion fallback: if the protected function is unavailable, refuses the operation, or detects retained order/rating/chat history, nothing is deleted. This prevents orphaned Auth accounts and avoids destructive foreign-key cascades in an unverified live schema.

### 5. Verify the source locally

Run:

`npm run verify`

This performs JavaScript syntax checks plus a source-contract check for the required Phase 3 files, routes, and key DOM IDs.

### 6. Deploy to Vercel

`vercel.json` runs:

`npm run build`

The build reads the same public Supabase catalogue used by the guest storefront and generates:

- `/products/index.html`;
- one static product page per current public product;
- `product-routes.json`;
- the final `sitemap.xml`.

If the catalogue cannot be fetched during the deployment build, the generator exits with an error instead of silently generating an empty product catalogue.

## Important database boundary

The supplied source proves the current order/item JSON shape and the existing `decrement_stock_for_order` / `restore_stock_for_order` RPC calls, but it does **not** include the live definitions of those RPCs or the full production `orders`, `promo_codes`, and inventory RLS contract.

For that reason, this package does not invent a replacement all-in-one transactional checkout RPC. The working checkout flow is preserved and receives safer compensation/error handling, but price/promo/order creation is still performed by the existing frontend + Supabase flow. A truly server-authoritative atomic checkout must be implemented only after the live preflight output confirms the exact database contract.

Do not expose a Supabase `service_role` key in `config.js` or any browser file.

## Post-deployment regression test

Test in this order:

1. Guest homepage loads and catalogue renders.
2. Search, brand filter, price filter, sort, Clear, Load more.
3. Product → size → guest cart.
4. Guest checkout → login → `/checkout` returns with selected items.
5. Full checkout with saved address, delivery calculation, promo, GCash/bank, half payment, payment reference, optional proof.
6. Refresh `/checkout` and confirm item draft recovery.
7. `/account/orders` direct visit while logged in.
8. Admin `/admin` direct visit; Orders loads first; every other tab loads on first selection.
9. Order status changes only when admin changes it; the customer sees the configured 3–6 day delivery estimate rather than a randomly generated delivery date.
10. Delivered-order rating succeeds once and is rejected when the purchase/order relationship is invalid.
11. Payment-proof thumbnail is visible only to the owner/admin through signed access.
12. Two customer accounts cannot read each other's orders/messages/proofs.
13. Keyboard-only size selection, modals, admin tabs, image preview, and chat reactions.
14. Reduced-motion background behavior.
15. 721, 768, 820, 912, 960, and 1024 px header/filter layouts.
16. `/products/`, a generated product URL, `/about/`, `/faq/`, `/shipping-delivery/`, `/returns/`, `/terms/`, `/privacy/`, `/contact/`.
17. `robots.txt` and `sitemap.xml` return successfully.

## Files that are reference-only

- `legacy-react-reference/` contains the React LiquidChrome source that was supplied with the project. The live storefront continues to use the vanilla `liquid-chrome.js`; the React files are not loaded by `index.html`.
- `docs/reference/` preserves the supplied audit notes and the earlier Phase 1 ratings SQL for traceability. The archived Phase 1 ratings SQL is explicitly named `DO-NOT-RUN`; use `database/phase3-security-and-storage.sql` for the Phase 3 integration.
