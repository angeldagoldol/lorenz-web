DAGOLDOL 3.3.0 — DELIVERY MAP + SAVED PIN
=========================================

PURPOSE
-------
Adds a reusable delivery-location picker to both:
1. My Info / Profile delivery address
2. Checkout delivery address

The existing Dagoldol visual design, product catalogue, authentication, payments,
admin tools, LiquidChrome, PixelTrail, and mobile performance behavior are preserved.

CUSTOMER FLOW
-------------
- Open Profile or Checkout.
- Choose "Pin delivery location" / "Change location".
- The map library is loaded only at that moment; it is not part of initial page startup.
- Tap/click the map or drag the marker.
- Dagoldol reverse-geocodes the pin and fills Street, City/Municipality, and Postal Code when available.
- Landmark remains user-editable because map providers cannot reliably identify a gate/entrance.
- "Use my current location" requests browser geolocation only after the customer presses it.
- Confirming saves the coordinates with the address.
- Profile-saved pins are restored in Checkout and on other devices after the account profile is reloaded.

ADDRESS DATA
------------
No database migration is required. The existing public.profiles.address JSONB value is extended compatibly:

{
  "street": "...",
  "city": "...",
  "postal": "...",
  "landmark": "...",
  "location": {
    "latitude": 0,
    "longitude": 0,
    "source": "map" | "geolocation",
    "pinned_at": "ISO-8601 timestamp",
    "address_snapshot": {
      "street": "...",
      "city": "...",
      "postal": "..."
    }
  }
}

Existing profiles/orders without location remain valid.

DELIVERY ROUTING
----------------
- A confirmed, non-stale map pin is used directly for delivery routing/distance.
- If the customer edits Street/City/Postal after confirming the pin, Dagoldol marks the pin stale.
- Stale coordinates are not used for delivery routing and are not persisted as a confirmed location until the customer reconfirms the map.
- If map/geolocation/reverse-geocoding is unavailable, the existing manual address workflow still works.

MOBILE/PERFORMANCE
------------------
- MapLibre is not loaded on catalogue/login startup.
- Map assets load only when the location picker opens.
- The map instance is destroyed when the picker closes, releasing its WebGL resources.
- The existing phone LiquidChrome fallback and PixelTrail behavior are unchanged.
- The map modal uses dynamic viewport/safe-area containment for iPhone/Android widths.

MAP SERVICES
------------
- Map renderer: MapLibre GL JS 5.12.0 (loaded lazily from jsDelivr).
- Base map style: OpenFreeMap Liberty style.
- Reverse geocoding: OpenStreetMap Nominatim for deliberate pin/current-location actions only.
- Reverse lookups are serialized to at least 1.1 seconds apart and cached locally where storage is available.
- No autocomplete traffic is sent to Nominatim.

PRIVACY/SECURITY
----------------
- Browser geolocation is requested only after the customer explicitly presses the current-location button.
- Coordinates are stored only as part of the customer's existing profile/order address records.
- Existing Supabase RLS remains the ownership boundary; no public location table was added.
- Coordinates are client-validated to the Philippine geographic envelope before use.
- The map is optional and never blocks checkout when location permission is denied.

IMPORTANT PRODUCTION BOUNDARY
-----------------------------
This feature does not change Dagoldol's existing checkout authority model. Delivery-price/order-total enforcement remains part of the broader server-authoritative checkout work and should ultimately be validated atomically on the server before a production financial transaction is considered authoritative.

DEPLOYMENT — RUNTIME FILES
--------------------------
REPLACE:
  index.html
  script.js
  phase3-fixes.css
  config.js
  vercel.json
  package.json
  scripts/verify-source.mjs
  tests/mobile-fast-bootstrap.test.mjs

ADD:
  delivery-map.js
  tests/delivery-map-contract.test.mjs
  tests/delivery-location-runtime.spec.py
  docs/superpowers/plans/2026-08-18-delivery-map-location-plan.md

NO DATABASE MIGRATION IS REQUIRED.

NOT CHANGED BY THIS FEATURE
---------------------------
  style.css
  pill-buttons.css
  phase2-fixes.css
  phase2-core.js
  phase2-accessibility.js
  liquid-chrome.js
  pixel-trail.js
  pixel-trail.css
  auth-resilience.js
  script1.js
  style1.css
  database/*
  supabase/functions/*
  catalogue-snapshot.json
  products/*

VERIFY BEFORE DEPLOYMENT
------------------------
Run:
  npm run verify

The normal production catalogue build also requires network access to the configured Supabase project:
  npm run build

In the provided verification environment, npm run build could not complete because DNS access to the Supabase hostname returned EAI_AGAIN. That is an environment/network limitation, not reported as a build pass.
