/**
 * /api/admin/codes — mint and inspect access codes.
 *
 * Auth: header  x-admin-token: <ADMIN_TOKEN>   (or ?token=)
 *
 *   GET  ?list=1                → every code with redemption counts
 *   POST { code, grantsLevel, grantsDays, source, campaign, maxRedemptions, expiresAt }
 *   POST { batch: 25, prefix: 'YT', grantsDays: 14, source: 'youtube' }  → bulk single-use codes
 *
 * Batch codes are single-use by construction (maxRedemptions = 1), which is what you
 * want for DM'd one-offs; a shared creator code is just one row with a high cap.
 */
import { sb, configured, json } from '../_shared/access.js';

export const config = { maxDuration: 20 };

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — readable when typed from a video

function randomChunk(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

function authorised(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = req.headers['x-admin-token'] || req.query?.token;
  return typeof provided === 'string' && provided.length === expected.length && provided === expected;
}

export default async function handler(req, res) {
  if (!authorised(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!configured()) return json(res, 503, { error: 'Accounts are not switched on yet.' });

  if (req.method === 'GET') {
    const r = await sb('/rest/v1/access_codes?select=*&order=created_at.desc&limit=500');
    if (!r.ok) return json(res, 502, { error: 'Could not read codes' });
    return json(res, 200, { codes: r.data });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  const body = req.body || {};

  // ── Bulk single-use batch ────────────────────────────────────────────────
  if (body.batch) {
    const count = Math.min(Math.max(parseInt(body.batch, 10) || 0, 1), 500);
    const prefix = String(body.prefix || 'VOM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VOM';
    const grantsDays = parseInt(body.grantsDays, 10) || 14;
    const rows = [];
    const used = new Set();
    while (rows.length < count) {
      const code = `${prefix}-${randomChunk(4)}-${randomChunk(4)}`;
      if (used.has(code)) continue;
      used.add(code);
      rows.push({
        code,
        grants_level: 'trial',
        grants_days: grantsDays,
        source: body.source || 'youtube',
        campaign: body.campaign || null,
        max_redemptions: 1,
        expires_at: body.expiresAt || null,
      });
    }
    const r = await sb('/rest/v1/access_codes', {
      method: 'POST',
      prefer: 'return=representation',
      body: rows,
    });
    if (!r.ok) return json(res, 502, { error: 'Could not create codes', detail: r.data });
    return json(res, 201, { created: r.data?.length || 0, codes: r.data });
  }

  // ── Single code (shared creator code, or the EV permanent code) ──────────
  const code = String(body.code || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!code) return json(res, 400, { error: 'code required' });

  const grantsLevel = body.grantsLevel === 'ev_member' ? 'ev_member' : 'trial';
  const grantsDays = grantsLevel === 'ev_member' ? null : (parseInt(body.grantsDays, 10) || 14);

  const r = await sb('/rest/v1/access_codes', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: {
      code,
      grants_level: grantsLevel,
      grants_days: grantsDays,
      source: body.source || 'manual',
      campaign: body.campaign || null,
      max_redemptions: body.maxRedemptions === undefined ? null : body.maxRedemptions,
      expires_at: body.expiresAt || null,
      active: body.active !== false,
    },
  });
  if (!r.ok) return json(res, 502, { error: 'Could not create code', detail: r.data });
  return json(res, 201, { code: Array.isArray(r.data) ? r.data[0] : r.data });
}
