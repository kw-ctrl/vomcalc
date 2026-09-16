/**
 * Minimal Stripe helpers — plain fetch + node:crypto, no SDK dependency.
 */
import crypto from 'node:crypto';

const API = 'https://api.stripe.com/v1';

export function stripeKey() {
  return process.env.STRIPE_SECRET_KEY || '';
}

export function stripeReady() {
  const k = stripeKey();
  return Boolean(k && /^sk_(test|live)_/.test(k));
}

export function isLiveMode() {
  return /^sk_live_/.test(stripeKey());
}

/** Form-encoded POST (Stripe's expected shape). Nested keys use bracket notation. */
export async function stripePost(path, params = {}) {
  const body = new URLSearchParams();
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    } else {
      body.append(key, String(value));
    }
  };
  for (const [k, v] of Object.entries(params)) add(k, v);

  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export function priceIdFor(plan) {
  const map = {
    monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
    annual: process.env.STRIPE_ANNUAL_PRICE_ID,
  };
  return map[plan] || '';
}

/**
 * Verify a Stripe webhook signature.
 * signed_payload = "<timestamp>.<raw body>", HMAC-SHA256 with the endpoint secret.
 * Returns { ok, reason }.
 */
export function verifyWebhook(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  if (!sigHeader || !rawBody) return { ok: false, reason: 'missing signature or body' };

  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=').map((s) => s.trim())).filter((p) => p.length === 2)
  );
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!timestamp || !provided) return { ok: false, reason: 'malformed signature header' };

  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'signature mismatch' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/** Read the exact bytes Stripe signed. Works whether or not a body parser ran. */
export async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}
