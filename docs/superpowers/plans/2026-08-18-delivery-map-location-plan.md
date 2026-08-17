# Dagoldol Delivery Map Location Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-synced delivery map pinning to Profile and Checkout so a customer can select a real map location, auto-fill the address, save coordinates, and calculate delivery distance from the pin without slowing normal mobile startup.

**Architecture:** Keep the existing Supabase `profiles.address jsonb` contract and extend it additively with `location: { latitude, longitude, source, pinned_at }`. Add one reusable lazy-loaded map modal driven by a new `delivery-map.js` module. Checkout and Profile keep their current text fields and use the same location controller; checkout prefers valid pinned coordinates for routing but falls back to the existing address-geocoding path when no current pin exists.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Supabase, MapLibre GL JS 5.12.0 loaded lazily from jsDelivr, OpenFreeMap public vector tiles, OpenStreetMap Nominatim for end-user-triggered reverse geocoding with local caching/rate limiting, existing OSRM road routing.

## Global Constraints

- Preserve the existing Dagoldol desktop/mobile visual identity and all existing features.
- Do not add a new database table; preserve backward compatibility with existing `address jsonb` records.
- Do not load the map library during catalogue/login startup; initialize only after a user opens the map.
- Do not trust client coordinates for authorization; coordinates are delivery metadata only.
- Restrict accepted pins to Philippine geographic bounds.
- Continue allowing checkout when map/geolocation services are unavailable.
- Respect Nominatim public usage policy: end-user-triggered requests only, local cache, no autocomplete, serialized requests with >= 1 second spacing, app identification and attribution.
- Keep multi-device Supabase session fixes, payment settings, PixelTrail, mobile stability, and static LiquidChrome behavior unchanged.

---

### Task 1: Location Data Contract and Pure Helpers

**Files:**
- Create: `delivery-map.js`
- Test: `tests/delivery-map-contract.test.mjs`

**Interfaces:**
- Produces `normalizeSavedLocation(value)`, `isPhilippinesCoordinate(lat, lon)`, `buildAddressFromNominatim(payload)`, `locationMatchesAddress(location, addressFields)`, `reverseGeocodePin(lat, lon)`, and `openDeliveryMap(options)`.

- [ ] Write failing Node tests for coordinate validation, legacy/new address normalization, Nominatim address parsing, and address-pin consistency.
- [ ] Run the tests and confirm RED.
- [ ] Implement pure helpers and cache/rate-limit primitives without browser map initialization.
- [ ] Run the tests and confirm GREEN.

### Task 2: Reusable Lazy Map Modal

**Files:**
- Modify: `index.html`
- Modify: `phase3-fixes.css`
- Modify: `vercel.json`
- Modify: `config.js`
- Test: `tests/delivery-map-contract.test.mjs`

**Interfaces:**
- Consumes `openDeliveryMap(options)`.
- Produces reusable modal DOM IDs `delivery-map-modal`, `delivery-map-canvas`, `delivery-map-current-location`, `delivery-map-confirm`, and status/summary elements.

- [ ] Extend tests to require lazy MapLibre loader, map modal DOM, Philippines bounds, geolocation permission, CSP worker/connect/style allowances, and OpenFreeMap attribution.
- [ ] Confirm RED.
- [ ] Add the modal, styling, CSP/Permissions-Policy changes, and bump version to 3.3.0.
- [ ] Implement lazy MapLibre loading and destroy/release map resources on close.
- [ ] Confirm GREEN.

### Task 3: Checkout Integration

**Files:**
- Modify: `index.html`
- Modify: `script.js`
- Test: `tests/delivery-location-runtime.spec.py`

**Interfaces:**
- Adds checkout pin controls and `checkoutPinnedLocation` state.
- Extends `calculateDeliveryFee` with direct-coordinate routing path.
- Persists order/address `location` object.

- [ ] Write runtime/contract tests showing saved coordinates restore into checkout, pin confirmation auto-fills address, manual address edits invalidate stale pin, delivery fee uses pin coordinates, and legacy addresses still work.
- [ ] Confirm RED.
- [ ] Implement the minimal checkout integration.
- [ ] Confirm GREEN.

### Task 4: Profile Address Integration

**Files:**
- Modify: `index.html`
- Modify: `script.js`
- Test: `tests/delivery-location-runtime.spec.py`

**Interfaces:**
- Adds profile delivery-address fields and `profilePinnedLocation` state.
- Saves `profiles.address` independently of `profiles.profile` in the same profile submit operation.

- [ ] Extend tests for loading/saving profile address coordinates and syncing the same address into checkout.
- [ ] Confirm RED.
- [ ] Implement profile fields, map buttons, pin summary, and Supabase update.
- [ ] Confirm GREEN.

### Task 5: Cross-Device/Mobile/Regression Verification

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify-source.mjs`
- Create: `DELIVERY-MAP-README.txt`
- Create: `DELIVERY-MAP-VERIFICATION.txt`

- [ ] Add map contract tests to `npm run verify` and source verifier.
- [ ] Run JS syntax checks and full verify suite.
- [ ] Parse all CSS.
- [ ] Run controlled Chromium mobile matrix at 320/360/390/414/430 and desktop 1440.
- [ ] Verify map is absent from startup network/DOM runtime until user opens it, map modal does not create page overflow, touch controls remain usable, and desktop catalogue baseline does not regress.
- [ ] Package paste-only and full ZIPs, generate SHA-256 manifests, and test archive integrity.
