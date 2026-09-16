/**
 * POST /api/codes/redeem   { code }
 *
 * Codes are handed out on YouTube / IG DMs (a trial) or in the EV community
 * (permanent access). The grant is applied by the redeem_code() DB function so
 * concurrent redemptions can't exceed a code's cap and the rules can't drift.
 */
import {
  bearer, getUser, rpc, resolveAccess, configured, logEvent, json, preflight,
} from '../../lib/access.js';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  if (preflight(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  if (!configured()) {
    return json(res, 503, { error: 'Accounts are not switched on yet.' });
  }

  const user = await getUser(bearer(req));
  if (!user) return json(res, 401, { error: 'Sign in first, then enter your code.' });

  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return json(res, 400, { error: 'Enter a code.' });
  if (code.length > 64) return json(res, 400, { error: 'That code is not valid.' });

  const r = await rpc('redeem_code', {
    p_code: code,
    p_user_id: user.id,
    p_email: user.email || null,
  });

  if (!r.ok) {
    return json(res, 503, { error: 'Could not check that code right now. Try again in a moment.' });
  }

  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!row?.ok) return json(res, 200, { ok: false, message: row?.message || 'That code did not work.' });

  const access = await resolveAccess(user.id);
  await logEvent('code_redeemed', {
    userId: user.id,
    email: user.email,
    props: { code, level: access.level, expiresAt: access.expiresAt },
  });

  return json(res, 200, {
    ok: true,
    message: row.message,
    level: access.level,
    expiresAt: access.expiresAt,
  });
}
