# Dagoldol Phase 1 Security Package — Read This First

This package is the continuation of the Phase 1 Coverage / Architecture / Security / RLS audit.

## What you can run now

`01-dagoldol-phase1-security-hotfix.sql` is the only mutating SQL in this package intended as an immediate source-grounded hotfix. It uses only `public.profiles`, `public.orders`, and `public.is_admin()`, all present in the supplied schema. It has been logically reviewed but **not executed against your live Supabase database**.

It closes two immediate database-boundary problems without requiring the missing modern schema:

1. A customer cannot change their own `profiles.role` to `admin` through the client API.
2. A customer can no longer mutate arbitrary fields on an existing owned order. The current customer UI behavior is preserved only for legal cancellation and per-order rating state.

It also normalizes security-owned fields on customer order INSERT (`user_id`, `username`, `placed_at`, `status_override`, `cancelled`, `rated`).

## What you should run next (read-only)

Run `03-dagoldol-phase1-source-gap-export.sql` in the current production Supabase SQL Editor and save all result grids. This script is SELECT-only. It collects the exact evidence still missing from the old schema export:

- current modern table columns and constraints;
- every current public RLS policy;
- API grants;
- `decrement_stock_for_order` and `restore_stock_for_order` definitions;
- trigger inventory;
- Realtime publication membership;
- Storage bucket public/private flags, file-size/MIME restrictions;
- Storage RLS policies;
- structural `orders.items` JSON keys without exposing customer values.

Those results are required before the remaining Critical checkout/inventory/promotion work can be written safely.

## Do not deploy

Do **not** deploy `04-dagoldol-phase1-rls-template-NOT-SAFE-TO-DEPLOY.sql`. It is a documentation/status artifact and intentionally contains no speculative policy implementation.

Do **not** deploy the earlier `dagoldol-phase1-ratings-fix.sql` that assumed `orders.items[*].id`. Current `script.js` uses `productId` for normal order lines and nested `components[].productId` for bundles, and the current frontend does not send the new `user_id` / `order_id` fields introduced by that older proposal.

## Recommended execution order

1. Make a database backup / snapshot.
2. Run `03-dagoldol-phase1-source-gap-export.sql` first if possible and save the results.
3. Review `01-dagoldol-phase1-security-hotfix.sql` in Supabase SQL Editor.
4. Run file 01 in a staging project or branch first when available.
5. Execute the manual validation cases at the bottom of file 01.
6. Deploy to production only after those checks pass.
7. Keep file 02 available only as an emergency rollback.
8. Use the file 03 output to build the final server-authoritative checkout, stock/promo transaction, rating RPC, DM policies and Storage policies.

## Behavior intentionally preserved by file 01

- Customer profile fields other than role remain writable under your existing policy.
- Current signup can still create customer profiles.
- Trusted SQL can still promote the first/real admin because SQL Editor operations do not rely on an end-user `auth.uid()`.
- Admin order management remains exempt from the customer write guard.
- Customer cancellation remains allowed only while the current UI considers the order earlier than Shipped.
- Customer `orders.rated` state remains append-only after delivery for normal product lines.

## Known remaining Critical risk

The browser still constructs and inserts authoritative order pricing/fee/payment values. File 01 prevents later customer tampering with those values but cannot prove they were truthful at INSERT time. Fixing that requires the actual current production schema and stock/promotion functions so the full checkout can become one server-side transaction.

## Verification performed in this session

- Cross-checked current `index.html`, latest `script.js`, latest `style.css`, and the supplied Supabase schema/RLS export from the File Library.
- Cross-checked current order JSON keys and cancellation/status logic in `script.js`.
- Cross-checked Supabase's current official RLS and Storage guidance.
- Performed local file-integrity/static text checks on this package.
- No live Supabase database was connected, so no database migration or runtime test result is claimed.
