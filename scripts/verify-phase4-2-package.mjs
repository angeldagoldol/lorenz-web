#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const requiredFiles = [
  "database/20260820_phase4_2_live_contract.sql",
  "database/20260820_phase4_2a_zero_trust_rls_private_data.sql",
  "database/20260820_phase4_2b_checkout_authorization_gate.sql",
  "database/tests/phase4_2_policy_contract.sql",
  "database/tests/phase4_2_rls_regression.sql",
  "database/tests/phase4_2_storage_regression.sql",
  "scripts/phase4-2-storage-runtime.mjs",
  "SECURITY.md",
  "FRONTEND-INTEGRATION-REQUIRED.md",
  "PHASE4.2-IMPLEMENTATION-STATUS.md",
  "README-PHASE4.2-PACKAGE.md",
  "docs/phase4/evidence/PHASE4.2-LIVE-FINDINGS.md",
  "docs/2026-08-20-dagoldol-phase4-2-zero-trust-authorization-design.md",
  "docs/superpowers/plans/2026-08-20-dagoldol-phase4-2-zero-trust-authorization.md"
];

const failures = [];
function fail(message) { failures.push(message); }
function read(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    fail(`missing required file: ${rel}`);
    return "";
  }
  return fs.readFileSync(abs, "utf8");
}

for (const rel of requiredFiles) read(rel);

const migration = read("database/20260820_phase4_2a_zero_trust_rls_private_data.sql");
const policyTest = read("database/tests/phase4_2_policy_contract.sql");
const rlsTest = read("database/tests/phase4_2_rls_regression.sql");
const storageTest = read("database/tests/phase4_2_storage_regression.sql");
const checkoutGate = read("database/20260820_phase4_2b_checkout_authorization_gate.sql");
const status = read("PHASE4.2-IMPLEMENTATION-STATUS.md");

const requiredMigrationTokens = [
  "create or replace function public.is_admin()",
  "set search_path = ''",
  "p42_lookup_profile_directory",
  "p42_get_seller_directory_profile",
  "p42_profiles_select_owner_or_admin",
  "p42_settings_admin_write",
  "p42_promo_codes_admin_write",
  "p42_ratings_insert_purchased_delivered",
  "p42_dm_thread_guard",
  "p42_dm_message_guard",
  "p42_storage_payment_proof_owner_admin_read",
  "p42_storage_admin_media_insert",
  "revoke all on function public.decrement_stock_for_order(jsonb) from anon",
  "grant execute on function public.decrement_stock_for_order(jsonb) to authenticated",
  "p42_orders_insert_owner_compat_phase42a"
];
for (const token of requiredMigrationTokens) {
  if (!migration.includes(token)) fail(`migration missing required token: ${token}`);
}

const forbiddenLegacyPolicyNames = [
  'policy "public full access"',
  'policy "Authenticated users can update settings"',
  'policy "Authenticated users can upsert settings"',
  'policy "ratings_insert_authenticated"',
  'policy "profiles: authenticated can look up basic info"',
  'policy "storage_public_read"'
];
for (const token of forbiddenLegacyPolicyNames) {
  if (migration.toLowerCase().includes(token.toLowerCase())) {
    fail(`migration recreates forbidden legacy policy: ${token}`);
  }
}

if (!migration.includes("begin;") || !migration.includes("commit;")) {
  fail("4.2A migration must be transactional");
}

if (!migration.includes("payment-proofs' and public is distinct from false")) {
  fail("4.2A migration lacks private payment-proofs precondition");
}

if (!policyTest.includes("phase42b_stock_decrement_still_browser_callable")) {
  fail("policy contract test does not keep the Phase 4.2B stock blocker visible");
}

for (const token of [
  "role escalation",
  "Customer A can read Customer B",
  "customer changed trusted own-order total",
  "customer updated storefront settings",
  "forged Customer B reaction",
  "Customer A rated Customer B order",
  "admin could not update settings"
]) {
  if (!rlsTest.toLowerCase().includes(token.toLowerCase())) {
    fail(`RLS behavior test missing scenario text: ${token}`);
  }
}

if (!rlsTest.includes("rollback;")) fail("RLS behavior test must roll back fixtures");

for (const token of [
  "payment-proofs bucket is not private",
  "anonymous storage.objects SELECT policy remains",
  "p42_storage_payment_proof_owner_admin_read"
]) {
  if (!storageTest.includes(token)) fail(`Storage structural test missing: ${token}`);
}

for (const token of [
  "payment_reference",
  "payment_proof",
  "half_payment",
  "amount_due_now",
  "amount_due_later",
  "customer_can_decrement_stock",
  "p42_orders_insert_owner_compat_phase42a"
]) {
  if (!checkoutGate.includes(token)) fail(`Phase 4.2B gate missing diagnostic: ${token}`);
}

if (!status.includes("**Phase 4.2 exit gate: NOT PASSED.**")) {
  fail("status document must not claim Phase 4.2 completion");
}

// No placeholder markers in implementation artifacts. The approved plan may
// discuss validation steps, so only executable/security deliverables are scanned.
const executableDocs = [
  "database/20260820_phase4_2a_zero_trust_rls_private_data.sql",
  "database/20260820_phase4_2b_checkout_authorization_gate.sql",
  "database/tests/phase4_2_policy_contract.sql",
  "database/tests/phase4_2_rls_regression.sql",
  "database/tests/phase4_2_storage_regression.sql",
  "scripts/phase4-2-storage-runtime.mjs",
  "SECURITY.md",
  "FRONTEND-INTEGRATION-REQUIRED.md",
  "PHASE4.2-IMPLEMENTATION-STATUS.md"
];
for (const rel of executableDocs) {
  const text = read(rel);
  if (/\bTODO\b|\bTBD\b|existing code here|rest remains the same|unchanged code/i.test(text)) {
    fail(`placeholder marker found in ${rel}`);
  }
}

// Lightweight lexical SQL checks: dollar-quote pairs and parentheses outside
// comments/quoted strings. This is not a PostgreSQL parser; staging execution is
// still required before deployment.
function sqlLexicalCheck(rel, text) {
  const dollarMatches = [...text.matchAll(/\$\$/g)].length;
  if (dollarMatches % 2 !== 0) fail(`${rel}: unmatched $$ delimiter`);

  let depth = 0;
  let i = 0;
  let single = false;
  let lineComment = false;
  let blockComment = false;
  let dollar = false;
  while (i < text.length) {
    const a = text[i];
    const b = text[i + 1];
    if (lineComment) {
      if (a === "\n") lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (a === "*" && b === "/") { blockComment = false; i += 2; } else i += 1;
      continue;
    }
    if (dollar) {
      if (a === "$" && b === "$") { dollar = false; i += 2; } else i += 1;
      continue;
    }
    if (single) {
      if (a === "'" && b === "'") { i += 2; continue; }
      if (a === "'") single = false;
      i += 1;
      continue;
    }
    if (a === "-" && b === "-") { lineComment = true; i += 2; continue; }
    if (a === "/" && b === "*") { blockComment = true; i += 2; continue; }
    if (a === "$" && b === "$") { dollar = true; i += 2; continue; }
    if (a === "'") { single = true; i += 1; continue; }
    if (a === "(") depth += 1;
    if (a === ")") {
      depth -= 1;
      if (depth < 0) { fail(`${rel}: closing parenthesis without opener`); return; }
    }
    i += 1;
  }
  if (depth !== 0) fail(`${rel}: unbalanced parentheses (${depth})`);
  if (single || blockComment || dollar) fail(`${rel}: unterminated SQL lexical construct`);
}

for (const rel of [
  "database/20260820_phase4_2_live_contract.sql",
  "database/20260820_phase4_2a_zero_trust_rls_private_data.sql",
  "database/20260820_phase4_2b_checkout_authorization_gate.sql",
  "database/tests/phase4_2_policy_contract.sql",
  "database/tests/phase4_2_rls_regression.sql",
  "database/tests/phase4_2_storage_regression.sql"
]) {
  sqlLexicalCheck(rel, read(rel));
}

if (failures.length) {
  console.error("Dagoldol Phase 4.2 package verification FAILED:");
  for (const item of failures) console.error(` - ${item}`);
  process.exit(1);
}

console.log(`Dagoldol Phase 4.2 package verification passed (${requiredFiles.length} required files).`);
console.log("Note: lexical SQL checks are not a substitute for staging PostgreSQL execution.");
