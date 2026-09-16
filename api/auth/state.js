/**
 * GET /api/auth/state
 * Returns what the caller is entitled to. Also the single place where a new
 * account + marketing-list row is created, so every signup is captured once.
 */
import {
  bearer, getUser, resolveAccess, ensureAccount, captureSubscriber,
  pushToVaultCRM, gateEnabled, configured, logEvent, json, preflight, sb,
} from '../../lib/access.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const token = bearer(req);
  const user = await getUser(token);

  if (!user) {
    return json(res, 200, {
      signedIn: false,
      level: 'anonymous',
      reason: 'not signed in',
      expiresAt: null,
      gateEnabled: gateEnabled(),
      backendReady: configured(),
    });
  }

  if (!configured()) {
    // Auth provider not wired up yet — behave like today (free tier), never break the tool.
    return json(res, 200, {
      signedIn: true,
      email: user.email,
      level: 'free',
      reason: 'backend not configured',
      expiresAt: null,
      gateEnabled: gateEnabled(),
      backendReady: false,
    });
  }

  const before = await resolveAccess(user.id);
  const account = await ensureAccount(user.id, user.email);

  // First time we've seen this email → add to the marketing list exactly once.
  // (Checked against `subscribers`, not the account row, so it is idempotent across
  //  repeat calls and safe if the account row was created by a code redemption.)
  const email = (user.email || '').toLowerCase();
  if (email) {
    const seen = await sb(`/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=email`);
    const isNewSubscriber = seen.ok && Array.isArray(seen.data) && seen.data.length === 0;
    if (isNewSubscriber) {
      await captureSubscriber(email, { source: req.query?.source || 'vom-signup' });
      await pushToVaultCRM(email, 'vom-signup');
      await logEvent('signup', { userId: user.id, email, props: { source: req.query?.source || 'vom-signup' } });
    } else {
      await captureSubscriber(email, { source: req.query?.source || 'vom-signup' }); // refreshes last_seen_at
    }
  }

  const access = await resolveAccess(user.id);

  return json(res, 200, {
    signedIn: true,
    email: user.email,
    userId: user.id,
    level: access.level,
    reason: access.reason,
    expiresAt: access.expiresAt,
    gateEnabled: gateEnabled(),
    backendReady: true,
    trialCode: account?.trial_code || null,
    subscriptionStatus: account?.subscription_status || null,
    plan: account?.plan || null,
    previousLevel: before.level,
  });
}
