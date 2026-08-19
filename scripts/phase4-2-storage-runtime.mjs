#!/usr/bin/env node
/**
 * Dagoldol Phase 4.2 Storage runtime regression.
 *
 * STAGING ONLY. The script refuses to run unless:
 *   P42_ALLOW_STORAGE_TESTS=staging-only-confirmed
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_PUBLISHABLE_KEY
 *   P42_CUSTOMER_A_JWT
 *   P42_CUSTOMER_B_JWT
 *   P42_ADMIN_JWT
 *
 * It creates small text fixtures through the Storage API, validates owner,
 * cross-account, anonymous and admin behavior, then deletes its fixtures.
 */

const REQUIRED_SENTINEL = "staging-only-confirmed";
if (process.env.P42_ALLOW_STORAGE_TESTS !== REQUIRED_SENTINEL) {
  console.error(`Refusing Storage writes. Set P42_ALLOW_STORAGE_TESTS=${REQUIRED_SENTINEL} only for an isolated staging project.`);
  process.exit(2);
}

const required = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "P42_CUSTOMER_A_JWT",
  "P42_CUSTOMER_B_JWT",
  "P42_ADMIN_JWT"
];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(2);
  }
}

const baseUrl = process.env.SUPABASE_URL.replace(/\/$/, "");
const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const customerA = process.env.P42_CUSTOMER_A_JWT;
const customerB = process.env.P42_CUSTOMER_B_JWT;
const admin = process.env.P42_ADMIN_JWT;

function decodeJwtSubject(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  if (!payload.sub || typeof payload.sub !== "string") throw new Error("JWT has no sub claim");
  return payload.sub;
}

const customerAId = decodeJwtSubject(customerA);
const customerBId = decodeJwtSubject(customerB);
const adminId = decodeJwtSubject(admin);
if (customerAId === customerBId || customerAId === adminId || customerBId === adminId) {
  throw new Error("Storage test JWTs must represent three distinct accounts");
}

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const proofAPath = `${customerAId}/p42-${suffix}.txt`;
const proofForgedPath = `${customerAId}/p42-forged-${suffix}.txt`;
const avatarAPath = `${customerAId}/p42-${suffix}.txt`;
const productPath = `p42-regression/${suffix}.txt`;

const cleanupJobs = [];
let failures = 0;

function headers(jwt, contentType) {
  const h = {
    apikey: apiKey,
    Authorization: `Bearer ${jwt}`
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

async function upload(bucket, path, jwt, text) {
  return fetch(`${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { ...headers(jwt, "text/plain"), "x-upsert": "false" },
    body: text
  });
}

async function downloadPrivate(bucket, path, jwt) {
  return fetch(`${baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "GET",
    headers: headers(jwt)
  });
}

async function downloadPrivateAnon(bucket, path) {
  return fetch(`${baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "GET",
    headers: { apikey: apiKey }
  });
}

async function remove(bucket, paths, jwt) {
  return fetch(`${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: "DELETE",
    headers: headers(jwt, "application/json"),
    body: JSON.stringify({ prefixes: paths })
  });
}

function pass(name, detail = "") {
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
  failures += 1;
  console.error(`FAIL ${name} — ${detail}`);
}

async function expectAllowed(name, response) {
  if (response.ok) pass(name, `HTTP ${response.status}`);
  else fail(name, `expected success, received HTTP ${response.status}: ${await response.text()}`);
}

async function expectDenied(name, response) {
  if (!response.ok) pass(name, `denied with HTTP ${response.status}`);
  else fail(name, `expected denial, received HTTP ${response.status}`);
}

try {
  let response = await upload("payment-proofs", proofAPath, customerA, "phase4.2 owner proof");
  await expectAllowed("Customer A uploads into own payment-proof namespace", response);
  if (response.ok) cleanupJobs.push(() => remove("payment-proofs", [proofAPath], customerA));

  response = await downloadPrivate("payment-proofs", proofAPath, customerA);
  await expectAllowed("Customer A reads own private payment proof", response);

  response = await downloadPrivate("payment-proofs", proofAPath, customerB);
  await expectDenied("Customer B cannot read Customer A payment proof", response);

  response = await downloadPrivateAnon("payment-proofs", proofAPath);
  await expectDenied("Anonymous request cannot read private payment proof", response);

  response = await downloadPrivate("payment-proofs", proofAPath, admin);
  await expectAllowed("Verified admin can read customer payment proof", response);

  response = await upload("payment-proofs", proofForgedPath, customerB, "forged namespace attempt");
  await expectDenied("Customer B cannot upload into Customer A payment-proof namespace", response);

  response = await upload("avatars", avatarAPath, customerA, "phase4.2 avatar fixture");
  await expectAllowed("Customer A uploads into own avatar namespace", response);
  if (response.ok) cleanupJobs.push(() => remove("avatars", [avatarAPath], customerA));

  response = await upload("avatars", avatarAPath.replace(customerAId, customerBId), customerA, "cross-user avatar attempt");
  await expectDenied("Customer A cannot upload into Customer B avatar namespace", response);

  response = await upload("product-images", productPath, customerA, "customer admin-media attempt");
  await expectDenied("Customer cannot upload product image", response);

  response = await upload("product-images", productPath, admin, "admin product image fixture");
  await expectAllowed("Verified admin uploads product image", response);
  if (response.ok) cleanupJobs.push(() => remove("product-images", [productPath], admin));
} finally {
  for (const cleanup of cleanupJobs.reverse()) {
    try {
      const response = await cleanup();
      if (!response.ok) console.warn(`WARN cleanup returned HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      console.warn(`WARN cleanup failed: ${error.message}`);
    }
  }
}

if (failures > 0) {
  console.error(`Phase 4.2 Storage runtime regression failed: ${failures} assertion(s).`);
  process.exit(1);
}

console.log("Phase 4.2 Storage runtime regression passed.");
