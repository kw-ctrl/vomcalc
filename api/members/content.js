/**
 * GET /api/members/content            -> the course catalogue (id, title, blurb, counts)
 * GET /api/members/content?course=tax -> every module and lesson for that course
 *
 * Member-only. The course data is bundled into the function (NOT in public/), so an
 * unauthenticated visitor cannot reach it by guessing a URL.
 */
import { requireMember } from '../_shared/members.js';
import courses, { catalogue } from '../_shared/courses/index.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const member = requireMember(req, res);
  if (!member) return;

  const id = String(req.query?.course || '').trim();

  if (!id) {
    return res.status(200).json({ courses: catalogue() });
  }

  const course = courses[id];
  if (!course) {
    return res.status(404).json({ error: 'no_such_course', message: `No course called "${id}".` });
  }

  return res.status(200).json({ course });
}
