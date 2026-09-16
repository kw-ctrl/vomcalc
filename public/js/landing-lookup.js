/**
 * The front door is a router, not a results page.
 *
 * Paste a Zillow / Redfin / Crexi / LoopNet link (or type an address) and you go straight to
 * the underwriting page with that listing already loaded and scored.
 *
 * We do check the link first — one lookup, which also warms the cache so the app's own call is
 * instant. That check exists so a dead link produces a clear message here instead of dumping
 * someone onto a blank calculator. It never shows a summary of its own.
 */
const API = '/api/lookup';

const looksLikeUrl = (v) => /^https?:\/\//i.test(v) || /^(www\.)?[a-z0-9-]+\.(com|net|org|io)\b/i.test(v);

const input = document.getElementById('lookupInput');
const form = document.getElementById('lookupForm');
const btn = document.getElementById('lookupBtn');
const hint = document.getElementById('lookupHint');
const errBox = document.getElementById('lookupError');
const HINT_DEFAULT = hint ? hint.textContent : '';

function fail(msg) {
  if (errBox) { errBox.hidden = false; errBox.textContent = msg; }
  if (hint) hint.textContent = HINT_DEFAULT;
  if (btn) { btn.disabled = false; btn.textContent = 'Underwrite This Listing'; }
  input && input.focus();
}

async function go(query) {
  const q = String(query || '').trim();
  if (q.length < 5) return fail('Paste a listing link or type an address to start.');

  if (errBox) errBox.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
  if (hint) hint.textContent = 'Finding the property and pulling real market data…';

  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const d = await r.json().catch(() => ({}));

    if (!r.ok) return fail(d.error || 'Could not read that listing. Try the address instead.');

    // Hand off to the underwriting page. The link is passed along so the app can pull the
    // asking price and property details; the resolved address drives the market data.
    const params = new URLSearchParams();
    if (looksLikeUrl(q)) params.set('url', q);
    params.set('address', d.address || q);
    params.set('start', '1');            // tells the app to underwrite immediately

    if (hint) hint.textContent = 'Got it — opening the underwriting…';
    window.location.href = '/app?' + params.toString();
  } catch {
    fail('Could not reach the server. Check your connection and try again.');
  }
}

if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go(input && input.value);
  });
}

// ?address=… or ?url=… coming back to the landing page just re-runs the handoff.
const preset = new URLSearchParams(window.location.search).get('address');
if (preset && input) { input.value = preset; go(preset); }

export { go };
