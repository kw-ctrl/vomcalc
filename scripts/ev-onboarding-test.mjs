#!/usr/bin/env node
/**
 * Escape Velocity onboarding — the Stripe → access chain, tested locally against the
 * REAL database by invoking the REAL webhook handler.
 *
 * Why this exists separately from webhook-live-test.mjs: that suite hits the deployed
 * handler, so it can only test what is already shipped. This one imports the handler
 * directly, so the EV grant path can be proven before it goes anywhere near production.
 *
 * The case that matters most is the payment-link buyer: they have NO account in our
 * database when they pay, so the grant cannot hang off a user id. It has to be durable by
 * email, or a paying member gets nothing and nobody finds out until they complain.
 *
 * Usage: node scripts/ev-onboarding-test.mjs
 */
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';

const HOME = process.env.HOME;
function envFrom(file, key) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith(key + '=')) {
        let v = line.slice(key.length + 1);
        const quoted = v.startsWith('"') && v.trimEnd().endsWith('"');
        if (quoted) v = v.trim().slice(1, -1);
        v = v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        return quoted ? v : v.trim();
      }
    }
  } catch { /* ignore */ }
  return null;
}

const SB = envFrom(`${HOME}/.hermes/vomcalc_env`, 'SUPABASE_URL');
const SERVICE = envFrom(`${HOME}/.hermes/vomcalc_env`, 'SUPABASE_SERVICE_ROLE_KEY');
const SECRET = envFrom(`${process.cwd()}/.env.local`, 'STRIPE_WEBHOOK_SECRET');
if (!SB || !SERVICE || !SECRET) {
  console.error('✗ missing Supabase creds (~/.hermes/vomcalc_env) or STRIPE_WEBHOOK_SECRET (.env.local)');
  process.exit(1);
}

// The handler reads these at import time.
process.env.SUPABASE_URL = SB;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
process.env.SUPABASE_SERVICE_KEY = SERVICE;
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const { default: handler } = await import('../api/billing/webhook.js');

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const check = (label, actual, expected) =>
  actual === expected ? ok(`${label} (${actual})`) : bad(`${label} — expected ${expected}, got ${actual}`);

const sbHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const db = (p) => fetch(`${SB}${p}`, { headers: sbHeaders }).then((r) => r.json());

function mockRes() {
  const out = { statusCode: null, body: null };
  return {
    out,
    setHeader() {},
    status(c) { out.statusCode = c; return this; },
    json(payload) { out.body = payload; return this; },
    end() { return this; },
  };
}

async function invoke(payload) {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` };
  const res = mockRes();
  await handler(req, res);
  return res.out;
}

const levelOf = (id) =>
  fetch(`${SB}/rest/v1/rpc/effective_access`, {
    method: 'POST', headers: sbHeaders, body: JSON.stringify({ p_user_id: id }),
  }).then((r) => r.json()).then((r) => (Array.isArray(r) ? r[0] : r)?.level);

const TS = Date.now();
const EMAIL = `seven-ev-${TS}@kassidywarren.com`;
const CUSTOMER = `cus_evtest${TS}`;

const evCheckout = (id) => ({
  id: 'evt_ev_test', type: 'checkout.session.completed',
  data: { object: {
    id, mode: 'payment', amount_total: 800000,
    customer: CUSTOMER, customer_email: EMAIL,
    customer_details: { email: EMAIL },
    metadata: { tier: 'ev' },
  } },
});

console.log(`\nEscape Velocity onboarding — against ${SB}\n`);

// ── 1. the payment-link buyer: no account exists yet ────────────────────────
console.log('Payment-link buyer (no account in our database)');
const r1 = await invoke(evCheckout(`cs_ev_${TS}`));
check('handler accepted the event', r1.statusCode, 200);
const allow = await db(`/rest/v1/ev_member_emails?email=eq.${encodeURIComponent(EMAIL)}&select=email,note`);
check('buyer is on the EV allowlist', Array.isArray(allow) && allow.length === 1, true);
check('the grant records where it came from', String(allow?.[0]?.note || '').startsWith('stripe:'), true);

// ── 2. they sign up later with the email they paid with ─────────────────────
console.log('\nBuyer signs up afterwards');
const user = await fetch(`${SB}/auth/v1/admin/users`, {
  method: 'POST', headers: sbHeaders,
  body: JSON.stringify({ email: EMAIL, password: `Ev-${TS}!aB`, email_confirm: true }),
}).then((r) => r.json());
const USER_ID = user.id;
check('account created', Boolean(USER_ID), true);
check('level is ev_member on first sign-in', await levelOf(USER_ID), 'ev_member');

// ── 3. Stripe retries — replayed events must be harmless ────────────────────
console.log('\nReplay (Stripe retries)');
const r2 = await invoke(evCheckout(`cs_ev_${TS}`));
check('replayed event accepted', r2.statusCode, 200);
const allow2 = await db(`/rest/v1/ev_member_emails?email=eq.${encodeURIComponent(EMAIL)}&select=email`);
check('no duplicate grant', Array.isArray(allow2) && allow2.length === 1, true);
check('still ev_member', await levelOf(USER_ID), 'ev_member');

// ── 4. a VomCalc tool subscription must NOT be mistaken for EV ──────────────
console.log('\nControl: a $20 tool subscription is not an EV purchase');
const TOOL_EMAIL = `seven-tool-${TS}@kassidywarren.com`;
const toolUser = await fetch(`${SB}/auth/v1/admin/users`, {
  method: 'POST', headers: sbHeaders,
  body: JSON.stringify({ email: TOOL_EMAIL, password: `Tl-${TS}!aB`, email_confirm: true }),
}).then((r) => r.json());
const r3 = await invoke({
  id: 'evt_tool_test', type: 'checkout.session.completed',
  data: { object: {
    id: `cs_tool_${TS}`, mode: 'subscription', subscription: `sub_tool${TS}`,
    customer: `cus_tool${TS}`, customer_details: { email: TOOL_EMAIL },
    metadata: { user_id: toolUser.id },
  } },
});
check('handler accepted the event', r3.statusCode, 200);
const toolAllow = await db(`/rest/v1/ev_member_emails?email=eq.${encodeURIComponent(TOOL_EMAIL)}&select=email`);
check('tool subscriber was NOT put on the EV allowlist', Array.isArray(toolAllow) ? toolAllow.length : -1, 0);
check('tool subscriber still gets paid tier', await levelOf(toolUser.id), 'paid');

// ── cleanup ────────────────────────────────────────────────────────────────
console.log('\nCleanup');
if (USER_ID) await fetch(`${SB}/auth/v1/admin/users/${USER_ID}`, { method: 'DELETE', headers: sbHeaders });
if (toolUser.id) await fetch(`${SB}/auth/v1/admin/users/${toolUser.id}`, { method: 'DELETE', headers: sbHeaders });
await fetch(`${SB}/rest/v1/ev_member_emails?email=eq.${encodeURIComponent(EMAIL)}`, { method: 'DELETE', headers: sbHeaders });
await fetch(`${SB}/rest/v1/accounts?email=eq.${encodeURIComponent(TOOL_EMAIL)}`, { method: 'DELETE', headers: sbHeaders });
const left = await db(`/rest/v1/ev_member_emails?email=eq.${encodeURIComponent(EMAIL)}&select=email`);
check('test grant removed', Array.isArray(left) ? left.length : -1, 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
