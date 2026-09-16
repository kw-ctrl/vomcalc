/**
 * POST /api/billing/webhook — Stripe → account state.
 * Signature is verified against the raw body; unverified calls are rejected.
 */
import { sb, configured, logEvent, json } from '../_shared/access.js';
import { verifyWebhook, readRawBody, stripePost } from '../_shared/stripe.js';

// Stripe signs the exact bytes — do not let anything parse the body first.
export const config = { api: { bodyParser: false }, maxDuration: 20 };

async function patchAccount(where, patch) {
  const r = await sb(`/rest/v1/accounts?${where}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } });
  return r.ok;
}

function planFromSubscription(sub) {
  const interval = sub?.items?.data?.[0]?.price?.recurring?.interval;
  if (interval === 'year') return 'annual';
  if (interval === 'month') return 'monthly';
  return null;
}

function periodEnd(sub) {
  // Newer Stripe API versions moved this onto the item; support both.
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

async function findUserIdFor({ userId, customerId, email }) {
  if (userId) return userId;
  if (customerId) {
    const r = await sb(`/rest/v1/accounts?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id`);
    if (Array.isArray(r.data) && r.data[0]?.user_id) return r.data[0].user_id;
  }
  if (email) {
    const r = await sb(`/rest/v1/accounts?email=eq.${encodeURIComponent(email.toLowerCase())}&select=user_id`);
    if (Array.isArray(r.data) && r.data[0]?.user_id) return r.data[0].user_id;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  if (!configured()) return json(res, 503, { error: 'not configured' });

  const raw = await readRawBody(req);
  const check = verifyWebhook(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  if (!check.ok) return json(res, 400, { error: `Invalid signature: ${check.reason}` });

  let event;
  try { event = JSON.parse(raw); } catch { return json(res, 400, { error: 'Invalid JSON' }); }

  const obj = event?.data?.object || {};

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const userId = await findUserIdFor({
          userId: obj.client_reference_id || obj.metadata?.user_id,
          customerId: obj.customer,
          email: obj.customer_details?.email || obj.customer_email,
        });
        if (!userId) break;

        // Pull the subscription so we store a real status + period end.
        let sub = null;
        if (obj.subscription) {
          const r = await stripePost(`/subscriptions/${obj.subscription}`, {});
          sub = r.ok ? r.data : null;
        }
        await patchAccount(`user_id=eq.${userId}`, {
          stripe_customer_id: obj.customer || null,
          stripe_subscription_id: obj.subscription || null,
          subscription_status: sub?.status || 'active',
          current_period_end: periodEnd(sub),
          plan: planFromSubscription(sub) || obj.metadata?.plan || null,
        });
        await logEvent('subscribed', { userId, email: obj.customer_details?.email, props: { plan: planFromSubscription(sub), session: obj.id } });
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const userId = await findUserIdFor({ userId: obj.metadata?.user_id, customerId: obj.customer });
        if (!userId) break;
        await patchAccount(`user_id=eq.${userId}`, {
          stripe_subscription_id: obj.id,
          stripe_customer_id: obj.customer || null,
          subscription_status: obj.status,
          current_period_end: periodEnd(obj),
          plan: planFromSubscription(obj),
        });
        break;
      }

      case 'invoice.payment_failed': {
        const userId = await findUserIdFor({ customerId: obj.customer, email: obj.customer_email });
        if (!userId) break;
        await patchAccount(`user_id=eq.${userId}`, { subscription_status: 'past_due' });
        break;
      }

      default:
        break;
    }
  } catch (err) {
    // Return 500 so Stripe retries; never silently drop a subscription event.
    return json(res, 500, { error: `Handler failed: ${err.message}` });
  }

  return json(res, 200, { received: true });
}
