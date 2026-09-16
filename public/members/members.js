/* Shared member-area runtime: sign-in state, gated fetches, small render helpers. */

const $ = (sel) => document.querySelector(sel);

async function authState() {
  const r = await fetch('/api/members/auth', { credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}

async function signIn(payload) {
  const r = await fetch('/api/members/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, ...data };
}

async function signOut() {
  await fetch('/api/members/auth', { method: 'DELETE', credentials: 'same-origin' });
  location.reload();
}

/** Fetch member-only JSON. Throws {code:'locked'} when the gate is closed. */
async function memberGet(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (r.status === 401 || r.status === 403) {
    const err = new Error('locked');
    err.code = 'locked';
    throw err;
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = new Error(data.message || `Request failed (${r.status})`);
    err.code = 'error';
    throw err;
  }
  return r.json();
}

function header(active) {
  const nav = [
    ['Courses', '/members/'],
    ['Resources', '/members/resources.html'],
    ['Partners & affiliates', '/members/affiliates.html'],
  ];
  return `<header class="ev"><div class="wrap bar">
    <a class="brand" href="/members/">
      <span class="mark">EV</span>
      <span>Escape Velocity<small>Member area</small></span>
    </a>
    <nav class="ev">
      ${nav.map(([label, href]) => `<a href="${href}" class="${active === label ? 'on' : ''}">${label}</a>`).join('')}
      <span class="who" id="who"></span>
      <a href="#" id="signout" style="display:none">Sign out</a>
    </nav>
  </div></header>`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wire the gate: shows #gate when locked, calls onReady() when unlocked. */
async function withGate(onReady, { gateSelector = '#gate', contentSelector = '#content' } = {}) {
  $('body').insertAdjacentHTML('afterbegin', header(document.body.dataset.nav || ''));
  // Pages only carry the content markup; the gate is injected so it stays identical everywhere.
  if (!document.querySelector(gateSelector)) {
    const mount = document.querySelector(contentSelector) || document.body;
    mount.insertAdjacentHTML('beforebegin', gateBlock());
  }
  const state = await authState();

  const who = $('#who');
  const out = $('#signout');
  if (state.signedIn && state.member) {
    who.textContent = state.member.email || state.member.label || 'member';
    out.style.display = '';
    out.addEventListener('click', (e) => { e.preventDefault(); signOut(); });
  }

  if (state.status === 503) {
    $(gateSelector).innerHTML = `<div class="card"><h3>Member area not switched on</h3>
      <p class="muted">This deployment is missing the <code>VOM_MEMBER_SECRET</code> environment variable, so
      members cannot be verified yet. Nothing is exposed in the meantime.</p></div>`;
    $(gateSelector).classList.remove('hidden');
    return;
  }

  if (state.signedIn) {
    $(gateSelector).classList.add('hidden');
    $(contentSelector).classList.remove('hidden');
    await onReady(state.member);
    return;
  }

  $(contentSelector).classList.add('hidden');
  $(gateSelector).classList.remove('hidden');
  wireGateForm(onReady);
}

function wireGateForm(onReady) {
  const form = $('#gateform');
  if (!form) return;
  const msg = $('#gatem');
  const btn = $('#gatebtn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = ($('#code') || {}).value || '';
    const email = ($('#email') || {}).value || '';
    if (!code.trim() && !email.trim()) {
      msg.className = 'msg err';
      msg.textContent = 'Enter your access code, or the email Kassidy has on file.';
      return;
    }
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Checking…';
    const res = await signIn(code.trim() ? { code } : { email });
    btn.disabled = false;
    if (res.signedIn) {
      msg.className = 'msg ok';
      msg.textContent = 'You’re in.';
      location.reload();
      return;
    }
    msg.className = 'msg err';
    msg.textContent = res.message || 'That didn’t work.';
  });
}

function gateBlock() {
  return `<div id="gate" class="gate hidden">
    <span class="pill">Members only</span>
    <h1 style="margin-top:12px">Escape Velocity member area</h1>
    <p class="lede">Courses, resources and partner deals. Not public, not indexed — sign in to continue.</p>
    <div class="card">
      <form id="gateform">
        <label class="muted" for="code">Access code</label>
        <input id="code" autocomplete="off" placeholder="Paste the community code" />
        <label class="muted" for="email">…or your member email</label>
        <input id="email" type="email" autocomplete="email" placeholder="you@email.com" />
        <button class="btn" id="gatebtn" type="submit" style="width:100%;margin-top:6px">Unlock</button>
      </form>
      <div class="msg" id="gatem"></div>
    </div>
    <p class="muted">Codes are posted inside the community. Lost yours? Ask Kassidy — he can add your email instead.</p>
  </div>`;
}
