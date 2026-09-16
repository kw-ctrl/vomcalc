/**
 * GET /api/members/resources -> the member resource library and the partner directory.
 *
 * Member-only. Every link here is a real destination (Drive folders/files that already
 * exist, or live tool URLs) — no placeholders, no invented codes.
 */
import { requireMember } from '../_shared/members.js';
import { resources, partners, affiliatePrograms } from '../_shared/library.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const member = requireMember(req, res);
  if (!member) return;

  return res.status(200).json({ resources, partners, affiliatePrograms });
}
