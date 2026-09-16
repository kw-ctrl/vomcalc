/**
 * Member gate for the internal EV community area (courses, resources, partners).
 *
 * Design:
 *  - Access is proved by a signed, HttpOnly cookie set by /api/members/auth.
 *  - Two ways in: a private community CODE, or an email on the allowlist.
 *  - The secret lives in env (VOM_MEMBER_SECRET). No secret -> the gate FAILS CLOSED
 *    (503), never open. A missing env var must never expose member content.
 *  - If Supabase is configured, the email route also checks public.ev_member_emails,
 *    so the existing vault allowlist works without duplicating it here.
 *
 * Nothing in here is trustable from the client: the cookie is signed server-side and
 * the payload only ever says WHO, never WHAT they may see.
 */
import crypto from 'node:crypto';
import { sb, configured as dbConfigured } from './access.js';

export const COOKIE_NAME = 'vom_member';
const MAX_AGE_DAYS = 180;

function secret() {
  return process.env.VOM_MEMBER_SECRET || '';
}

/** The gate needs a secret to work at all. Without one, deny everything. */
export function configured() {
  return secret().length >= 16;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify a cookie value. Returns the payload, or null. Constant-time signature check. */
export function verify(token) {
  if (!token || !configured()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  } catch { return null; }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const raw = req.headers?.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** The member behind this request, or null. */
export function memberFrom(req) {
  return verify(parseCookies(req)[COOKIE_NAME]);
}

export function cookieHeader(token) {
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function issueToken({ email = null, via = 'code', label = null }) {
  return sign({
    email,
    via,
    label,
    exp: Date.now() + MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  });
}

function list(envName) {
  return String(process.env[envName] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Private community codes. Case-insensitive on the way in, exact after that. */
export function checkCode(input) {
  const code = String(input || '').trim();
  if (!code) return false;
  const wanted = list('VOM_MEMBER_CODES');
  const a = Buffer.from(code.toUpperCase());
  for (const candidate of wanted) {
    const b = Buffer.from(candidate.toUpperCase());
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Email allowlist: env var first, then the Supabase allowlist if it is configured. */
export async function checkEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;

  const envList = list('VOM_MEMBER_EMAILS').map((e) => e.toLowerCase());
  // Support "@domain.com" entries for a whole cohort.
  for (const entry of envList) {
    const b = Buffer.from(entry);
    const a = Buffer.from(email);
    if (entry.startsWith('@')) {
      if (email.endsWith(entry)) return true;
    } else if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return true;
    }
  }

  if (dbConfigured()) {
    const r = await sb(`/rest/v1/ev_member_emails?email=eq.${encodeURIComponent(email)}&select=email`);
    if (r.ok && Array.isArray(r.data) && r.data.length) return true;
  }
  return false;
}

/** Guard for API routes. Returns the member payload, or writes the 401 and returns null. */
export function requireMember(req, res) {
  if (!configured()) {
    res.status(503).json({
      error: 'member_gate_unconfigured',
      message: 'The member area is not configured on this deployment (missing VOM_MEMBER_SECRET).',
    });
    return null;
  }
  const member = memberFrom(req);
  if (!member) {
    res.status(401).json({ error: 'not_a_member', message: 'Sign in with your Escape Velocity access code.' });
    return null;
  }
  return member;
}

export function jsonCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}
