import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const mapPath = path.join(root, 'delivery-map.js');
const scriptSource = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'phase3-fixes.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

async function importMapModule() {
  return import(`${pathToFileURL(mapPath).href}?t=${Date.now()}-${Math.random()}`);
}

test('Philippine reverse parser recovers street and city from display_name when structured fields are sparse', async () => {
  const { buildAddressFromNominatim } = await importMapModule();
  const result = buildAddressFromNominatim({
    display_name: 'Purok 5, Barangay Tamugan, Baguio District, Davao City, Davao Region, 8000, Philippines',
    address: {
      postcode: '8000',
      country_code: 'ph'
    }
  });

  assert.equal(result.address, 'Purok 5, Barangay Tamugan');
  assert.equal(result.city, 'Davao City');
  assert.equal(result.postal, '8000');
  assert.equal(result.landmarkSuggestion, 'Barangay Tamugan');
});

test('Philippine reverse parser uses village/barangay and municipality fallbacks without blanking required address fields', async () => {
  const { buildAddressFromNominatim } = await importMapModule();
  const result = buildAddressFromNominatim({
    display_name: 'Sitio Riverside, Barangay San Jose, Municipality of Santo Tomas, Davao del Norte, 8112, Philippines',
    address: {
      village: 'Barangay San Jose',
      municipality: 'Santo Tomas',
      postcode: '8112',
      country_code: 'ph'
    }
  });

  assert.match(result.address, /San Jose/i);
  assert.equal(result.city, 'Santo Tomas');
  assert.equal(result.postal, '8112');
});

test('raw GPS movement is not published as a confirmable selection before reverse lookup completes', () => {
  const rawFunction = /const showRawPosition = \(position,[\s\S]*?return selected;\n  };/m.exec(fs.readFileSync(mapPath, 'utf8'))?.[0] || '';
  assert.doesNotMatch(rawFunction, /onSelectionChange\(selected\)/, 'raw device coordinates must not enable confirmation before address lookup completes');
  assert.match(fs.readFileSync(mapPath, 'utf8'), /onLookupStateChange/);
});

test('admin accounts expose saved customer delivery details and a private view-pin action', () => {
  assert.match(scriptSource, /adminLatestDeliveryByUserId/);
  assert.match(scriptSource, /data-action=["']view-customer-location["']/);
  assert.match(scriptSource, /View delivery pin/);
  assert.match(scriptSource, /openAdminCustomerDeliveryLocation/);
  assert.match(scriptSource, /No saved delivery pin/);
});

test('admin customer delivery map is read-only', () => {
  const mapSource = fs.readFileSync(mapPath, 'utf8');
  assert.match(mapSource, /readOnly\s*=\s*false/);
  assert.match(mapSource, /draggable:\s*!readOnly/);
  assert.match(mapSource, /if\s*\(!readOnly\)\s*\{[\s\S]*map\.on\(["']click["']/m);
  assert.match(scriptSource, /admin-customer/);
});

test('3.3.5 release includes admin pin styles and verification script hook', () => {
  assert.equal(pkg.version, '3.3.5');
  assert.match(cssSource, /admin-customer-delivery/);
  assert.match(pkg.scripts.verify, /test:smart-delivery/);
});
