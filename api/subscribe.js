/**
 * POST /api/subscribe   { email, source? }
 *
 * Public email capture. Called from the signup form so an address lands on the
 * marketing list at the moment someone types it — not only when they finish
 * confirming. Writes to `subscribers` and mirrors to Kassidy's vault CRM.
 *
 * Deliberately no auth: the whole point is to capture before an account exists.
 * Guarded with a format check, length caps and a light per-instance rate limit.
 */
import { captureSubscriber, pushToVaultCRM, logEvent, configured, json, preflight, sb } from './_shared/access.js';

export const config = { maxDuration: 15 };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const hits = new Map();          // per-instance only; enough to stop casual abuse

function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const max = 6;
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();   // bound memory on a long-lived instance
  return recent.length > max;
}

export default async function handler(req, res) {
  if (preflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!configured()) return json(res, 503, { error: 'Email capture is not switched on yet.' });

  const raw = String(req.body?.email || '').trim().toLowerCase();
  if (!raw || raw.length > 254 || !EMAIL_RE.test(raw)) {
    return json(res, 400, { error: 'Enter a valid email address.' });
  }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return json(res, 429, { error: 'Too many attempts — try again in a minute.' });

  const source = String(req.body?.source || 'vom-signup').slice(0, 40);

  const existing = await sb(`/rest/v1/subscribers?email=eq.${encodeURIComponent(raw)}&select=email`);
  const isNew = existing.ok && Array.isArray(existing.data) && existing.data.length === 0;

  await captureSubscriber(raw, { source, utm: req.body?.utm || {} });
  if (isNew) {
    await pushToVaultCRM(raw, source);
    await logEvent('email_captured', { email: raw, props: { source, ip: ip.slice(0, 45) } });
  }

  // Always report success — never tell a caller whether an address was already known.
  return json(res, 200, { ok: true });
}
