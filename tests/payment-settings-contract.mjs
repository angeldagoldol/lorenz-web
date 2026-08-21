import test from 'node:test';
import { fileURLToPath } from "node:url";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (name) => readFileSync(resolve(root, name), 'utf8');

const html = read('index.html');
const js = read('script.js');
const pillCss = read('pill-buttons.css');
const generator = read('scripts/generate-public-catalogue.mjs');

const BANK_KEYS = [
  'bank_name',
  'bank_account_name',
  'bank_account_number',
  'bank_qr_image'
];

test('checkout contains customer-facing bank account fields and QR elements', () => {
  for (const id of [
    'bank-name-text',
    'bank-account-name-text',
    'bank-account-number-text',
    'bank-qr-img',
    'bank-qr-placeholder'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test('settings state and DOM application include all bank payment keys', () => {
  for (const key of BANK_KEYS) {
    assert.match(js, new RegExp(`\\b${key}\\b`), `script.js missing ${key}`);
  }
  assert.match(js, /bank-name-text/);
  assert.match(js, /bank-account-name-text/);
  assert.match(js, /bank-account-number-text/);
  assert.match(js, /bank-qr-img/);
  assert.match(js, /bank-qr-placeholder/);
});

test('admin Payment Settings exposes editable bank details and QR controls', () => {
  for (const id of [
    'admin-bank-name',
    'admin-bank-account-name',
    'admin-bank-account-number',
    'admin-bank-qr-input',
    'admin-bank-qr-preview',
    'admin-bank-qr-remove'
  ]) {
    assert.match(js, new RegExp(id), `missing ${id}`);
  }
  assert.match(js, /uploadImageToStorage\(file,\s*["']payment-settings["'],\s*["']bank-qr["']/);
  for (const key of BANK_KEYS) {
    assert.match(js, new RegExp(`saveSetting\\(["']${key}["']`), `admin save missing ${key}`);
  }
});

test('public catalogue snapshot allowlist includes bank payment settings', () => {
  for (const key of BANK_KEYS) {
    assert.match(generator, new RegExp(`["']${key}["']`), `generator allowlist missing ${key}`);
  }
});

test('pill animation CSS does not override password toggle absolute positioning', () => {
  const baseMechanicsMatch = pillCss.match(/\.btn-primary,[\s\S]*?\{\s*position:\s*relative;[\s\S]*?\}/);
  assert.ok(baseMechanicsMatch, 'expected pill base mechanics block');
  assert.doesNotMatch(baseMechanicsMatch[0], /\.password-toggle-btn\s*,?/,
    'password toggle must not be included in the relative-position pill mechanics block');
});
