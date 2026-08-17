# Owner Delivery Origin + Mobile Map Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated Dagoldol admin pin and save the shop/warehouse delivery origin, use that origin for checkout routing, and make the reusable delivery map reliably usable on phones without changing the existing delivery-pricing formula or desktop UI.

**Architecture:** Reuse the existing `settings` key/value table and the existing lazy `delivery-map.js` picker. Add delivery-origin settings (`delivery_origin_latitude`, `delivery_origin_longitude`, `delivery_origin_address`) to `currentSettings`, expose a dedicated Delivery Origin block in Admin → Payment Settings, and route checkout from the saved coordinates with the current hard-coded Davao origin as fallback. Harden the map loader for mobile by adding explicit WebGL capability/error handling, modal-visible resize retries, context-loss handling, bounded current-location accuracy, load timeouts, and a graceful manual-coordinate/address fallback rather than hanging indefinitely.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Supabase settings table, MapLibre GL JS, OpenFreeMap, Nominatim, OSRM, Vercel.

## Global Constraints

- Preserve the current Dagoldol 3.3.0 UI, auth, payment, catalogue, mobile-fast bootstrap, PixelTrail, LiquidChrome, profile address, checkout, and delivery-price rules.
- Do not add or change a ₱399 standard-delivery rule. Existing `DELIVERY_FREE_KM_THRESHOLD`, `DELIVERY_RATE_PER_KM`, and `DELIVERY_FALLBACK_FEE` remain unchanged.
- No database migration: store owner-origin values in the existing `settings` table.
- Only admins can edit settings through the existing RLS/admin workflow.
- If no valid saved owner origin exists, keep the existing hard-coded Davao origin and geocoded fallback coordinates.
- Map failure, WebGL failure, geolocation denial, reverse-geocoding failure, or route-provider failure must never block manual checkout.
- Map code must remain lazy-loaded and must release MapLibre resources after modal close.
- Phone changes must not redesign or regress the existing desktop UI.

---

### Task 1: Owner-origin settings contract

**Files:**
- Modify: `script.js`
- Modify: `scripts/generate-public-catalogue.mjs`
- Test: `tests/delivery-origin-contract.test.mjs`

**Interfaces:**
- Consumes: existing `settingsFromRows()`, `currentSettings`, `saveSetting()`, `getShopOriginCoords()`.
- Produces: validated owner-origin settings and routing origin selection.

- [ ] Write failing tests asserting origin settings are parsed, persisted, included in the public snapshot allowlist, and delivery pricing constants are unchanged.
- [ ] Run the contract test and confirm it fails because origin settings do not exist.
- [ ] Add delivery-origin settings with strict Philippine coordinate validation and hard-coded fallback.
- [ ] Update `getShopOriginCoords()` to prefer a valid saved origin, then existing geocode/fallback behavior.
- [ ] Reset the in-memory origin cache whenever settings refresh or origin is saved.
- [ ] Run the contract test and full existing test suite.

### Task 2: Admin delivery-origin UI

**Files:**
- Modify: `script.js`
- Modify: `phase3-fixes.css`
- Test: `tests/delivery-origin-contract.test.mjs`

**Interfaces:**
- Consumes: reusable delivery-map modal and map target state.
- Produces: admin origin card, map button, saved address/coordinates, and save feedback.

- [ ] Extend failing tests to require admin origin controls and existing map reuse.
- [ ] Add a Delivery Origin section to Admin → Payment Settings without changing the tab architecture.
- [ ] Add admin map state and allow the shared map modal to open with target `admin-origin`.
- [ ] On confirm, update the admin origin draft only; persist it through the existing Save Payment Settings action.
- [ ] Save latitude, longitude, and readable address to the settings table alongside payment settings.
- [ ] Add compact responsive styling matching existing admin cards.
- [ ] Run targeted and full tests.

### Task 3: Mobile map reliability

**Files:**
- Modify: `delivery-map.js`
- Modify: `phase3-fixes.css`
- Modify: `index.html`
- Test: `tests/mobile-map-reliability.test.mjs`

**Interfaces:**
- Consumes: existing lazy map loader and reusable modal.
- Produces: bounded load lifecycle, WebGL capability checks, mobile-friendly rendering, graceful errors.

- [ ] Write failing tests for WebGL support detection, load timeout, context-loss recovery messaging, post-modal resize retries, mobile-safe map options, and non-blocking fallback.
- [ ] Add explicit WebGL support check before creating MapLibre.
- [ ] Add JS/CSS load timeouts and reset failed loader state so retry works.
- [ ] Configure MapLibre with mobile-safe context/render options and conservative tile cancellation.
- [ ] Add `webglcontextlost` handling that reports a recoverable error instead of hanging.
- [ ] Resize map after modal visibility using animation-frame and delayed retries.
- [ ] Use reduced geolocation timeout/accuracy strategy on constrained devices with a one-shot fallback.
- [ ] Keep manual pin/address checkout available when interactive map cannot initialize.
- [ ] Tighten phone modal/map dimensions and touch scrolling/safe-area behavior.
- [ ] Run targeted and full tests.

### Task 4: Release verification and packaging

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify-source.mjs`
- Create: `OWNER-ORIGIN-MOBILE-MAP-README.txt`
- Create: `OWNER-ORIGIN-MOBILE-MAP-VERIFICATION.txt`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: release contract and deployment instructions.

- [ ] Add new tests to `npm run verify`.
- [ ] Verify delivery-price constants are byte-for-byte unchanged from the 3.3.0 baseline.
- [ ] Run syntax checks, all contract tests, CSS parser checks, and static responsive/browser fixtures.
- [ ] Attempt `npm run build`; report network limitations rather than fabricating success.
- [ ] Generate SHA-256 manifests and ZIP integrity checks for full and paste-only packages.
