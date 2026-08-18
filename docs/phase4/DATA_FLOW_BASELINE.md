# Dagoldol Phase 4.1 — Architecture and Data-Flow Baseline

## System topology

```text
Public browser / customer / admin
        |
        | index.html + CSS + script.js
        v
Browser state / localStorage / sessionStorage
        |
        +--> Supabase Auth
        +--> PostgREST tables
        +--> PostgreSQL RPCs
        +--> Supabase Storage
        +--> Supabase Realtime
        +--> Supabase Edge Function: delete-auth-user
        |
        +--> Nominatim reverse/search geocoding
        +--> OSRM road routing
        +--> Leaflet + OpenStreetMap tiles

Vercel build
        |
        +--> scripts/generate-public-catalogue.mjs
        +--> live Supabase REST
        +--> static product pages + sitemap + catalogue snapshot
```

## Feature/data-flow matrix

| Feature | UI / DOM | Browser logic | Supabase/data boundary | Main concern |
|---|---|---|---|---|
| Auth | login/signup/reset/profile | `script.js`, `auth-resilience.js` | Supabase Auth + `profiles` | live role immutability/RLS must be verified |
| Catalogue | shop/catalogue/product routes | catalogue rendering/filtering | `products`, `brands`, `ratings`, `flash_sales`, snapshot | guest DB exposure must match public-first UI |
| Cart | cart modal/profile cart | guest localStorage + profile cart | `profiles.cart` | broad profile UPDATE must not permit role mutation |
| Checkout | `/checkout`, order form | prices/fees/promo/total/order row assembled client-side | `orders`, products, promos, stock RPC | P0 browser commercial authority |
| Inventory | variant stock | verify live stock; decrement/restore RPC | `products`, stock RPCs | decrement/order/promo not one transaction |
| Promo | code input | validates cached rows and computes discount | `promo_codes` | SELECT→UPDATE usage race |
| Orders | `/account/orders` | cancellation/status/rating UI | `orders`, stock RPC, `ratings` | cancellation/restock and rating state not atomic |
| Payment proof | checkout upload/admin preview | private path + signed URL | `payment-proofs` Storage | live Storage policy/limits must be verified |
| Messaging | Messages modal/admin messages | DM threads/messages/reactions/presence | `dm_threads`, `dm_messages`, Realtime | participant RLS is unverified |
| Customer location | profile + checkout pin | profile saved location + order snapshot | `profiles.address`, `orders.address` | location privacy depends on RLS |
| Delivery map | Leaflet modal/admin pin | GPS, reverse geocode, routing | external OSM/Nominatim/OSRM | external-provider reliability/privacy |
| Admin Accounts | admin tab | loads customer profiles/latest order addresses | `profiles`, `orders` | admin-only exposure must be DB-enforced |
| Admin Orders | admin tab | direct status update/delete | `orders` | no server state-machine transition guard observed |
| Admin Products | admin tab | CRUD + images | `products`, Storage | live admin RLS required |
| Admin Promos/Bundles | admin tabs | CRUD | `promo_codes`, `bundles` | modern-table RLS unverified |
| Analytics | admin tab | raw order aggregation in browser | `orders` | potentially large/raw sensitive dataset |
| Account deletion | admin Accounts | invokes Edge Function | Auth admin API, profiles/orders/ratings/DM/Storage | partially destructive sequence can fail mid-way |
| Public SEO build | static product pages | build generator | live Supabase REST | build availability coupled to live DB |

## Browser authority map

### Appropriate browser-owned state

- UI state;
- modal visibility;
- search/sort/filter state;
- temporary checkout form values;
- customer-selected pin before submit;
- guest cart before authentication.

### State that must become server-authoritative

- product price at purchase time;
- bundle price at purchase time;
- promo eligibility/usage;
- inventory reservation/decrement;
- delivery fee used for charged total;
- bulk-fee calculation;
- final total;
- legal order status transitions;
- cancellation + inventory restoration;
- payment verification state;
- idempotent order creation.

## Canonical location ownership

```text
profiles.address.location
  = current mutable customer-saved location

orders.address.location
  = immutable historical delivery snapshot for that order
```

The architecture should preserve this separation throughout Phase 4.

## Current concentration/coupling indicators

- `script.js`: 7,260 lines.
- 327 named functions.
- 67 `innerHTML` mutation sites.
- 13 directly referenced PostgREST tables.
- 3 RPCs.
- multiple Storage buckets, Realtime channels and an Edge Function.

This establishes the rationale for the incremental Phase 4.5 module decomposition after the P0 backend boundaries are stabilized.
