DAGOLDOL 3.3.1 — OWNER DELIVERY ORIGIN + PHONE MAP RELIABILITY
================================================================

PURPOSE
-------
This release adds an admin/owner-editable delivery starting point while preserving
Dagoldol's existing delivery-pricing formula. It also hardens the reusable delivery
map for iPhone/Android and constrained laptops/PCs.

IMPORTANT — DELIVERY PRICE WAS NOT CHANGED
------------------------------------------
The requested ₱399 standard-delivery change was CANCELLED and is NOT included.
The following production constants are unchanged from Dagoldol 3.3.0:

  DELIVERY_FREE_KM_THRESHOLD = 5
  DELIVERY_RATE_PER_KM      = 60
  DELIVERY_FALLBACK_FEE     = 600

No minimum/base ₱399 fee was added anywhere.

OWNER / ADMIN DELIVERY ORIGIN
-----------------------------
The existing Admin → Payment Settings screen now also contains a Delivery Origin
section.

Admin can:
  1. Click "Set starting point".
  2. Pin or drag the marker on the same reusable map.
  3. Use the current device location if browser permission is granted.
  4. Confirm the location.
  5. Click "Save payment & delivery settings".

The application stores these keys in the EXISTING settings table:

  delivery_origin_address
  delivery_origin_latitude
  delivery_origin_longitude

No database migration or new table is required.

Checkout routing now starts from the saved owner coordinates. If the saved values
are missing or invalid, Dagoldol automatically retains the previous hard-coded
Davao shop origin and fallback coordinates, so existing deployments remain safe.

PHONE MAP RELIABILITY
---------------------
The map remains lazy-loaded and is not downloaded during normal catalogue/login
startup. Reliability improvements include:

  - WebGL capability probe before MapLibre initialization.
  - Bounded MapLibre script/style loading instead of indefinite "Loading map...".
  - Failed CDN script loads are removed so a later retry can succeed.
  - Bounded map-render timeout.
  - Lower rendering budget on phone-class touch devices (DPR/tile-cache cap).
  - Rotation/pitch disabled for a simpler, lighter delivery picker.
  - Multiple resize passes after the modal becomes visible, including
    VisualViewport/orientation handling for iPhone Safari.
  - WebGL context-loss/restoration handling.
  - Fast cached/low-accuracy location attempt followed by a bounded high-accuracy
    retry instead of one long GPS request.
  - Map resources/listeners are destroyed when the picker closes.
  - Manual address entry and checkout remain available if map/GPS/WebGL/geocoding
    cannot initialize.
  - Mobile modal uses dynamic viewport/safe-area containment and touch-safe scroll.

FILES TO REPLACE ON AN EXISTING DAGOLDOL 3.3.0 INSTALLATION
-----------------------------------------------------------
  index.html
  config.js
  script.js
  delivery-map.js
  phase3-fixes.css
  package.json
  scripts/generate-public-catalogue.mjs
  scripts/verify-source.mjs
  tests/delivery-map-contract.test.mjs
  tests/delivery-location-runtime.spec.py
  tests/mobile-fast-bootstrap.test.mjs

FILES TO ADD
------------
  tests/delivery-origin-contract.test.mjs
  tests/mobile-map-reliability.test.mjs
  docs/superpowers/plans/2026-08-18-owner-origin-mobile-map-fix.md
  OWNER-ORIGIN-MOBILE-MAP-README.txt
  OWNER-ORIGIN-MOBILE-MAP-VERIFICATION.txt

NOT CHANGED FOR THIS FEATURE
----------------------------
  style.css
  style1.css
  script1.js
  pill-buttons.css
  liquid-chrome.js
  pixel-trail.js
  pixel-trail.css
  auth-resilience.js
  phase2-core.js
  phase2-accessibility.js
  phase2-fixes.css
  database/*
  supabase/functions/*
  vercel.json

NO SCHEMA MIGRATION
-------------------
The feature reuses the settings key/value table already used for payment settings.
Your existing RLS/admin workflow remains the authorization boundary for writes.

DEPLOYMENT
----------
1. Back up your current repository/branch.
2. Copy the full project, or replace/add the files listed above.
3. From the project root run:

     npm run verify
     npm run build

4. Commit and push to GitHub/Vercel.
5. On iPhone/Android, fully close old Dagoldol tabs and reopen the deployed site
   so the 3.3.1 cache-busted assets are loaded.
6. Sign in as admin → Payment Settings → Delivery Origin.
7. Pin the actual warehouse/shop starting point and save.
8. Open checkout as a customer and verify the delivery calculation uses the new
   starting point while keeping the existing price formula.

MOBILE TESTING CHECKLIST
------------------------
  [ ] Map opens on iPhone Safari without hanging.
  [ ] Map opens on Android Chrome.
  [ ] Pin can be tapped and dragged.
  [ ] "Use my current location" handles Allow and Deny cleanly.
  [ ] Closing/reopening the map works repeatedly.
  [ ] Manual address checkout still works with location permission denied.
  [ ] Admin origin persists after refresh/login on another device.
  [ ] Checkout route starts from the admin pin.
  [ ] No page-level horizontal overflow.

See OWNER-ORIGIN-MOBILE-MAP-VERIFICATION.txt for the exact checks performed in the
release environment and the live-network limitation.
