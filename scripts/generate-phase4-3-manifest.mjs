import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'README-PHASE4.3-STAGE-A.md',
  'SECURITY.md',
  'database/20260820_phase4_3_server_authoritative_checkout.sql',
  'database/tests/phase4_3_contract.sql',
  'docs/phase4/PHASE4.3-DELIVERY-ZONE-EVIDENCE.md',
  'docs/phase4/PHASE4.3-PRODUCTION-PROMOTION-CHECKLIST.md',
  'docs/phase4/PHASE4.3-VERIFICATION.md',
  'scripts/verify-phase4-3-delivery-zones.mjs',
  'scripts/verify-phase4-3-package.mjs',
  'scripts/generate-phase4-3-manifest.mjs',
  'supabase/functions/checkout/index.ts',
  'supabase/functions/checkout/db.ts',
  'supabase/functions/checkout/handler.ts',
  'supabase/functions/checkout/router.ts',
  'supabase/functions/checkout/contracts.ts',
  'supabase/functions/checkout/errors.ts',
  'supabase/functions/checkout/deno.json',
  'supabase/functions/checkout/tsconfig.json',
  'supabase/functions/checkout/contracts.test.ts',
  'supabase/functions/checkout/errors.test.ts',
  'supabase/functions/checkout/handler.test.ts',
  'supabase/functions/checkout/router.test.ts',
  'tests/phase4-3-edge-integration.test.mjs',
  'tests/phase4-3-concurrency.test.mjs',
];

const lines = [];
for (const relative of files) {
  const fullPath = path.join(repoRoot, relative);
  const data = await fs.readFile(fullPath);
  const digest = createHash('sha256').update(data).digest('hex');
  lines.push(`${digest}  ${relative}`);
}

await fs.writeFile(path.join(repoRoot, 'MANIFEST-PHASE4.3-STAGE-A.sha256'), `${lines.join('\n')}\n`, 'utf8');
console.log(`Phase 4.3 manifest generated: ${lines.length} files`);
