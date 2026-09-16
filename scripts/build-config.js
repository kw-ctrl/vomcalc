/**
 * Generate public/js/config.js from the environment at build time.
 *
 * Why this exists: the Supabase URL + anon key used to be hardcoded in the committed
 * config.js. When the project was replaced, the browser kept talking to the dead one
 * while the server-side code had already moved on — sign-in failed with "Failed to fetch"
 * long after the backend was fixed. Generating the file from env makes that impossible.
 *
 * The anon key is a PUBLIC value by design (it ships to every browser and is protected by
 * RLS), so writing it into a static file is fine. Falls back to the committed values when
 * the env vars are absent (e.g. a local static preview) so the build never breaks.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const target = path.join(root, 'public', 'js', 'config.js');

function readExisting() {
  try {
    const src = fs.readFileSync(target, 'utf8');
    return {
      url: (src.match(/SUPABASE_URL\s*=\s*'([^']*)'/) || [])[1] || '',
      anon: (src.match(/SUPABASE_ANON_KEY\s*=\s*'([^']*)'/) || [])[1] || '',
    };
  } catch {
    return { url: '', anon: '' };
  }
}

const existing = readExisting();
const url = process.env.SUPABASE_URL || existing.url;
const anon = process.env.SUPABASE_ANON_KEY || existing.anon;

if (!url || !anon) {
  console.error('[build-config] WARNING: no Supabase URL/anon key available — leaving config.js as-is');
  process.exit(0);
}

const contents = `/**
 * Configuration — GENERATED at build time from SUPABASE_URL / SUPABASE_ANON_KEY.
 * Do not hand-edit: scripts/build-config.js overwrites this file on every deploy.
 *
 * The anon key is public by design (it ships to every browser; RLS protects the data).
 * window.__SUPABASE_URL__ / __SUPABASE_ANON_KEY__ can override it for a one-off override.
 */

export const SUPABASE_URL = window.__SUPABASE_URL__ || '${url}';
export const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || '${anon}';
export const API_BASE_URL = window.__API_BASE_URL__ || '';
`;

fs.mkdirSync(path.dirname(target), { recursive: true });
const changed = !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== contents;
if (changed) fs.writeFileSync(target, contents);

console.log(`[build-config] config.js ${changed ? 'written' : 'already current'} → ${url.replace(/^https?:\/\//, '').split('.')[0]}`);
