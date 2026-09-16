#!/usr/bin/env node
/**
 * Live test of the Stripe → entitlements chain, run against PRODUCTION with signed
 * webhook events. No Stripe key needed and no money involved: we sign the payloads
 * ourselves with the webhook secret the deployment already holds, so this exercises the
 * real handler, the real database and the real access rules.
 *
 * Verifies the revenue-critical transitions:
 *   active subscription  -> paid (full report suite)
 *   past_due             -> loses premium (a failed card must not keep the product)
 *   canceled past period -> loses access at period end
 *   tampered / unsigned  -> rejected
 *
 * Usage: node scripts/webhook-live-test.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const APP = process.env.APP_URL || 'https://www.vomcalc.com';

function envFrom(file, key) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.startsWith(key + '=')) {
        let v = line.slice(key.length + 1);
        const quoted = v.startsWith('"') && v.trimEnd().endsWith('"');
        if (quoted) v = v.trim().slice(1, -1);
        // dotenv escapes: a stored "\n" is a real newline in the runtime value.
        v = v.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        return quoted ? v : v.trim();
      }
    }
  } catch { /* ignore */ }
  return null;
}

const HOME = process.env.HOME;
const SB = envFrom(`${HOME}/.hermes/vomcalc_env`, 'SUPABASE_URL');
const SERVICE = envFrom(`${HOME}/.hermes/vomcalc_env`, 'SUPABASE_SERVICE_ROLE_KEY');
const WH_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ||
  envFrom(`${process.cwd()}/.env.local`, 'STRIPE_WEBHOOK_SECRET');

if (!SB || !SERVICE) { console.error('✗ missing Supabase creds in ~/.hermes/vomcalc_env'); process.exit(1); }
if (!WH_SECRET) { console.error('✗ missing STRIPE_WEBHOOK_SECRET'); process.exit(1); }

let pass = 0, fail = 0;
const ok  = (m) => { console.log(`  ✓ ${m}`); pass++; };
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };
const check = (label, actual, expected) =>
  actual === expected ? ok(`${label} (${actual})`) : bad(`${label} — expected ${expected}, got ${actual}`);

const sbHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const db = (path) => fetch(`${SB}${path}`, { headers: sbHeaders }).then(r => r.json());

function sign(payload, secret = WH_SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
}

async function postEvent(payload, { secret, tamper = false } = {}) {
  const { body, header } = sign(payload, secret);
  const res = await fetch(`${APP}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: tamper ? body.replace('"active"', '"active_tampered"') : body,
  });
  let data = null; try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

const TS = Date.now();
const EMAIL = `seven-wh-test-${TS}@kassidywarren.com`;
const CUSTOMER = `cus_seventest${TS}`;
const SUB = `sub_seventest${TS}`;

console.log(`\nTarget: ${APP}\nSecret: ${WH_SECRET.slice(0, 14)}…\n`);

// ── setup: a real auth user ──────────────────────────────────────────────────
const created = await fetch(`${SB}/auth/v1/admin/users`, {
  method: 'POST', headers: sbHeaders,
  body: JSON.stringify({ email: EMAIL, password: `Wh-${TS}!aB`, email_confirm: true }),
}).then(r => r.json());
const USER_ID = created.id;
if (!USER_ID) { console.error('✗ could not create the test user:', created); process.exit(1); }

const level = async () => {
  const r = await fetch(`${SB}/rest/v1/rpc/effective_access`, {
    method: 'POST', headers: sbHeaders, body: JSON.stringify({ p_user_id: USER_ID }),
  }).then(x => x.json());
  const row = Array.isArray(r) ? r[0] : r;
  return row?.level;
};
const account = async () => (await db(`/rest/v1/accounts?user_id=eq.${USER_ID}&select=*`))?.[0] || {};

console.log('Baseline');
check('new user starts on the free tier', await level(), 'free');

// ── 1. active subscription grants paid ──────────────────────────────────────
console.log('\nActive subscription');
const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
const r1 = await postEvent({
  id: 'evt_test_active', type: 'customer.subscription.updated',
  data: { object: {
    id: SUB, customer: CUSTOMER, status: 'active',
    current_period_end: periodEnd, metadata: { user_id: USER_ID },
    items: { data: [{ price: { recurring: { interval: 'month' } } }] },
  } },
});
check('webhook accepted', r1.status, 200);
check('reports received:true', r1.data?.received, true);
check('level is now paid', await level(), 'paid');
const a1 = await account();
check('subscription status stored', a1.subscription_status, 'active');
check('plan stored as monthly', a1.plan, 'monthly');
check('period end stored', new Date(a1.current_period_end).getTime() > Date.now(), true);

// ── 2. a failed card must remove premium ────────────────────────────────────
console.log('\nFailed payment (past_due)');
const r2 = await postEvent({
  id: 'evt_test_failed', type: 'invoice.payment_failed',
  data: { object: { customer: CUSTOMER, customer_email: EMAIL } },
});
check('webhook accepted', r2.status, 200);
check('status now past_due', (await account()).subscription_status, 'past_due');
const lvl2 = await level();
check('past_due loses premium', lvl2 === 'paid' ? 'still paid' : 'not premium', 'not premium');

// ── 3. canceled, period over → no access ────────────────────────────────────
console.log('\nCanceled subscription');
const pastEnd = Math.floor(Date.now() / 1000) - 86400;
const r3 = await postEvent({
  id: 'evt_test_cancel', type: 'customer.subscription.deleted',
  data: { object: {
    id: SUB, customer: CUSTOMER, status: 'canceled',
    current_period_end: pastEnd, metadata: { user_id: USER_ID },
    items: { data: [{ price: { recurring: { interval: 'month' } } }] },
  } },
});
check('webhook accepted', r3.status, 200);
const lvl3 = await level();
check('canceled past period is not premium', lvl3 === 'paid' ? 'still paid' : 'not premium', 'not premium');

// ── 4. forgery is rejected ──────────────────────────────────────────────────
console.log('\nForgery / replay');
const r4 = await postEvent({ id: 'evt_tamper', type: 'customer.subscription.updated', data: { object: { customer: CUSTOMER, status: 'active', metadata: { user_id: USER_ID } } } }, { tamper: true });
check('tampered body rejected', r4.status, 400);
const r5 = await postEvent({ id: 'evt_wrong_secret', type: 'customer.subscription.updated', data: { object: { customer: CUSTOMER } } }, { secret: 'whsec_attacker' });
check('wrong secret rejected', r5.status, 400);
const stale = await postEvent({ id: 'evt_stale', type: 'customer.subscription.updated', data: { object: { customer: CUSTOMER } } });
check('freshly signed call accepted (control)', stale.status, 200);
const staleSigned = (() => {
  const body = JSON.stringify({ id: 'evt_old', type: 'customer.subscription.updated', data: { object: {} } });
  const t = Math.floor(Date.now() / 1000) - 7200;
  const sig = crypto.createHmac('sha256', WH_SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
  return { body, header: `t=${t},v1=${sig}` };
})();
const replay = await fetch(`${APP}/api/billing/webhook`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': staleSigned.header }, body: staleSigned.body,
});
check('2-hour-old signature rejected (replay)', replay.status, 400);

// ── cleanup ─────────────────────────────────────────────────────────────────
console.log('\nCleanup');
await fetch(`${SB}/auth/v1/admin/users/${USER_ID}`, { method: 'DELETE', headers: sbHeaders });
await fetch(`${SB}/rest/v1/subscribers?email=eq.${encodeURIComponent(EMAIL)}`, { method: 'DELETE', headers: sbHeaders });
const left = await db(`/rest/v1/accounts?user_id=eq.${USER_ID}&select=user_id`);
check('test account removed', Array.isArray(left) ? left.length : -1, 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
