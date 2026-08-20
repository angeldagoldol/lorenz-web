import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const evidence = await fs.readFile(new URL('../docs/phase4/PHASE4.3-DELIVERY-ZONE-EVIDENCE.md', import.meta.url), 'utf8');
const migration = await fs.readFile(new URL('../database/20260820_phase4_3_server_authoritative_checkout.sql', import.meta.url), 'utf8');

for (const token of [
  'Katipunan National High School',
  'Kimasog',
  '7.423760',
  '125.233630',
  '7.316345',
  '125.299076',
  'currently 5 km',
  'currently PHP 60/km',
  'currently PHP 600',
]) {
  assert.ok(evidence.includes(token), `delivery evidence missing ${token}`);
}

assert.match(migration, /'katipunan-nhs-arakan'[\s\S]*7\.423760[\s\S]*125\.233630/);
assert.match(migration, /'kimasog-marilog'[\s\S]*7\.316345[\s\S]*125\.299076/);
assert.match(migration, /values \(true, 5, 60, 600\)/i);
assert.match(migration, /free_km_threshold/);
assert.match(migration, /rate_per_km/);
assert.match(migration, /fallback_fee/);

console.log('Phase 4.3 delivery-zone package evidence: PASS');
