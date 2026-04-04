/**
 * Auth — browser Supabase client for magic-link exchange, backend APIs for app auth state
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE_URL } from './config.js';

let client = null;
const API_REQUEST_TIMEOUT_MS = 15000;

function getClient() {
    if (!client) {
        client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                flowType: 'implicit',
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true,
            },
        });
    }
    return client;
}

function getApiBaseUrl() {
    return API_BASE_URL ? API_BASE_URL.replace(/\/$/, '') : '';
}

function buildApiUrl(path) {
    return `${getApiBaseUrl()}${path}`;
}

async function parseJsonResponse(response, fallbackError) {
    let payload = null;

    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        throw new Error(payload?.error || fallbackError);
    }

    return payload;
}

async function fetchWithSession(path, options = {}, fallbackError) {
    const session = await getBrowserSession();
    if (!session?.access_token) {
        throw new Error('No active session');
    }

    const headers = {
        ...(options.headers || {}),
        Authorization: `Bearer ${session.access_token}`,
    };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(buildApiUrl(path), {
            ...options,
            headers,
            signal: controller.signal,
        });

        // Backend not deployed — fail silently instead of breaking the UI
        if (response.status === 404 || response.status === 405) {
            return null;
        }

        return parseJsonResponse(response, fallbackError);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('Request timed out. Please try again.');
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

function normalizeAuthState(payload) {
    if (!payload?.subscription) return payload;

    const subscription = { ...payload.subscription };
    if (subscription.trialEndsAt) {
        subscription.trialEndsAt = new Date(subscription.trialEndsAt);
    }
    if (subscription.periodEnd) {
        subscription.periodEnd = new Date(subscription.periodEnd);
    }

    return { ...payload, subscription };
}

export async function getBrowserSession() {
    const { data } = await getClient().auth.getSession();
    return data?.session || null;
}

function getHashParams() {
    const hash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash;

    return new URLSearchParams(hash);
}

export async function consumeAuthRedirectSession() {
    const client = getClient();
    const searchParams = new URLSearchParams(window.location.search);
    const hashParams = getHashParams();

    const code = searchParams.get('code');
    if (code) {
        const { data, error } = await client.auth.exchangeCodeForSession(code);
        if (error) throw error;
        return data?.session || null;
    }

    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    if (accessToken && refreshToken) {
        const { data, error } = await client.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
        });
        if (error) throw error;
        return data?.session || null;
    }

    return getBrowserSession();
}

export async function signInWithEmail(email, password) {
    if (password) {
        // Email + password sign in
        const { error } = await getClient().auth.signInWithPassword({ email, password });
        return { error };
    }
    // Fallback: magic link (if no password provided)
    const { error } = await getClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    return { error };
}

export async function signUpWithEmail(email, password) {
    const { error } = await getClient().auth.signUp({ email, password });
    return { error };
}

export async function syncServerSession(session) {
    return getAuthState(session);
}

export async function getAuthState(sessionOverride = null) {
    const session = sessionOverride || await getBrowserSession();
    if (!session?.access_token) {
        return { user: null, subscription: { status: 'anonymous' } };
    }
    // Free tier — all authenticated users get full access
    return {
        user: session.user || null,
        subscription: { status: 'active' },
    };
}

export async function resetPasswordForEmail(email) {
    const { error } = await getClient().auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
    });
    return { error };
}

export async function updateUserPassword(password) {
    const { error } = await getClient().auth.updateUser({ password });
    return { error };
}

export async function signOut() {
    const authClient = getClient();
    try {
        await authClient.auth.signOut({ scope: 'local' });
        return;
    } catch {
        // Best-effort; continue with local cleanup.
    }

    try {
        const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
        localStorage.removeItem(`sb-${projectRef}-auth-token`);
        localStorage.removeItem(`sb-${projectRef}-auth-token-code-verifier`);
        sessionStorage.removeItem(`sb-${projectRef}-auth-token`);
        sessionStorage.removeItem(`sb-${projectRef}-auth-token-code-verifier`);
    } catch {
        // Ignore localStorage issues (e.g., disabled storage).
    }
}

export function onAuthStateChange(callback) {
    return getClient().auth.onAuthStateChange(callback);
}

export async function saveReport(report) {
    return fetchWithSession('/reports', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(report),
    }, 'Unable to save report');
}

export async function listReports() {
    return fetchWithSession('/reports', {}, 'Unable to load reports');
}

export async function getReport(reportId) {
    return fetchWithSession(`/reports/${reportId}`, {}, 'Unable to load report');
}

export async function getBillingSummary() {
    return fetchWithSession('/billing/summary', {}, 'Unable to load subscription details');
}

export async function changeSubscriptionPlan(plan) {
    return fetchWithSession('/billing/change-plan', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plan }),
    }, 'Unable to update subscription');
}

export async function cancelSubscription() {
    return fetchWithSession('/billing/cancel', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    }, 'Unable to cancel subscription');
}

export async function createBillingPortalSession() {
    return fetchWithSession('/billing/portal', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
    }, 'Unable to open billing portal');
}
