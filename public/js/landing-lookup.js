/**
 * The front door: paste a Zillow/Redfin link or an address, get real numbers.
 *
 * Shows enough to be genuinely useful (a real revenue estimate, the range, and the
 * actual operating listings behind it) and stops short of the full underwriting —
 * that's what the account is for. Every number here comes from /api/lookup, which is
 * backed by real operating data; nothing on this path is estimated by us.
 */
const API = '/api/lookup';

const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
const moneyShort = (n) => (n == null ? '—' : '$' + Math.round(n / 1000) + 'K');
const pct = (n) => (n == null ? '—' : n + '%');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setBusy(busy, label) {
  const btn = document.getElementById('lookupBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? (label || 'Checking real listings…') : 'Get My Numbers';
}

function showError(msg, needsAddress) {
  const box = document.getElementById('lookupError');
  document.getElementById('lookupResult').hidden = true;
  box.hidden = false;
  box.innerHTML = esc(msg) + (needsAddress ? '' : '');
  if (needsAddress) {
    // Keep the flow alive: point them at the input rather than dead-ending.
    document.getElementById('lookupInput').focus();
  }
}

function render(data) {
  const e = data.estimate || {};
  const s = (data.comps && data.comps.stats) || {};
  const sample = (data.comps && data.comps.sample) || [];
  const range = e.revenueRange || {};

  const compRows = sample.slice(0, 4).map((c) => {
    const nm = c.name ? esc(c.name.length > 42 ? c.name.slice(0, 42) + '…' : c.name) : (c.bedrooms ? `${c.bedrooms}-bed listing` : 'Listing');
    const label = c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener nofollow">${nm}</a>` : nm;
    return `<div class="lookup-comp">
        <span class="nm">${label}${c.superhost ? ' <span title="Superhost" aria-label="Superhost">★</span>' : ''}</span>
        <span class="fig">${money(c.revenue)} <span>rev · ${money(c.adr)} ADR</span></span>
      </div>`;
  }).join('');

  const compsLine = s.count
    ? `<div class="lookup-comps">
         <div class="lookup-comps-h">Actual listings earning nearby (trailing 12 months)</div>
         ${compRows}
       </div>`
    : '';

  const crossCheck = data.crossCheck
    ? `<div class="lookup-src">Cross-checked with a second source: ${money(data.crossCheck.annualRevenue)} · ${money(data.crossCheck.adr)} ADR.</div>`
    : '';

  document.getElementById('lookupResult').innerHTML = `
    <div class="lookup-addr"><span class="dot"></span>${esc(data.address)}${data.cached ? ' · instant from cache' : ''}</div>
    <div class="lookup-big-label">Estimated annual revenue</div>
    <div class="lookup-big">${money(e.annualRevenue)}</div>
    <div class="lookup-range">Most nearby homes land between <b>${moneyShort(range.p25)}</b> and <b>${moneyShort(range.p75)}</b>${range.p90 ? ` · top performers reach <b>${moneyShort(range.p90)}</b>` : ''}</div>
    <div class="lookup-stats">
      <div class="lookup-stat"><div class="k">Avg nightly rate</div><div class="v">${money(e.adr)}</div></div>
      <div class="lookup-stat"><div class="k">Occupancy</div><div class="v">${pct(e.occupancy)}</div></div>
      <div class="lookup-stat"><div class="k">Listings analyzed</div><div class="v">${s.count || e.compsAnalyzed || 0}</div></div>
    </div>
    ${compsLine}
    ${crossCheck}
    <div class="lookup-cta">
      <div class="lookup-cta-line">That's the revenue side. The full report scores the deal, finds the price it actually works at, and shows the three moves that fix it.</div>
      <form class="lookup-email" id="lookupEmail">
        <input type="email" id="lookupEmailInput" placeholder="you@email.com" autocomplete="email">
        <button type="submit">Email it to me + unlock the calculator</button>
      </form>
      <div class="lookup-src" id="lookupEmailNote"></div>
    </div>`;
  document.getElementById('lookupResult').hidden = false;
  document.getElementById('lookupError').hidden = true;

  // Email capture — the list is the point, so make it one tap and then hand off to the app.
  const form = document.getElementById('lookupEmail');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = document.getElementById('lookupEmailInput').value.trim();
    const note = document.getElementById('lookupEmailNote');
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) { note.textContent = 'Enter a valid email address.'; return; }
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch('/api/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'vom-lookup', utm: { address: data.addressKey || '' } }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not save that.');
      form.outerHTML = '<div class="lookup-done">Saved. Opening the full calculator with this property loaded…</div>';
      setTimeout(() => { window.location.href = '/app?address=' + encodeURIComponent(data.address || ''); }, 700);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Email it to me + unlock the calculator';
      note.textContent = err.message;
    }
  });
}

async function lookup(query) {
  const q = String(query || '').trim();
  if (q.length < 5) { showError('Paste a listing link or type an address to start.'); return; }
  setBusy(true);
  document.getElementById('lookupError').hidden = true;
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { showError(data.error || 'Something went wrong. Try again in a moment.', data.needsAddress); return; }
    render(data);
    // Let the rest of the page know something happened (analytics, no-op today).
    document.dispatchEvent(new CustomEvent('vom:lookup', { detail: { addressKey: data.addressKey } }));
  } catch {
    showError('Could not reach the server. Check your connection and try again.');
  } finally {
    setBusy(false);
  }
}

const form = document.getElementById('lookupForm');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookup(document.getElementById('lookupInput').value);
  });
}

// If someone arrives with an address already in the URL (?address=…), run it straight away —
// that's how the app hands a property back to the landing page.
const preset = new URLSearchParams(window.location.search).get('address');
if (preset) {
  document.getElementById('lookupInput').value = preset;
  lookup(preset);
}

export { lookup };
