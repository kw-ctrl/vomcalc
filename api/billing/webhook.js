/**
 * POST /api/billing/webhook — Stripe → account state.
 * Signature is verified against the raw body; unverified calls are rejected.
 *
 * Two products land here and they are NOT the same thing:
 *   • VomCalc subscription ($20/mo, $150/yr) — a TOOL subscription. Grants level `paid`,
 *     which ends when the subscription does.
 *   • Escape Velocity membership — a COMMUNITY membership. Grants level `ev_member`, which
 *     is permanent and unlocks the courses, the resource library and the partner directory.
 * The discriminator is `metadata.tier = 'ev'` on the checkout session (and the EV price id as
 * a backstop), never the amount — an amount comparison breaks the first time a discount,
 * currency or price change is introduced.
 */
import { sb, configured, logEvent, json } from '../_shared/access.js';
import { verifyWebhook, readRawBody, stripePost } from '../_shared/stripe.js';

// Stripe signs the exact bytes — do not let anything parse the body first.
export const config = { api: { bodyParser: false }, maxDuration: 20 };

const EV_PRICE_ID = process.env.STRIPE_EV_PRICE_ID || '';

/** Is this checkout/subscription an Escape Velocity purchase? */
function isEv(obj) {
  const tier = String(obj?.metadata?.tier || obj?.metadata?.product || '').toLowerCase();
  if (tier === 'ev' || tier === 'ev_member' || tier === 'escape-velocity' || tier === 'escape_velocity') return true;
  if (!EV_PRICE_ID) return false;
  return (obj?.items?.data || []).some((i) => i?.price?.id === EV_PRICE_ID);
}

/**
 * Grant Escape Velocity. Writes BOTH places on purpose:
 *
 *   • `ev_member_emails` is the durable grant. Someone who buys from a payment link may not
 *     have an account yet (or may sign up later with the same email) — the allowlist is what
 *     makes `effective_access()` return ev_member the moment they sign in, with no second step.
 *   • `accounts.base_level` covers the buyer who is already signed in.
 *
 * Idempotent: Stripe retries, and this gets replayed.
 */
async function grantEv({ userId, email, source }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean && !userId) return false;

  if (clean) {
    const r = await sb('/rest/v1/ev_member_emails', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { email: clean, note: source || 'stripe' },
    });
    if (!r.ok) throw new Error(`EV allowlist write failed: ${r.status} ${JSON.stringify(r.data)}`);
  }

  if (userId) {
    const a = await sb(`/rest/v1/accounts?user_id=eq.${userId}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { base_level: 'ev_member', updated_at: new Date().toISOString() },
    });
    if (!a.ok) throw new Error(`EV account grant failed: ${a.status} ${JSON.stringify(a.data)}`);
  }

  return true;
}

/**
 * Write subscription state onto the user's access record.
 *
 * A PATCH alone is not enough: if the user paid before their access row existed (payment
 * link, a dropped signup call, a webhook that arrives first) there is nothing to update and
 * the update silently affects zero rows — a paying customer with no access. So: patch, and
 * if nothing matched, insert.
 */
async function upsertAccount(userId, patch) {
  if (!userId) return false;

  // Normalise the email OUTSIDE the spread: a subscription event often has no email, and
  // spreading a null over the column's NOT NULL constraint silently kills the insert —
  // leaving a paying customer with no access while the webhook still reports success.
  const email = String(patch.email || '').toLowerCase();
  const body = { ...patch, email, updated_at: new Date().toISOString() };

  const r = await sb(`/rest/v1/accounts?user_id=eq.${userId}`, {
    method: 'PATCH', prefer: 'return=representation', body,
  });
  if (r.ok && Array.isArray(r.data) && r.data.length > 0) return true;

  const ins = await sb('/rest/v1/accounts', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: { user_id: userId, ...body },
  });
  if (!ins.ok) {
    throw new Error(`account upsert failed: ${ins.status} ${JSON.stringify(ins.data)}`);
  }
  return true;
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
  // Returns null when an event cannot be tied to an account (no metadata, unknown customer).
  // Callers must not treat that as success-with-nothing-to-do silently.
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
        const email = obj.customer_details?.email || obj.customer_email || obj.metadata?.email || null;
        const userId = await findUserIdFor({
          userId: obj.client_reference_id || obj.metadata?.user_id,
          customerId: obj.customer,
          email,
        });

        // ── Escape Velocity is a membership, not a tool subscription ────────────
        // This runs BEFORE the `if (!userId) break` guard below, and that ordering is the
        // whole point: someone buying from a Stripe payment link usually has no account in
        // our database yet, so the guard would hand a paying member nothing at all and the
        // webhook would still report success.
        if (isEv(obj)) {
          await grantEv({ userId, email, source: `stripe:${obj.id || 'checkout'}` });
          if (userId) {
            await upsertAccount(userId, {
              email,
              stripe_customer_id: obj.customer || null,
              stripe_subscription_id: obj.subscription || null,
              subscription_status: 'active',
              plan: 'ev',
            });
          }
          await logEvent('ev_activated', {
            userId, email,
            props: { session: obj.id, mode: obj.mode, amountTotal: obj.amount_total },
          });
          break;
        }

        if (!userId) break;

        // Pull the subscription so we store a real status + period end.
        let sub = null;
        if (obj.subscription) {
          const r = await stripePost(`/subscriptions/${obj.subscription}`, {});
          sub = r.ok ? r.data : null;
        }
        await upsertAccount(userId, {
          email: obj.customer_details?.email || obj.customer_email || obj.metadata?.email || null,
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
        await upsertAccount(userId, {
          email: obj.metadata?.email || null,
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
        await upsertAccount(userId, {
          email: obj.customer_email || null,
          subscription_status: 'past_due',
        });
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
