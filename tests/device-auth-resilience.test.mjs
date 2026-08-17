import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel){
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadAuthResilience(){
  const code = read('auth-resilience.js');
  const context = { console, URL, TypeError, globalThis: {} };
  context.window = context.globalThis;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'auth-resilience.js' });
  return context.globalThis.DAGOLDOL_AUTH_RESILIENCE;
}

test('auth resilience module exists and exports the required helpers', async () => {
  const modulePath = path.join(ROOT, 'auth-resilience.js');
  assert.equal(fs.existsSync(modulePath), true, 'auth-resilience.js must exist');
  const mod = loadAuthResilience();
  assert.equal(typeof mod.createResilientSupabaseFetch, 'function');
  assert.equal(typeof mod.describeAuthError, 'function');
  assert.equal(typeof mod.isNetworkAuthError, 'function');
});

test('network failure on Supabase auth falls back to same-origin Vercel proxy', async () => {
  const mod = loadAuthResilience();
  const calls = [];
  const nativeFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://project.supabase.co/auth/v1/')) {
      throw new TypeError('Load failed');
    }
    return { ok: true, url };
  };
  const fetcher = mod.createResilientSupabaseFetch({
    nativeFetch,
    supabaseOrigin: 'https://project.supabase.co',
    proxyPrefix: '/api/supabase'
  });
  const response = await fetcher('https://project.supabase.co/auth/v1/token?grant_type=password', { method: 'POST' });
  assert.equal(response.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/supabase/auth/v1/token?grant_type=password');
});

test('Supabase REST network failure also falls back so profile/account data stays usable', async () => {
  const mod = loadAuthResilience();
  const calls = [];
  const nativeFetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://project.supabase.co/')) throw new TypeError('Load failed');
    return { ok: true, url };
  };
  const fetcher = mod.createResilientSupabaseFetch({ nativeFetch, supabaseOrigin: 'https://project.supabase.co', proxyPrefix: '/api/supabase' });
  const response = await fetcher('https://project.supabase.co/rest/v1/profiles?id=eq.1', { method: 'GET' });
  assert.equal(response.ok, true);
  assert.equal(calls[1].url, '/api/supabase/rest/v1/profiles?id=eq.1');
});

test('unrelated origins are never proxied', async () => {
  const mod = loadAuthResilience();
  const nativeFetch = async () => { throw new TypeError('Load failed'); };
  const fetcher = mod.createResilientSupabaseFetch({ nativeFetch, supabaseOrigin: 'https://project.supabase.co', proxyPrefix: '/api/supabase' });
  await assert.rejects(() => fetcher('https://example.com/data', { method: 'GET' }), /Load failed/);
});

test('auth errors distinguish bad credentials from network failures', async () => {
  const mod = loadAuthResilience();
  assert.match(mod.describeAuthError({ code: 'invalid_credentials', message: 'Invalid login credentials' }, 'login'), /Incorrect email or password/i);
  assert.match(mod.describeAuthError({ name: 'AuthRetryableFetchError', message: 'Load failed', status: 0 }, 'login'), /account service/i);
  assert.match(mod.describeAuthError({ name: 'AuthRetryableFetchError', message: 'Load failed', status: 0 }, 'signup'), /account service/i);
});

test('runtime source uses resilient fetch and never maps network auth errors to invalid credentials', () => {
  const source = read('script.js');
  assert.match(source, /DAGOLDOL_AUTH_RESILIENCE/);
  assert.match(source, /global:\s*\{\s*fetch:/s);
  assert.match(source, /describeAuthError\([^,]+,\s*"login"\)/);
  assert.match(source, /describeAuthError\(error,\s*"signup"\)/);
});

test('Vercel proxies auth fallback to the fixed Supabase project origin', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const rule = vercel.rewrites.find((entry) => entry.source === '/api/supabase/:path*');
  assert.ok(rule, 'missing Supabase fallback proxy rewrite');
  assert.equal(rule.destination, 'https://rvrjkfbenramappteuae.supabase.co/:path*');
});

test('mobile touch focus cannot leave skip link visibly pinned over the iOS status bar', () => {
  const css = read('phase3-fixes.css');
  assert.match(css, /\.skip-link:focus:not\(:focus-visible\)/);
  assert.match(css, /\.skip-link:focus-visible/);
  assert.match(css, /safe-area-inset-top/);
});

test('login failure resets password visibility to hidden', () => {
  const source = read('script.js');
  assert.match(source, /resetPasswordVisibility\(passwordInput\)/);
});
