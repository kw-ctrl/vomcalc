/**
 * POST /api/members/auth   { code } or { email }  -> sets the member cookie
 * GET  /api/members/auth                          -> who am I (or nobody)
 * DELETE /api/members/auth                        -> sign out
 *
 * The browser never decides access; it only holds the signed cookie this route issues.
 */
import {
  configured, checkCode, checkEmail, issueToken, clearCookieHeader, cookieHeader, memberFrom, jsonCors,
} from '../_shared/members.js';

export default async function handler(req, res) {
  jsonCors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return res.status(200).end();
  }

  if (!configured()) {
    return res.status(503).json({
      error: 'member_gate_unconfigured',
      message: 'Member access is not switched on for this deployment.',
    });
  }

  if (req.method === 'GET') {
    const member = memberFrom(req);
    return res.status(200).json({
      signedIn: Boolean(member),
      member: member ? { email: member.email, via: member.via, label: member.label } : null,
    });
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookieHeader());
    return res.status(200).json({ signedIn: false });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const code = String(body.code || '').trim();
  const email = String(body.email || '').trim().toLowerCase();

  if (!code && !email) {
    return res.status(400).json({ error: 'missing_credential', message: 'Enter your access code or member email.' });
  }

  if (code) {
    if (!checkCode(code)) {
      await new Promise((r) => setTimeout(r, 400)); // slow down guessing
      return res.status(401).json({
        error: 'bad_code',
        message: 'That code is not valid. Codes are case-sensitive — copy it exactly as it was posted in the community.',
      });
    }
    const token = issueToken({ via: 'code', label: 'EV community code' });
    res.setHeader('Set-Cookie', cookieHeader(token));
    return res.status(200).json({ signedIn: true, member: { email: null, via: 'code', label: 'EV community code' } });
  }

  if (await checkEmail(email)) {
    const token = issueToken({ email, via: 'email', label: 'EV member' });
    res.setHeader('Set-Cookie', cookieHeader(token));
    return res.status(200).json({ signedIn: true, member: { email, via: 'email', label: 'EV member' } });
  }

  await new Promise((r) => setTimeout(r, 400));
  return res.status(401).json({
    error: 'not_on_list',
    message: "That email isn't on the member list yet. Use your access code, or ask Kassidy to add it.",
  });
}
