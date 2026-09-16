/**
 * GET /api/health — ops view of the account stack.
 * Used by the keep-alive cron (and by me) to see whether the backend is wired up.
 *
 * Kept deliberately cheap: one count query. A daily hit also stops the Supabase
 * project from going dormant, which is what deleted the previous project.
 */
import { SB_URL, sb, configured, gateEnabled } from './_shared/access.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const out = {
    ok: true,
    app: 'vomcalc',
    at: new Date().toISOString(),
    supabaseConfigured: configured(),
    supabaseHost: SB_URL ? new URL(SB_URL).host : null,
    gateEnabled: gateEnabled(),
    stripe: (() => {
      const k = process.env.STRIPE_SECRET_KEY || '';
      if (!k) return 'missing';
      if (/^sk_live_/.test(k)) return 'live';
      if (/^sk_test_/.test(k)) return 'test';
      return 'invalid';
    })(),
    prices: {
      monthly: Boolean(process.env.STRIPE_MONTHLY_PRICE_ID),
      annual: Boolean(process.env.STRIPE_ANNUAL_PRICE_ID),
    },
    webhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    adminToken: Boolean(process.env.ADMIN_TOKEN),
    db: 'not-configured',
  };

  if (configured()) {
    const r = await sb('/rest/v1/subscribers?select=email&limit=1', {
      headers: { Prefer: 'count=exact' },
    });
    out.db = r.ok ? 'ok' : 'unreachable';
    if (!r.ok) out.dbError = r.error || `status ${r.status}`;
  }

  return res.status(200).json(out);
}
