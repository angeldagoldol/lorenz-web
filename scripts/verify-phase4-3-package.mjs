import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const required = [
  'database/20260820_phase4_3_server_authoritative_checkout.sql',
  'database/tests/phase4_3_contract.sql',
  'docs/phase4/PHASE4.3-VERIFICATION.md',
  'docs/phase4/PHASE4.3-PRODUCTION-PROMOTION-CHECKLIST.md',
  'supabase/functions/checkout/index.ts',
  'supabase/functions/checkout/contracts.ts',
  'supabase/functions/checkout/errors.ts',
  'supabase/functions/checkout/router.ts',
  'supabase/functions/checkout/db.ts',
  'supabase/functions/checkout/handler.ts',
  'supabase/functions/checkout/deno.json',
  'tests/phase4-3-edge-integration.test.mjs',
  'tests/phase4-3-concurrency.test.mjs',
  'SECURITY.md',
  'MANIFEST-PHASE4.3-STAGE-A.sha256',
];

for (const relative of required) {
  const url = new URL(relative, root);
  const stat = await fs.stat(url);
  assert.ok(stat.isFile() && stat.size > 0, `${relative} must exist and be non-empty`);
}

const migration = await fs.readFile(new URL('database/20260820_phase4_3_server_authoritative_checkout.sql', root), 'utf8');
for (const token of [
  'dagoldol_private.checkout_requests',
  'enable row level security',
  'p43_get_routing_config',
  'p43_quote_checkout',
  'p43_commit_checkout',
  'p43_resolve_checkout',
  'IDEMPOTENCY',
]) {
  assert.ok(migration.toLowerCase().includes(token.toLowerCase()), `migration missing ${token}`);
}
assert.match(migration, /revoke all on function public\.p43_commit_checkout[\s\S]*anon, authenticated/i);

const router = await fs.readFile(new URL('supabase/functions/checkout/router.ts', root), 'utf8');
assert.match(router, /main\.roadDistanceKm <= config\.freeKmThreshold/);
assert.doesNotMatch(router, /main\.roadDistanceKm\s*<=\s*5\b/);

const index = await fs.readFile(new URL('supabase/functions/checkout/index.ts', root), 'utf8');
assert.match(index, /SUPABASE_SERVICE_ROLE_KEY/);
assert.match(index, /https:\/\/lorenz-web-six\.vercel\.app/);



const manifestText = await fs.readFile(new URL('MANIFEST-PHASE4.3-STAGE-A.sha256', root), 'utf8');
const manifestEntries = manifestText.trim().split(/\r?\n/).filter(Boolean);
assert.ok(manifestEntries.length >= 20, 'manifest must cover the Stage A candidate files');
for (const line of manifestEntries) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
  assert.ok(match, `invalid manifest line: ${line}`);
  const [, expected, relative] = match;
  const data = await fs.readFile(new URL(relative, root));
  const actual = createHash('sha256').update(data).digest('hex');
  assert.equal(actual, expected, `checksum mismatch: ${relative}`);
}

console.log(`Phase 4.3 package structure and manifest: PASS (${required.length} required files)`);
