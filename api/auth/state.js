/**
 * GET /api/auth/state
 * Returns what the caller is entitled to. Also the single place where a new
 * account + marketing-list row is created, so every signup is captured once.
 */
import {
  bearer, getUser, resolveAccess, ensureAccount, captureSubscriber,
  pushToVaultCRM, gateEnabled, configured, logEvent, json, preflight, sb,
} from '../_shared/access.js';

/**
 * Which social logins are switched on for this project. Supabase exposes it publicly
 * (/auth/v1/settings), so the UI can show a Google button the moment the provider is
 * enabled and never show a dead one. Cached briefly: it changes only when we configure it.
 */
let providersCache = { at: 0, google: false };
async function externalProviders() {
  if (Date.now() - providersCache.at < 60_000) return providersCache;
  const r = await sb('/auth/v1/settings', { key: process.env.SUPABASE_ANON_KEY || undefined });
  const google = Boolean(r.data?.external?.google);
  providersCache = { at: Date.now(), google };
  return providersCache;
}

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const token = bearer(req);
  const user = await getUser(token);

  if (!user) {
    const providers = configured() ? await externalProviders() : { google: false };
    return json(res, 200, {
      signedIn: false,
      level: 'anonymous',
      reason: 'not signed in',
      expiresAt: null,
      gateEnabled: gateEnabled(),
      backendReady: configured(),
      googleEnabled: providers.google,
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
    googleEnabled: (await externalProviders()).google,
    trialCode: account?.trial_code || null,
    subscriptionStatus: account?.subscription_status || null,
    plan: account?.plan || null,
    previousLevel: before.level,
  });
}
