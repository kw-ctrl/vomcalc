/**
 * Access-rule tests. Two halves:
 *   1. Pure JS — Stripe webhook signature verification, client entitlement logic.
 *   2. SQL — the access functions, run against a real Postgres (see run.sh).
 *
 * Usage:  node supabase/tests/access.test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhook } from '../../lib/stripe.js';

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failed++; results.push(`  ✗ ${name}\n      ${e.message}`); }
}

// ── Stripe webhook signature ────────────────────────────────────────────────
const SECRET = 'whsec_test_secret_value';
function sign(payload, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex');
  return `t=${t},v1=${sig}`;
}

console.log('\nStripe webhook signature');
test('accepts a correctly signed payload', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  assert.equal(verifyWebhook(body, sign(body), SECRET).ok, true);
});
test('rejects a tampered body', () => {
  const body = JSON.stringify({ id: 'evt_1', amount: 100 });
  const header = sign(body);
  const tampered = JSON.stringify({ id: 'evt_1', amount: 999999 });
  assert.equal(verifyWebhook(tampered, header, SECRET).ok, false);
});
test('rejects a wrong secret', () => {
  const body = '{"a":1}';
  assert.equal(verifyWebhook(body, sign(body, 'whsec_wrong'), SECRET).ok, false);
});
test('rejects a stale timestamp (replay)', () => {
  const body = '{"a":1}';
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal(verifyWebhook(body, sign(body, SECRET, old), SECRET).ok, false);
});
test('rejects a missing signature', () => {
  assert.equal(verifyWebhook('{"a":1}', undefined, SECRET).ok, false);
});
test('rejects everything when no secret is configured', () => {
  assert.equal(verifyWebhook('{"a":1}', 't=1,v1=abc', '').ok, false);
});

// ── Client entitlement logic (mirrors public/js/entitlements.js) ────────────
console.log('\nClient entitlement rules');
const PREMIUM = new Set(['trial', 'paid', 'ev_member']);
const shouldLock = (s) => (s.gateEnabled ? !PREMIUM.has(s.level) : false);

test('gate OFF → nobody is locked (today\'s production behaviour)', () => {
  for (const level of ['anonymous', 'free', 'expired', 'trial', 'paid', 'ev_member']) {
    assert.equal(shouldLock({ gateEnabled: false, level }), false, `level=${level}`);
  }
});
test('gate ON → free and expired are locked, paid/trial/EV are not', () => {
  assert.equal(shouldLock({ gateEnabled: true, level: 'free' }), true);
  assert.equal(shouldLock({ gateEnabled: true, level: 'anonymous' }), true);
  assert.equal(shouldLock({ gateEnabled: true, level: 'expired' }), true);
  assert.equal(shouldLock({ gateEnabled: true, level: 'trial' }), false);
  assert.equal(shouldLock({ gateEnabled: true, level: 'paid' }), false);
  assert.equal(shouldLock({ gateEnabled: true, level: 'ev_member' }), false);
});

// ── SQL access rules (optional — only when DATABASE_URL is provided) ─────────
const DB = process.env.TEST_DATABASE_URL;
if (!DB) {
  console.log('\nSQL access rules  — SKIPPED (set TEST_DATABASE_URL, or run supabase/tests/run.sh)\n');
} else {
  console.log('\nSQL access rules (live Postgres)');
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: DB });
  const q = (text, params) => pool.query(text, params);

  const mkUser = async (email) => {
    const r = await q(`insert into auth.users (email) values ($1) returning id`, [email]);
    return r.rows[0].id;
  };
  const level = async (id) => (await q(`select * from effective_access($1)`, [id])).rows[0];

  await testAsync('unknown user → free', async () => {
    const u = await mkUser('nobody@example.com');
    assert.equal((await level(u)).level, 'free');
  });

  await testAsync('null user → anonymous', async () => {
    assert.equal((await level(null)).level, 'anonymous');
  });

  await testAsync('trial code grants trial with the right expiry', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days, source) values ('YT14', 'trial', 14, 'youtube')`);
    const u = await mkUser('trial@example.com');
    const r = (await q(`select * from redeem_code('YT14', $1, 'trial@example.com')`, [u])).rows[0];
    assert.equal(r.ok, true, r.message);
    const days = (new Date(r.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 13.9 && days <= 14.01, `expected ~14 days, got ${days}`);
    assert.equal((await level(u)).level, 'trial');
  });

  await testAsync('code entry is case/space insensitive', async () => {
    const u = await mkUser('case@example.com');
    const r = (await q(`select * from redeem_code('  yt14  ', $1, 'case@example.com')`, [u])).rows[0];
    assert.equal(r.ok, true, r.message);
  });

  await testAsync('the same account cannot redeem the same code twice', async () => {
    const u = await mkUser('twice@example.com');
    await q(`select * from redeem_code('YT14', $1, 'twice@example.com')`, [u]);
    const r = (await q(`select * from redeem_code('YT14', $1, 'twice@example.com')`, [u])).rows[0];
    assert.equal(r.ok, false);
    assert.match(r.message, /already used/i);
  });

  await testAsync('a second code STACKS onto the remaining trial', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days) values ('EXTRA7', 'trial', 7)`);
    const u = await mkUser('stack@example.com');
    await q(`select * from redeem_code('YT14', $1, null)`, [u]);
    const r = (await q(`select * from redeem_code('EXTRA7', $1, null)`, [u])).rows[0];
    const days = (new Date(r.expires_at) - Date.now()) / 86400000;
    assert.ok(days > 20.9 && days <= 21.01, `expected ~21 days, got ${days}`);
  });

  await testAsync('EV code grants permanent access and is never expiring', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days) values ('ESCAPE-EV', 'ev_member', null)`);
    const u = await mkUser('ev@example.com');
    const r = (await q(`select * from redeem_code('ESCAPE-EV', $1, null)`, [u])).rows[0];
    assert.equal(r.ok, true, r.message);
    const a = await level(u);
    assert.equal(a.level, 'ev_member');
    assert.equal(a.expires_at, null);
  });

  await testAsync('expired trial reports as expired, not free and not trial', async () => {
    const u = await mkUser('lapsed@example.com');
    await q(`insert into accounts (user_id, email, trial_ends_at) values ($1, 'lapsed@example.com', now() - interval '1 day')`, [u]);
    assert.equal((await level(u)).level, 'expired');
  });

  await testAsync('a code past its own expiry date is refused', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days, expires_at) values ('OLDCODE', 'trial', 14, now() - interval '1 hour')`);
    const u = await mkUser('old@example.com');
    const r = (await q(`select * from redeem_code('OLDCODE', $1, null)`, [u])).rows[0];
    assert.equal(r.ok, false);
    assert.match(r.message, /expired/i);
  });

  await testAsync('a deactivated code is refused', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days, active) values ('OFFCODE', 'trial', 14, false)`);
    const u = await mkUser('off@example.com');
    const r = (await q(`select * from redeem_code('OFFCODE', $1, null)`, [u])).rows[0];
    assert.equal(r.ok, false);
    assert.match(r.message, /no longer active/i);
  });

  await testAsync('a fully-claimed code is refused', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days, max_redemptions, redeemed_count) values ('USEDUP', 'trial', 14, 1, 1)`);
    const u = await mkUser('usedup@example.com');
    const r = (await q(`select * from redeem_code('USEDUP', $1, null)`, [u])).rows[0];
    assert.equal(r.ok, false);
    assert.match(r.message, /fully claimed/i);
  });

  await testAsync('CONCURRENCY: a 1-use code is awarded exactly once under parallel redemption', async () => {
    await q(`insert into access_codes (code, grants_level, grants_days, max_redemptions) values ('RACE1', 'trial', 14, 1)`);
    const users = await Promise.all(Array.from({ length: 8 }, (_, i) => mkUser(`race${i}@example.com`)));
    const out = await Promise.all(
      users.map((u) => q(`select * from redeem_code('RACE1', $1, null)`, [u]).then((r) => r.rows[0].ok))
    );
    const wins = out.filter(Boolean).length;
    assert.equal(wins, 1, `expected exactly 1 winner, got ${wins}`);
    const cnt = (await q(`select redeemed_count from access_codes where code = 'RACE1'`)).rows[0].redeemed_count;
    assert.equal(cnt, 1, `redeemed_count drifted to ${cnt}`);
  });

  await testAsync('paid subscription beats an expired trial', async () => {
    const u = await mkUser('paid@example.com');
    await q(`insert into accounts (user_id, email, trial_ends_at, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, plan)
             values ($1, 'paid@example.com', now() - interval '5 days', 'cus_1', 'sub_1', 'active', now() + interval '20 days', 'monthly')`, [u]);
    assert.equal((await level(u)).level, 'paid');
  });

  await testAsync('a canceled subscription does NOT keep access past the paid period', async () => {
    const u = await mkUser('canceled@example.com');
    await q(`insert into accounts (user_id, email, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end)
             values ($1, 'canceled@example.com', 'cus_2', 'sub_2', 'canceled', now() - interval '1 day')`, [u]);
    const lv = (await level(u)).level;
    assert.ok(lv === 'free' || lv === 'expired', `expected free/expired, got ${lv}`);
  });

  await testAsync('an EV allowlist email gets permanent access with no code', async () => {
    const u = await mkUser('listed@example.com');
    await q(`insert into accounts (user_id, email) values ($1, 'listed@example.com')`, [u]);
    await q(`insert into ev_member_emails (email) values ('listed@example.com')`);
    const a = await level(u);
    assert.equal(a.level, 'ev_member');
    assert.equal(a.expires_at, null);
  });

  await pool.end();
}

console.log('\n' + results.join('\n'));
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
