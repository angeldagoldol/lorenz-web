import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const source = await fs.readFile(new URL('../script.js', import.meta.url), 'utf8');
assert.match(source, /Katipunan National High School/);
assert.match(source, /Kimasog, Marilog District/);
assert.match(source, /DELIVERY_FREE_KM_THRESHOLD\s*=\s*5/);
console.log('Phase 4.3 delivery-zone source evidence: PASS');
