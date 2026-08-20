import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createCheckoutDatabase } from './db.ts';
import { handleRequest } from './handler.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const allowedOrigins = new Set([
  'https://lorenz-web-six.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(Deno.env.get('CHECKOUT_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean),
]);

const timeoutCandidate = Number(Deno.env.get('CHECKOUT_ROUTER_TIMEOUT_MS') ?? '5000');
const routerTimeoutMs = Number.isFinite(timeoutCandidate) && timeoutCandidate >= 100 && timeoutCandidate <= 30_000
  ? timeoutCandidate
  : 5_000;

const database = createCheckoutDatabase(serviceClient);

Deno.serve((request) => handleRequest(request, {
  database,
  allowedOrigins,
  routerOptions: {
    baseUrl: Deno.env.get('CHECKOUT_ROUTER_BASE_URL')?.trim() || 'https://router.project-osrm.org',
    timeoutMs: routerTimeoutMs,
  },
  logger: (entry) => console.info(JSON.stringify(entry)),
}));
