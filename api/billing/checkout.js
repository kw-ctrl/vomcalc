/**
 * POST /api/billing/checkout   { plan: 'monthly' | 'annual', returnUrl }
 * Creates a Stripe Checkout Session for the signed-in user.
 */
import {
  bearer, getUser, ensureAccount, configured, logEvent, json, preflight, sb,
} from '../_shared/access.js';
import { stripeReady, stripePost, priceIdFor, isLiveMode } from '../_shared/stripe.js';

export const config = { maxDuration: 20 };

export default async function handler(req, res) {
  if (preflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (!configured()) return json(res, 503, { error: 'Accounts are not switched on yet.' });
  if (!stripeReady()) return json(res, 503, { error: 'Billing is not switched on yet.' });

  const user = await getUser(bearer(req));
  if (!user) return json(res, 401, { error: 'Sign in first.' });

  const plan = req.body?.plan === 'annual' ? 'annual' : 'monthly';
  const priceId = priceIdFor(plan);
  if (!priceId) return json(res, 503, { error: `No Stripe price configured for the ${plan} plan.` });

  const origin = req.headers.origin || `https://${req.headers.host || 'www.vomcalc.com'}`;
  const returnUrl = String(req.body?.returnUrl || `${origin}/app`);
  const account = await ensureAccount(user.id, user.email);

  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: `${origin}/app?checkout=success`,
    cancel_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}checkout=cancelled`,
    client_reference_id: user.id,
    'metadata[user_id]': user.id,
    'subscription_data[metadata][user_id]': user.id,
    allow_promotion_codes: true,
  };
  if (user.email) params.customer_email = user.email;
  if (account?.stripe_customer_id) {
    params.customer = account.stripe_customer_id;
    delete params.customer_email;
  }

  const { ok, data } = await stripePost('/checkout/sessions', params);
  if (!ok || !data?.url) {
    return json(res, 502, { error: data?.error?.message || 'Could not start checkout.' });
  }

  await logEvent('checkout_started', { userId: user.id, email: user.email, props: { plan, session: data.id, live: isLiveMode() } });

  // Keep the customer link on the account so subscription webhooks can find the user.
  if (data.customer) {
    await sb(`/rest/v1/accounts?user_id=eq.${user.id}`, {
      method: 'PATCH',
      body: { stripe_customer_id: data.customer, updated_at: new Date().toISOString() },
    });
  }

  return json(res, 200, { url: data.url, sessionId: data.id });
}
