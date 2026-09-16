/**
 * Entitlements — the client's view of what this visitor may see.
 *
 * The decision is made on the SERVER (/api/auth/state → effective_access() in Postgres);
 * this module only caches it and applies the UI. Nothing here can grant access.
 *
 * Levels: anonymous | free | trial | paid | ev_member | expired
 * Premium (full report suite): trial, paid, ev_member
 */
import { API_BASE_URL } from './config.js';

const PREMIUM = new Set(['trial', 'paid', 'ev_member']);

let state = {
  signedIn: false,
  level: 'anonymous',
  reason: '',
  expiresAt: null,
  gateEnabled: false,   // server flag: when false the tool is free for everyone
  backendReady: false,
  googleEnabled: false, // social login actually configured on the project
  email: null,
};

const listeners = new Set();

export function getAccess() { return { ...state }; }
export function isSignedIn() { return !!state.signedIn; }
export function isPremium() { return PREMIUM.has(state.level); }
export function gateEnabled() { return !!state.gateEnabled; }
export function backendReady() { return !!state.backendReady; }
export function googleEnabled() { return !!state.googleEnabled; }

/** Should premium sections be locked right now? */
export function shouldLock() {
  if (!state.gateEnabled) return false;      // free-for-all mode (current production behaviour)
  return !isPremium();
}

export function daysLeft() {
  if (!state.expiresAt) return null;
  const ms = new Date(state.expiresAt).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86400000);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() { for (const fn of listeners) { try { fn(getAccess()); } catch { /* listener errors must not break the page */ } } }

function apiBase() {
  return API_BASE_URL ? API_BASE_URL.replace(/\/$/, '') : '';
}

async function authed(path, options = {}) {
  const mod = await import('./auth.js');
  const session = await mod.getBrowserSession().catch(() => null);
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  const res = await fetch(`${apiBase()}${path}`, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

export async function refreshAccess({ source } = {}) {
  try {
    const q = source ? `?source=${encodeURIComponent(source)}` : '';
    const { ok, data } = await authed(`/api/auth/state${q}`);
    if (!ok || !data) throw new Error('state unavailable');
    state = { ...state, ...data };
  } catch {
    // Backend unreachable → behave exactly like today: free, no gating, no error UI.
    state = { ...state, signedIn: false, level: 'anonymous', gateEnabled: false, backendReady: false };
  }
  emit();
  return getAccess();
}

export async function redeemCode(code) {
  const { ok, data } = await authed('/api/codes/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!ok || !data) return { ok: false, message: 'Could not check that code right now.' };
  if (data.ok) await refreshAccess();
  return data;
}

export async function startCheckout(plan) {
  const { ok, data } = await authed('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ plan, returnUrl: window.location.href }),
  });
  if (ok && data?.url) { window.location.href = data.url; return { ok: true }; }
  return { ok: false, message: data?.error || 'Could not start checkout.' };
}

export async function openBillingPortal() {
  const { ok, data } = await authed('/api/billing/portal', { method: 'POST', body: '{}' });
  if (ok && data?.url) { window.location.href = data.url; return { ok: true }; }
  return { ok: false, message: data?.error || 'Could not open billing.' };
}

/** Human-readable badge for the header. */
export function badge() {
  const d = daysLeft();
  switch (state.level) {
    case 'ev_member': return { text: 'EV Member · Free Forever', tone: 'gold' };
    case 'paid': return { text: 'Subscribed', tone: 'green' };
    case 'trial': return { text: d != null ? `Free trial · ${d}d left` : 'Free trial', tone: 'blue' };
    case 'expired': return { text: 'Free period ended', tone: 'amber' };
    case 'free': return state.signedIn ? { text: 'Free', tone: 'neutral' } : { text: 'Free Access', tone: 'green' };
    default: return { text: 'Free Access', tone: 'green' };
  }
}
