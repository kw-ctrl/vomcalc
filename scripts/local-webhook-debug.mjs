#!/usr/bin/env node
/**
 * Run the REAL webhook handler locally against the REAL database, with console output
 * visible. The handler is invoked directly with a synthetic request, so anything it logs
 * or returns is right here instead of buried in deployment logs.
 *
 * Usage: node scripts/local-webhook-debug.mjs
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
if (!SB || !SERVICE || !SECRET) { console.error('missing creds'); process.exit(1); }

// The handler reads these at import time.
process.env.SUPABASE_URL = SB;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
process.env.SUPABASE_SERVICE_KEY = SERVICE;
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

const { default: handler } = await import('../api/billing/webhook.js');

const sbHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const db = (p) => fetch(`${SB}${p}`, { headers: sbHeaders }).then(r => r.json());

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

async function invoke(payload, { sign = true } = {}) {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', ...(sign ? { 'stripe-signature': `t=${t},v1=${sig}` } : {}) };
  const res = mockRes();
  await handler(req, res);
  return res.out;
}

const TS = Date.now();
const EMAIL = `seven-dbg-${TS}@kassidywarren.com`;
const USER = await fetch(`${SB}/auth/v1/admin/users`, {
  method: 'POST', headers: sbHeaders,
  body: JSON.stringify({ email: EMAIL, password: `Dbg-${TS}!aB`, email_confirm: true }),
}).then(r => r.json());
const USER_ID = USER.id;
console.log('test user:', USER_ID, EMAIL);

console.log('\n--- firing customer.subscription.updated (active) ---');
const out = await invoke({
  id: `evt_dbg_${TS}`, type: 'customer.subscription.updated',
  data: { object: {
    id: `sub_dbg_${TS}`, customer: `cus_dbg_${TS}`, status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    metadata: { user_id: USER_ID, email: EMAIL },
    items: { data: [{ price: { recurring: { interval: 'month' } } }] },
  } },
});
console.log('handler response:', out.statusCode, JSON.stringify(out.body));

const acct = await db(`/rest/v1/accounts?user_id=eq.${USER_ID}&select=*`);
console.log('\naccounts row:', JSON.stringify(acct, null, 2));
const lvl = await fetch(`${SB}/rest/v1/rpc/effective_access`, {
  method: 'POST', headers: sbHeaders, body: JSON.stringify({ p_user_id: USER_ID }),
}).then(r => r.json());
console.log('effective_access:', JSON.stringify(lvl));

console.log('\n--- direct insert probe (bypassing the handler) ---');
const ins = await fetch(`${SB}/rest/v1/accounts`, {
  method: 'POST', headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify({ user_id: USER_ID, email: EMAIL, subscription_status: 'active' }),
});
console.log('insert status:', ins.status, (await ins.text()).slice(0, 300));

console.log('\n--- cleanup ---');
await fetch(`${SB}/auth/v1/admin/users/${USER_ID}`, { method: 'DELETE', headers: sbHeaders });
await fetch(`${SB}/rest/v1/subscribers?email=eq.${encodeURIComponent(EMAIL)}`, { method: 'DELETE', headers: sbHeaders });
console.log('done');
