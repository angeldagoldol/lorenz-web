# Dagoldol 3.3.5 Smart Delivery Address + Admin Customer Pin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make customer map pins reliably resolve into Philippine street/city/postal/landmark data before confirmation, and let administrators privately view each customer's saved delivery pin from Admin → Accounts.

**Architecture:** Keep the existing Leaflet + Nominatim delivery-map module and `profiles.address` / `orders.address` JSON storage. Strengthen reverse-address parsing and map readiness, then reuse the existing delivery-map modal in a read-only admin mode. No schema migration and no pricing/auth/payment redesign.

**Tech Stack:** Vanilla JavaScript, HTML/CSS, Supabase, Leaflet 1.9.4, Nominatim, Node test runner, Playwright/Chromium runtime checks.

## Global Constraints

- Use Dagoldol 3.3.4 uploaded ZIP as the source of truth.
- Preserve existing desktop/mobile UI except additive delivery-location/admin details.
- Preserve delivery pricing exactly: 5 km free threshold, ₱60/km, ₱600 fallback.
- Preserve multi-device auth, payments, products, LiquidChrome, PixelTrail, and Supabase schema.
- Customer location data remains private and only visible through authenticated admin data access.
- A map/geocoder failure must not block manual address entry or checkout.

---

### Task 1: Reverse-address reliability and confirm gating

**Files:**
- Modify: `delivery-map.js`
- Modify: `script.js`
- Test: `tests/smart-address-admin-pin.test.mjs`
- Test: `tests/smart-delivery-runtime.spec.py`

**Interfaces:**
- `buildAddressFromNominatim(payload)` returns `{ address, city, postal, landmarkSuggestion, displayName }`.
- `openDeliveryMap(...)` reports reverse-lookup state via `onLookupStateChange`.
- Raw GPS movement moves the marker but does not publish a confirmable selection before reverse lookup completes.

- [x] Write failing sparse-Philippine-address tests.
- [x] Run tests and confirm baseline failures.
- [x] Add display-name fallbacks for street/city/landmark.
- [x] Gate confirmation while reverse lookup is active.
- [x] Add a forced final reverse-geocode retry when street/city remain missing.
- [x] Preserve manual landmark values.
- [x] Verify delayed reverse lookup in Chromium.

### Task 2: Persist useful pin metadata without schema changes

**Files:**
- Modify: `delivery-map.js`
- Modify: `script.js`

**Interfaces:**
- Existing `address.location` JSON remains backward compatible.
- Optional `accuracy` is persisted for device-derived locations.
- Missing address fields can be manually completed without immediately invalidating a still-valid exact pin.

- [x] Preserve optional geolocation accuracy.
- [x] Reconcile first-time completion of fields that were empty when geocoding could not resolve them.
- [x] Keep later conflicting manual edits subject to stale-pin protection.

### Task 3: Admin customer pin visibility

**Files:**
- Modify: `script.js`
- Modify: `delivery-map.js`
- Modify: `phase3-fixes.css`
- Test: `tests/smart-address-admin-pin.test.mjs`
- Test: `tests/smart-delivery-runtime.spec.py`

**Interfaces:**
- Admin account cards prefer the customer's saved profile pin and fall back to the most recent order pin.
- `openAdminCustomerDeliveryLocation(accountId)` opens the shared map in read-only mode.
- Read-only mode disables map pin dragging/click replacement and hides current-location/confirm controls.

- [x] Fetch order address metadata alongside existing account order counts.
- [x] Render address, landmark, coordinates, source, and no-pin state in each account card.
- [x] Add `View delivery pin` only when a pin exists.
- [x] Reuse the delivery map as an admin-private read-only viewer.
- [x] Verify profile-pin and latest-order fallback behavior in Chromium.

### Task 4: Release/version and regression gates

**Files:**
- Modify: `index.html`
- Modify: `config.js`
- Modify: `package.json`
- Modify: `scripts/verify-source.mjs`
- Modify: `tests/mobile-fast-bootstrap.test.mjs`

- [x] Bump runtime assets/package to 3.3.5.
- [x] Add `test:smart-delivery` to `npm run verify`.
- [x] Preserve existing static-background baseline instead of weakening/changing UI assets.
- [x] Run full Node verification.
- [x] Run delivery-location, admin-pin, desktop, mobile, auth, payment runtime regressions.
- [x] Attempt production catalogue build and report network limitation honestly if external Supabase is unreachable.
