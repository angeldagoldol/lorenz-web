import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  preflight: 'database/00_phase4_2b_preflight.sql',
  migration: 'database/20260820_phase4_2b_commerce_authority_compat.sql',
  contract: 'database/tests/phase4_2b_contract.sql',
  behavior: 'database/tests/phase4_2b_behavior.sql',
  status: 'docs/phase4/PHASE4.2B-STATUS.md',
  readme: 'README-FIRST.md',
  security: 'SECURITY.md'
};

const errors = [];
for (const rel of Object.values(files)) {
  try { await access(resolve(ROOT, rel)); }
  catch { errors.push(`Missing required file: ${rel}`); }
}

if (errors.length === 0) {
  const preflight = await readFile(resolve(ROOT, files.preflight), 'utf8');
  const migration = await readFile(resolve(ROOT, files.migration), 'utf8');
  const contract = await readFile(resolve(ROOT, files.contract), 'utf8');
  const behavior = await readFile(resolve(ROOT, files.behavior), 'utf8');
  const status = await readFile(resolve(ROOT, files.status), 'utf8');
  const security = await readFile(resolve(ROOT, files.security), 'utf8');

  if (!preflight.includes('phase42b_preflight_status')) errors.push('Preflight does not expose phase42b_preflight_status.');
  const preflightWithoutComments = preflight.replace(/^--.*$/gm, '');
  if (/^\s*(insert|update|delete|alter|create|drop|grant|revoke)\b/im.test(preflightWithoutComments)) {
    errors.push('Preflight contains a top-level write/DDL/DCL statement.');
  }

  const requiredMigrationMarkers = [
    'begin;',
    'add column if not exists payment_reference text',
    'add column if not exists payment_proof text',
    'add column if not exists half_payment boolean',
    'add column if not exists amount_due_now numeric',
    'add column if not exists amount_due_later numeric',
    'create schema if not exists dagoldol_private authorization postgres',
    'create or replace function dagoldol_private.apply_stock_lines',
    'create or replace function public.decrement_stock_for_order',
    'security invoker',
    'create or replace function public.restore_stock_for_order',
    'create or replace function public.guard_customer_order_write()',
    'security definer',
    'perform dagoldol_private.apply_stock_lines(v_stock_lines,-1)',
    'update public.promo_codes',
    'perform dagoldol_private.apply_stock_lines(v_cancel_lines,1)',
    'create or replace function public.place_order(',
    'create policy p42_orders_insert_owner',
    'commit;'
  ];

  for (const marker of requiredMigrationMarkers) {
    if (!migration.toLowerCase().includes(marker.toLowerCase())) {
      errors.push(`Migration missing required marker: ${marker}`);
    }
  }

  const forbiddenMigrationPatterns = [
    /alter\s+table\s+storage\./i,
    /create\s+policy[\s\S]*?on\s+storage\./i,
    /drop\s+policy[\s\S]*?on\s+storage\./i,
    /grant\s+.*supabase_storage_admin/i,
    /todo/i,
    /existing code here/i,
    /\.\.\./
  ];
  for (const pattern of forbiddenMigrationPatterns) {
    if (pattern.test(migration)) errors.push(`Forbidden migration pattern found: ${pattern}`);
  }

  const decrementStart = migration.indexOf('create or replace function public.decrement_stock_for_order');
  const decrementEnd = migration.indexOf('comment on function public.decrement_stock_for_order', decrementStart);
  const decrementBlock = migration.slice(decrementStart, decrementEnd);
  if (/update\s+public\.products/i.test(decrementBlock)) {
    errors.push('Public decrement compatibility RPC still mutates public.products.');
  }

  const restoreStart = migration.indexOf('create or replace function public.restore_stock_for_order');
  const restoreEnd = migration.indexOf('comment on function public.restore_stock_for_order', restoreStart);
  const restoreBlock = migration.slice(restoreStart, restoreEnd);
  if (/update\s+public\.products/i.test(restoreBlock)) {
    errors.push('Public restore compatibility RPC still mutates public.products.');
  }

  const dollarQuoteCount = (migration.match(/\$\$/g) || []).length;
  if (dollarQuoteCount % 2 !== 0) errors.push(`Unbalanced $$ delimiters: ${dollarQuoteCount}`);

  if (!contract.includes("phase42b_contract_status")) {
    errors.push('Contract test does not expose phase42b_contract_status.');
  }
  if (!contract.includes("Delivery route pricing remains a Phase 4.3")) {
    errors.push('Contract test does not preserve the Phase 4.3 delivery boundary.');
  }
  if (!behavior.toLowerCase().trimEnd().endsWith('rollback;')) {
    errors.push('Behavior regression must end with ROLLBACK.');
  }
  if (!behavior.includes('DO NOT RUN THIS ON PRODUCTION')) {
    errors.push('Behavior regression is missing its production safety warning.');
  }
  if (!security.includes('dagoldol_private.apply_stock_lines')) errors.push('SECURITY.md is missing the Phase 4.2B private stock boundary.');
  if (!security.includes('Phase 4.3 commerce boundary')) errors.push('SECURITY.md is missing the residual Phase 4.3 boundary.');

  const normalizedStatus = status.replace(/\*/g, '').toLowerCase();
  if (!normalizedStatus.includes('not been applied by chatgpt to production')) {
    errors.push('Status file must explicitly state production was not mutated.');
  }
}

if (errors.length) {
  console.error('Dagoldol Phase 4.2B package verification FAILED.');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Dagoldol Phase 4.2B package verification passed.');
console.log(`Checked ${Object.keys(files).length} required files plus migration safety markers.`);
