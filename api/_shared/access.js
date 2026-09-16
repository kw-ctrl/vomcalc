/**
 * Shared server-side helpers for the VomCalc API.
 *
 * Everything here runs in Vercel serverless functions. Config comes from env vars
 * so a project/key swap needs no code change:
 *
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
 *   STRIPE_SECRET_KEY, STRIPE_MONTHLY_PRICE_ID, STRIPE_ANNUAL_PRICE_ID, STRIPE_WEBHOOK_SECRET
 *   ADMIN_TOKEN            — guards /api/admin/*
 *   VOM_GATE_ENABLED       — "true" turns the paid gate on; anything else = free access
 */

export const SB_URL = process.env.SUPABASE_URL || '';
export const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
export const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

/** The paid gate is opt-in. Until it is switched on, the tool behaves exactly as it
 *  does today (everything free) while accounts / emails / codes still accumulate. */
export function gateEnabled() {
  return String(process.env.VOM_GATE_ENABLED || '').toLowerCase() === 'true';
}

export function configured() {
  return Boolean(SB_URL && SERVICE_KEY && !/localhost/i.test(SB_URL));
}

/** Raw call against the Supabase REST/auth API using the service role.
 *  Never throws: an unreachable backend comes back as { ok: false } so callers can
 *  degrade to free-tier behaviour instead of 500-ing the whole request. */
export async function sb(path, { method = 'GET', body, key = SERVICE_KEY, token, headers = {}, prefer } = {}) {
  try {
    const res = await fetch(`${SB_URL}${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token || key}`,
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err?.message || err) };
  }
}

/** Call an RPC (the access functions live in the DB so the rules can't drift). */
export async function rpc(fn, args) {
  return sb(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
}

function decodeJWT(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch { return null; }
}

/** Resolve the caller from a bearer token. Decodes locally first (fast, no round-trip),
 *  then confirms against the auth server when the local claims look expired. */
export async function getUser(token) {
  if (!token) return null;
  const claims = decodeJWT(token);
  const notExpired = claims?.exp ? claims.exp * 1000 > Date.now() : true;
  if (claims?.sub && notExpired) return { id: claims.sub, email: claims.email || null };

  const { ok, data } = await sb('/auth/v1/user', { token });
  if (ok && data?.id) return { id: data.id, email: data.email || null };
  return null;
}

export function bearer(req) {
  return (req.headers.authorization || '').replace('Bearer ', '').trim();
}

/** Add/refresh a row in the marketing list. Never throws — capture must not block a signup. */
export async function captureSubscriber(email, { source = 'vom-signup', utm = {} } = {}) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  try {
    const r = await sb('/rest/v1/subscribers', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { email: clean, source, utm, last_seen_at: new Date().toISOString() },
    });
    return r.data;
  } catch { return null; }
}

/** Mirror the address into Kassidy's existing CRM so the list is never trapped here. */
export async function pushToVaultCRM(email, source = 'vom-calculator') {
  if (!email) return false;
  try {
    const res = await fetch('https://vault.kassidywarren.com/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: String(email).trim().toLowerCase(),
        source,
        utm_source: 'vom-calculator',
        utm_medium: 'tool',
        utm_campaign: 'vom-calc-signup',
      }),
    });
    return res.ok;
  } catch { return false; }
}

/** Make sure an access row exists for this auth user. */
export async function ensureAccount(userId, email) {
  if (!userId) return null;
  const existing = await sb(`/rest/v1/accounts?user_id=eq.${userId}&select=*`);
  if (existing.ok && Array.isArray(existing.data) && existing.data.length) return existing.data[0];
  await sb('/rest/v1/accounts', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: { user_id: userId, email: String(email || '').toLowerCase(), updated_at: new Date().toISOString() },
  });
  const created = await sb(`/rest/v1/accounts?user_id=eq.${userId}&select=*`);
  return Array.isArray(created.data) ? created.data[0] || null : null;
}

/** The single source of truth for what this user may see. */
export async function resolveAccess(userId) {
  if (!userId) return { level: 'anonymous', reason: 'not signed in', expiresAt: null };
  const r = await rpc('effective_access', { p_user_id: userId });
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!r.ok || !row) return { level: 'free', reason: 'free tier', expiresAt: null };
  return { level: row.level, reason: row.reason, expiresAt: row.expires_at };
}

export async function logEvent(name, { userId = null, email = null, props = {} } = {}) {
  try {
    await sb('/rest/v1/events', { method: 'POST', body: { user_id: userId, email, name, props } });
  } catch { /* analytics must never break a request */ }
}

export function json(res, status, payload) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res.status(status).json(payload);
}

export function preflight(req, res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return true; }
  return false;
}

/** True when the level unlocks the full report suite. */
export function isPremiumLevel(level) {
  return level === 'paid' || level === 'trial' || level === 'ev_member';
}
