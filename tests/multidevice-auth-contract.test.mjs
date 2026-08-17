import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const scriptPath = resolve(ROOT, 'script.js');

async function source(){
  return readFile(scriptPath, 'utf8');
}

test('browser auth client explicitly persists and refreshes each device session', async () => {
  const text = await source();
  assert.match(text, /persistSession\s*:\s*true/);
  assert.match(text, /autoRefreshToken\s*:\s*true/);
});

test('normal Dagoldol logout revokes only the current device session', async () => {
  const text = await source();
  assert.match(text, /async function backToLogin\(\)[\s\S]*?signOut\(\{\s*scope:\s*["']local["']\s*\}\)/);
});

test('no browser auth cleanup path uses global signOut implicitly', async () => {
  const text = await source();
  const bareCalls = text.match(/supabase\.auth\.signOut\(\s*\)/g) || [];
  assert.equal(bareCalls.length, 0, `found ${bareCalls.length} bare signOut() call(s)`);
});

test('profile-recovery cleanup is local to the current browser session', async () => {
  const text = await source();
  const localCalls = text.match(/supabase\.auth\.signOut\(\{\s*scope:\s*["']local["']\s*\}\)/g) || [];
  assert.ok(localCalls.length >= 3, `expected at least 3 local signOut calls, found ${localCalls.length}`);
});
