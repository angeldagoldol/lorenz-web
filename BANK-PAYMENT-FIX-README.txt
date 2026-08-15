DAGOLDOL — BANK PAYMENT + PASSWORD SHOW BUTTON FIX
Date: 2026-08-16

WHAT THIS CHANGES
1. Fixes the misplaced Show/Hide password button by removing it from the generic pill-button positioning animation that was overriding style.css.
2. Adds one admin-editable Bank Transfer account in Admin > Payment Settings.
3. Admin can edit:
   - Bank name
   - Account holder name
   - Account number
   - Bank payment QR image
4. Checkout shows the saved bank details and bank QR when the customer chooses Bank Transfer.
5. The bank QR uses the existing payment-settings Supabase Storage bucket and the existing click-to-zoom image lightbox.
6. Public catalogue fallback allowlist now includes only the approved public bank-payment keys.

FILES TO REPLACE IN YOUR PROJECT
- index.html
- script.js
- pill-buttons.css
- package.json
- scripts/generate-public-catalogue.mjs
- scripts/verify-source.mjs

FILES TO ADD
- tests/payment-settings-contract.mjs
- tests/payment-settings-runtime.spec.py

DO NOT REPLACE / NO CHANGE REQUIRED
- style.css
- style1.css
- script1.js
- config.js
- liquid-chrome.js
- phase2-core.js
- phase2-accessibility.js
- phase2-fixes.css
- phase3-fixes.css
- pixel-trail.js
- pixel-trail.css
- database/*
- supabase/functions/*
- product images/content

DATABASE / SUPABASE
No new table or SQL migration is required. The feature reuses the existing settings key/value table already used by GCash and the existing public payment-settings Storage bucket.

The new settings keys are:
- bank_name
- bank_account_name
- bank_account_number
- bank_qr_image

IMPORTANT SECURITY NOTE
The UI exposes these edit controls only in the admin Payment Settings screen and uses the same settings/storage write path already used by GCash. Supabase RLS remains the server-side authority. If your existing settings table write policy is not admin-restricted, that is an existing database-policy issue and should be corrected separately after inspecting the live policy definitions.

HOW TO USE AFTER DEPLOYMENT
1. Log in as the admin/owner.
2. Open Admin.
3. Open Payment Settings.
4. Enter the bank name, account holder name, and account number.
5. Upload the real bank/QR Ph payment QR image supplied by your bank/payment app.
6. Click Save payment settings.
7. Open checkout and choose Bank Transfer to verify the QR and details.

The application does NOT fabricate a QR code from an account number. The admin uploads the real bank payment QR so customers scan the correct payment payload.

LOCAL VERIFICATION
Run:
  npm run verify

Optional browser regression test in the provided development environment:
  python tests/payment-settings-runtime.spec.py

DEPLOYMENT CACHE
index.html now requests script.js and pill-buttons.css with v=3.1.1 so browsers do not keep using the previous cached files.
