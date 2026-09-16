/**
 * POST /api/billing/portal — Stripe billing portal (update card, cancel, invoices).
 */
import { bearer, getUser, ensureAccount, configured, json, preflight } from '../_shared/access.js';
import { stripeReady, stripePost } from '../_shared/stripe.js';

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  if (preflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!configured() || !stripeReady()) return json(res, 503, { error: 'Billing is not switched on yet.' });

  const user = await getUser(bearer(req));
  if (!user) return json(res, 401, { error: 'Sign in first.' });

  const account = await ensureAccount(user.id, user.email);
  if (!account?.stripe_customer_id) return json(res, 400, { error: 'No subscription on this account.' });

  const origin = req.headers.origin || `https://${req.headers.host || 'www.vomcalc.com'}`;
  const { ok, data } = await stripePost('/billing_portal/sessions', {
    customer: account.stripe_customer_id,
    return_url: `${origin}/app`,
  });
  if (!ok || !data?.url) return json(res, 502, { error: data?.error?.message || 'Could not open billing.' });
  return json(res, 200, { url: data.url });
}
