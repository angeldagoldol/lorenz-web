# Landmark Autofill + Map Controls Implementation Plan

**Goal:** Auto-fill a useful map-derived landmark only when the customer has not already entered one, preserve customer-written landmarks, expose a restore-suggestion action, and make the delivery-map controls reliable and reachable on phone and desktop.

**Architecture:** Extend the existing Nominatim parser with a pure landmark-suggestion field; keep street/city/postal pin consistency unchanged; maintain separate profile/checkout suggestion state in `script.js`; add additive suggestion UI beside both landmark fields; improve the existing reusable map modal controls without changing routing, auth, payment, owner-origin, or delivery-pricing logic.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Leaflet 1.9.4, Supabase, Node built-in test runner.

## Global Constraints
- Keep existing delivery fee constants unchanged.
- Landmark autofill happens only when the target landmark field is empty.
- Existing customer-written landmark text must never be overwritten by a map pin.
- A map suggestion can be restored explicitly with one button.
- Map failure must never block manual address entry or checkout.
- Keep desktop catalogue visual regression unchanged outside the delivery/profile UI.
- No database migration; continue storing the final landmark in the existing address JSON.

### Task 1: Landmark suggestion parser
- Modify `delivery-map.js` to derive `landmarkSuggestion` from named POI/building/neighbourhood data while avoiding duplicates of street/city.
- Preserve `landmarkSuggestion` through saved selection snapshots.
- Add regression tests for named POI and fallback neighbourhood suggestions.

### Task 2: Profile and checkout suggestion state
- Modify `index.html` with suggestion rows under both landmark fields.
- Modify `script.js` so map confirmation auto-fills landmark only if blank, preserves manual text, and provides `Use suggested landmark` restore.
- Clear autofill styling on manual edits without making the location pin stale.

### Task 3: Map controls and phone action bar
- Improve current-location button state copy and add a center-on-current-location action after a geolocation fix.
- Rename final confirmation action to `Use this location` and keep it disabled until a valid pin exists.
- Make map actions sticky on mobile and keep controls above safe-area/browser chrome.

### Task 4: Verification and release
- Bump assets/package to 3.3.4.
- Extend source verifier and mobile/bootstrap tests.
- Run syntax, contract, full verify, CSS parse, mobile runtime/layout tests, manifest, and ZIP integrity.
