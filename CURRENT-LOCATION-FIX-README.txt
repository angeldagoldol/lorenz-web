DAGOLDOL 3.3.2 — CURRENT LOCATION RELIABILITY FIX
=================================================

PURPOSE
-------
This release fixes the "Use my current location" path used by the reusable
Delivery Location map on Checkout, Profile/My Info, and Admin Delivery Origin.
It is based on the Dagoldol 3.3.1 owner-origin/mobile-map release.

ROOT CAUSE ADDRESSED
--------------------
The 3.3.1 location path used two one-shot browser geolocation requests:
- a low-accuracy attempt with a 6-second timeout, then
- a high-accuracy attempt with a 10-second timeout.

On Windows desktops and phones, a first location fix can legitimately take
longer than those windows. If both one-shot requests timed out, Dagoldol showed
"Location timed out" even though the browser/device could potentially provide
a fix after more time.

WHAT 3.3.2 CHANGES
------------------
1. Permission-aware location acquisition
   - Reads the browser geolocation permission state when the Permissions API is
     available.
   - Stops immediately with a clear explanation if location access is blocked.
   - Explicitly rejects non-HTTPS/insecure contexts.

2. Fast usable fix first
   - Tries a low-power/cached/network location for up to 12 seconds.
   - Accepts a useful coarse fix (<= about 1.2 km accuracy) immediately so the
     map can center quickly and the customer/admin can drag the pin precisely.

3. Better GPS/location acquisition
   - If the fast fix is unavailable or too coarse, uses watchPosition instead
     of another one-shot request.
   - Allows up to 35 seconds for a first difficult indoor/desktop/mobile fix.
   - Resolves immediately at high accuracy (<= about 100 m).
   - A reasonable fix (<= about 1.5 km) settles after a short 4-second window
     instead of waiting for the full deadline.
   - If the deadline expires after at least one usable position arrived, the
     best position received is used rather than throwing it away.
   - The geolocation watch is always cleared after success/failure.

4. Better Windows/iPhone errors
   - Windows failures now explain that Windows Location Services + browser/site
     permission must be enabled.
   - iPhone/iPad failures explain that Location Services + browser/site
     permission must be enabled.
   - Timeout, unsupported browser, permission denial, and insecure-origin
     failures have separate messages.

5. Better UI feedback
   - The button temporarily changes to "Locating…" while a request is active.
   - The map explains that the first location fix can take up to about 35 sec.
   - Successful fixes display approximate accuracy (meters/kilometers) and
     remind the user to drag the pin to the exact rider entrance when needed.

WHAT DOES NOT CHANGE
--------------------
- Existing shop/catalogue UI
- Admin layout
- Profile/checkout address structure
- Saved delivery origin feature
- Supabase authentication/session sync
- Bank/GCash payment configuration
- PixelTrail/LiquidChrome
- Database schema / RLS / Edge Functions
- Delivery pricing

The cancelled ₱399 change remains excluded. The existing delivery constants are
still:
- Free-distance threshold: 5 km
- Distance rate: ₱60/km
- Fallback fee: ₱600

PRIVACY
-------
Dagoldol still requests browser geolocation only after the user explicitly
presses "Use my current location". It does not continuously track location in
the background and does not use an IP-geolocation bypass when browser/device
location permission is denied.

FILES CHANGED IN 3.3.2
----------------------
REPLACE:
- index.html
- config.js
- script.js
- delivery-map.js
- package.json
- scripts/verify-source.mjs
- tests/mobile-fast-bootstrap.test.mjs

ADD:
- tests/geolocation-reliability.test.mjs
- CURRENT-LOCATION-FIX-README.txt
- CURRENT-LOCATION-FIX-VERIFICATION.txt

DEPLOYMENT
----------
1. Back up the current production repo.
2. Copy the replacement files while preserving paths.
3. Add the new geolocation test.
4. Run:
     npm run verify
     npm run build
5. Push to GitHub/Vercel.
6. After deployment, completely close old phone/desktop tabs and reopen the
   site so version 3.3.2 assets are loaded.

WINDOWS DEVICE CHECK
--------------------
If Windows still reports that location is blocked/unavailable:
- Windows Settings -> Privacy & security -> Location
- Turn Location services ON.
- Allow desktop apps/browser access when that option is shown.
- In Chrome/Edge, allow Location for the Dagoldol Vercel site.
- Keep Wi-Fi enabled; desktop location commonly depends on network location
  data even when the PC does not have dedicated GPS hardware.

IPHONE/IPAD DEVICE CHECK
------------------------
If Safari/Chrome still cannot provide location:
- Settings -> Privacy & Security -> Location Services -> ON
- Allow the browser to use location.
- Allow the Dagoldol website's location permission when prompted/site settings.
- Keep Wi-Fi or mobile data available.

If the device/browser still cannot determine a position, manual map pinning and
manual address entry remain available and do not block checkout.
