# Phase 4.2 Live Authorization Findings

**Captured:** 2026-08-20  
**Supabase project:** `rvrjkfbenramappteuae`  
**Mode:** read-only inspection; no production mutation

## Verified project contract

The connected project is active and uses PostgreSQL 17.6.1. The application schemas inspected contain the following public tables:

`activity`, `brands`, `bundles`, `chat_messages`, `chat_threads`, `dm_messages`, `dm_threads`, `flash_sales`, `gift_card_transactions`, `gift_cards`, `messages`, `orders`, `products`, `profiles`, `promo_codes`, `ratings`, `settings`, `subscription_orders`, `subscriptions`.

All inspected public application tables have RLS enabled.

Storage contains exactly five buckets:

- `avatars` — public;
- `brand-logos` — public;
- `payment-proofs` — private;
- `payment-settings` — public;
- `product-images` — public.

The live `delete-auth-user` Edge Function is active with JWT verification enabled and verifies the caller's database-backed administrator role before using service-role capabilities.

## Critical / P0 findings

### Browser-executable privileged inventory helpers

`public.decrement_stock_for_order(jsonb)` and `public.restore_stock_for_order(jsonb)` are `SECURITY DEFINER` functions. Before Phase 4.2 migration they are executable by both `anon` and `authenticated`. Their live bodies update inventory inside `public.products.sizes` and do not contain an authorization check that limits the caller to an approved order transaction.

The Supabase security advisor independently flags these functions as externally executable privileged functions.

### Permissive storefront-management policies

Live RLS includes unrestricted `public full access` alternatives on `brands`, `bundles`, `flash_sales`, and `promo_codes`. Because policies are permissive by default, these broad alternatives defeat stricter admin-only policies on the same operation.

Underlying `anon`/`authenticated` table privileges are also broad enough for these RLS alternatives to be reachable.

### Storefront settings write bypass

The live `settings` table contains broad authenticated INSERT/UPDATE policies alongside admin-only policies. The broad alternatives permit ordinary authenticated sessions to write settings.

### Payment-proof privacy bypass

`payment-proofs` is correctly configured as a private bucket, but a legacy `storage.objects` SELECT policy includes `payment-proofs` in a broad readable-bucket list. That alternative defeats the newer owner/admin-specific proof policy.

Legacy upload policies also permit authenticated proof/avatar uploads without consistently binding the first path segment to `auth.uid()`.

### Ratings purchase-binding bypass

The live database contains the intended purchase-bound ratings policy, but it coexists with `ratings_insert_authenticated`, which accepts any authenticated user. The broad policy provides an alternative INSERT route and defeats the purchase/delivery restriction.

### Profile-private cross-account IDOR

`profiles: authenticated can look up basic info` uses an all-row `USING (true)` predicate. RLS applies to rows, not a selected subset of columns, so an authenticated customer can issue a direct Data API query for another profile's private columns when table privileges permit it.

The frontend legitimately needs cross-user `id`/`username` lookup for chat, so the correct replacement is a narrow directory RPC rather than a broad profile-row SELECT policy.

## High findings

### DM participant UPDATE is too broad

Live participant UPDATE policies on `dm_threads` and `dm_messages` do not themselves constrain which columns may change. This permits field/state tampering unless database triggers narrow the mutation.

### Gift-card monetary functions are not a safe browser boundary

The inspected gift-card functions accept monetary/identity values that are privileged business inputs. Browser execution is unnecessary without a trusted checkout integration and is removed in the Phase 4.2A target contract.

### Subscription processing is inconsistent with live inventory schema

The live `products` table stores inventory in `sizes` JSON and has no top-level `stock` column. Inspected subscription stock functions reference `products.stock`. Subscription processors therefore cannot be certified against the deployed inventory model and should remain server-disabled until reconciled.

## Verified existing defenses retained

`profiles_guard_role_client` is live and calls `guard_profile_role_client()`, preventing browser customers from choosing or changing their privilege level.

`orders_guard_customer_write` is live and calls `guard_customer_order_write()`, binding user/workflow values on INSERT and protecting trusted order fields from later customer UPDATEs except the narrowly supported cancellation/rating state.

These controls remain defense in depth in the Phase 4.2A candidate.

## Live checkout/schema inconsistency discovered during implementation

The live `public.orders` table currently has 19 columns:

`id`, `user_id`, `username`, `items`, `subtotal`, `delivery_fee`, `bulk_fee_rate`, `bulk_fee`, `cod_fee`, `total`, `payment_method`, `address`, `placed_at`, `delivery_days`, `status_override`, `cancelled`, `rated`, `promo_code`, `promo_discount`.

It does not contain `payment_reference`, `payment_proof`, `half_payment`, `amount_due_now`, or `amount_due_later`.

The live `place_order(...)` function body references those absent columns in its INSERT statement. The retrievable pre-3.3.5 frontend also references those payment fields. This must be reconciled with the exact current 3.3.5 product/payment requirements before the trusted checkout cutover is implemented.

## Security-advisor findings retained for follow-up

The current advisor also reports multiple mutable-function `search_path` warnings and exposed `SECURITY DEFINER` functions. Phase 4.2 prioritizes exploitable authorization/commerce boundaries first; all remaining advisor items must be rerun and resolved or explicitly justified on staging before the phase closes.
