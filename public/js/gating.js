/**
 * Gating — subscription checks, blur/unlock UI, auth & pricing modals
 */

import {
    cancelSubscription,
    changeSubscriptionPlan,
    consumeAuthRedirectSession,
    createBillingPortalSession,
    getAuthState,
    getBillingSummary,
    getBrowserSession,
    getReport,
    listReports,
    saveReport,
    signInWithEmail,
    signUpWithEmail,
    signOut,
    syncServerSession,
    onAuthStateChange,
    resetPasswordForEmail,
    updateUserPassword,
} from './auth.js';
import { API_BASE_URL } from './config.js';
import {
    getAccess,
    refreshAccess as refreshEntitlements,
    shouldLock as entitlementsShouldLock,
    isPremium as entitlementsIsPremium,
    redeemCode as redeemAccessCode,
    startCheckout as startStripeCheckout,
    openBillingPortal as openStripePortal,
    badge as accessBadge,
    onChange as onAccessChange,
} from './entitlements.js';

let currentStatus = 'anonymous';
let currentSub = { status: 'anonymous' };
let currentAuthState = { user: null, subscription: { status: 'anonymous' } };
let refreshVersion = 0; // debounce guard — only latest event wins
let isBootstrapping = true;
let isHeaderMenuOpen = false;
let selectedReportId = null;
let billingSummaryCache = null;
let pendingReportSavePromise = null;
let lastReportSaveError = '';

const MODAL_IDS = ['authModal', 'pricingModal', 'reportsModal', 'subscriptionModal'];

export async function initGating() {
    // Wire events FIRST — ensures buttons work even if Supabase is down
    wireEvents();
    renderHeaderLoading();

    try {
        await bootstrapAuthState();
    } catch (err) {
        console.error('[Gating] Eager session check failed:', err);
    }

    try {
        onAuthStateChange(async (event, session) => {
            if (event === 'INITIAL_SESSION') return;

            // Password recovery — user clicked reset link in email
            if (event === 'PASSWORD_RECOVERY') {
                openModal('authModal');
                setAuthMode('reset');
                return;
            }

            console.log('[Gating] Auth state changed:', event, session ? 'has session' : 'no session');

            // Close auth modal immediately on sign-in — don't wait for async refresh
            if (event === 'SIGNED_IN') {
                closeModal('authModal');
                hideSaveNudge();
                if (hasAuthParams()) history.replaceState(null, '', window.location.pathname);
            }

            const myVersion = ++refreshVersion;
            try {
                if (session) {
                    await syncServerSession(session);
                } else if (event === 'SIGNED_OUT') {
                    currentAuthState = { user: null, subscription: { status: 'anonymous' } };
                }

                await refreshAccess();
                if (myVersion !== refreshVersion) return; // superseded
                if (event === 'SIGNED_IN') {
                    restoreAndReanalyze();
                }
            } catch (err) {
                console.error('[Gating] Error in auth state change handler:', err);
                updateHeaderAuth({ user: null, subscription: { status: 'anonymous' } });
            }
        });
    } catch (err) {
        console.error('[Gating] Init failed:', err);
    }
}

async function bootstrapAuthState() {
    if (hasAuthParams()) {
        const container = document.getElementById('headerAuth');
        if (container) {
            container.innerHTML = '<span class="text-sm text-gray-400 animate-pulse">Signing you in...</span>';
        }

        const session = await consumeAuthRedirectSession();
        if (session) {
            await syncServerSession(session);
        }

        await refreshAccess();

        if (hasAuthParams()) {
            history.replaceState(null, '', window.location.pathname);
        }

        restoreAndReanalyze();
        isBootstrapping = false;
        updateHeaderAuth(currentAuthState);
        return;
    }

    const session = await getBrowserSession();
    if (session) {
        await syncServerSession(session);
    }

    await refreshAccess();
    isBootstrapping = false;
    updateHeaderAuth(currentAuthState);
}

/** True if URL contains magic-link auth params (PKCE code= or implicit access_token) */
function hasAuthParams() {
    return window.location.search.includes('code=') ||
           window.location.hash.includes('access_token');
}

/**
 * Called before running analysis. Always returns true so the analysis runs.
 * Anonymous users see blurred score/verdict — full results require a free account.
 * Expired subscribers see the full gate overlay.
 */
export function checkAccess() {
    return true; // always allow analysis to run
}

/**
 * Returns true if current user is anonymous (not signed in).
 */
export function isAnonymous() {
    return !currentAuthState?.user;
}

/**
 * Apply or remove anonymous blur on score gauge + deal verdict.
 * Called after each analysis render.
 */
// Blur removed — all content shown without authentication
export function applyAnonBlur() {}

/**
 * Called after every render. Locks the premium sections when the server says the
 * visitor is not entitled (and the gate is enabled); otherwise does nothing.
 */
export function applyAccessGate() {
    applyGating(currentSub);
}

export { openCodeModal, closeCodeModal };

async function refreshAccess() {
    // Entitlements come from the server (/api/auth/state → effective_access()).
    const access = await refreshEntitlements();
    const authState = {
        user: access.signedIn ? { email: access.email } : null,
        subscription: { status: access.level },
    };
    currentAuthState = authState;
    currentStatus = access.level;
    currentSub = authState.subscription;
    billingSummaryCache = null;
    applyGating(authState.subscription);
    updateHeaderAuth(authState);
}

// ════════════════════════════════════════════════
//  GATING UI
// ════════════════════════════════════════════════

let gateTriggered = false;

/**
 * The paid gate is SERVER-DRIVEN and off by default: while the server reports
 * gateEnabled = false the tool stays free for everyone (today's behaviour).
 * When it is on, non-premium visitors get the full results blurred behind an
 * upgrade / redeem-code overlay.
 */
function applyGating(sub) {
    const locked = entitlementsShouldLock();
    const resultsArea = document.getElementById('resultsArea');
    const overlay = document.getElementById('gateOverlay');

    if (!locked) {
        if (resultsArea) resultsArea.classList.remove('is-gated');
        if (overlay) { overlay.classList.add('hidden'); overlay.innerHTML = ''; }
        gateTriggered = false;
        return;
    }

    if (resultsArea) resultsArea.classList.add('is-gated');
    if (overlay) {
        overlay.classList.remove('hidden');
        renderOverlay(sub);
    }
    gateTriggered = true;
}

function renderOverlay(sub) {
    const overlay = document.getElementById('gateOverlay');
    if (!overlay) return;

    if (sub.status === 'expired') {
        overlay.innerHTML = `
            <div class="gate-icon">
                <svg class="w-8 h-8 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                </svg>
            </div>
            <h3 class="text-xl font-bold text-white mt-3">Your free access has ended</h3>
            <p class="text-sm text-gray-400 mt-1 max-w-md">Subscribe to keep the full underwriting analysis — buy box, scenarios, pro forma, sensitivity, and deal improvement levers.</p>
            <div class="flex gap-3 mt-5">
                <button id="gateViewPlans" class="px-6 py-2.5 text-sm font-semibold rounded-lg bg-white text-black hover:bg-gray-200 transition">See Plans</button>
                <button id="gateSignOut" class="px-4 py-2.5 text-sm font-semibold rounded-lg border border-surface-border text-gray-400 hover:text-white transition">Sign Out</button>
            </div>
            ${codeRedeemMarkup('Have another code?')}
        `;
        overlay.querySelector('#gateViewPlans')?.addEventListener('click', () => openModal('pricingModal'));
        overlay.querySelector('#gateSignOut')?.addEventListener('click', handleSignOut);
        wireCodeRedeem(overlay);
    } else {
        // Anonymous or free tier
        const signedIn = !!currentAuthState?.user;
        overlay.innerHTML = `
            <div class="gate-icon">
                <svg class="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                </svg>
            </div>
            <h3 class="text-xl font-bold text-white mt-3">${signedIn ? 'Unlock the full report' : 'Sign in to see the full report'}</h3>
            <p class="text-sm text-gray-400 mt-1 max-w-md">The Velocity Score is free. The full analysis — buy box pricing, scenario comparisons, pro forma, sensitivity, and deal improvement levers — is part of the paid plan.</p>
            <p class="text-xs text-gray-500 mt-1">Got a code from YouTube or Instagram? It's free for 2 weeks.</p>
            <div class="flex gap-3 mt-5">
                ${signedIn
                    ? `<button id="gateViewPlans" class="px-6 py-2.5 text-sm font-semibold rounded-lg bg-white text-black hover:bg-gray-200 transition">See Plans</button>
                       <button id="gateSignOut" class="px-4 py-2.5 text-sm font-semibold rounded-lg border border-surface-border text-gray-400 hover:text-white transition">Sign Out</button>`
                    : `<button id="gateSignUp" class="px-6 py-2.5 text-sm font-semibold rounded-lg bg-white text-black hover:bg-gray-200 transition">Create Free Account</button>
                       <button id="gateSignIn" class="px-4 py-2.5 text-sm font-semibold rounded-lg border border-surface-border text-gray-400 hover:text-white transition">Sign In</button>`}
            </div>
            ${codeRedeemMarkup('Or enter your code')}
        `;
        overlay.querySelector('#gateViewPlans')?.addEventListener('click', () => openModal('pricingModal'));
        overlay.querySelector('#gateSignOut')?.addEventListener('click', handleSignOut);
        overlay.querySelector('#gateSignUp')?.addEventListener('click', () => openModal('authModal'));
        overlay.querySelector('#gateSignIn')?.addEventListener('click', () => openModal('authModal'));
        wireCodeRedeem(overlay);
    }
}

/** Shared markup for redeeming a code, used by the gate overlay and its own modal. */
function codeRedeemMarkup(label = 'Have a code?') {
    return `
        <div class="mt-5 w-full max-w-sm">
            <p class="text-xs text-gray-500 mb-1.5">${label}</p>
            <div class="flex gap-2">
                <input id="codeInput" type="text" placeholder="YOUR-CODE"
                       class="flex-1 px-3 py-2 text-sm rounded-lg bg-surface border border-surface-border text-white placeholder-gray-600 focus:outline-none focus:border-gray-500 uppercase tracking-wide"
                       style="background:#141414;border:1px solid #2a2a2a">
                <button id="codeSubmit" class="px-4 py-2 text-sm font-semibold rounded-lg bg-surface-light border border-surface-border text-white hover:border-gray-500 transition">Redeem</button>
            </div>
            <p id="codeMsg" class="text-xs mt-2"></p>
        </div>
    `;
}

function wireCodeRedeem(root) {
    const input = root.querySelector('#codeInput');
    const btn = root.querySelector('#codeSubmit');
    const msg = root.querySelector('#codeMsg');
    if (!input || !btn) return;

    const submit = async () => {
        const code = input.value.trim();
        if (!code) return;
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Checking...';
        if (msg) { msg.textContent = ''; msg.style.color = ''; }

        if (!currentAuthState?.user) {
            if (msg) { msg.style.color = '#f59e0b'; msg.textContent = 'Create a free account first — takes 10 seconds — then enter your code.'; }
            openModal('authModal');
            btn.disabled = false; btn.textContent = original;
            return;
        }

        const result = await redeemAccessCode(code);
        if (msg) {
            msg.style.color = result.ok ? '#34d399' : '#f87171';
            msg.textContent = result.message || (result.ok ? 'Code applied.' : 'That code did not work.');
        }
        btn.disabled = false; btn.textContent = original;
        if (result.ok) { await refreshAccess(); applyGating(currentSub); }
    };

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

// ════════════════════════════════════════════════
//  HEADER AUTH STATE
// ════════════════════════════════════════════════

async function updateHeaderAuth(authState) {
    const container = document.getElementById('headerAuth');
    if (!container) return;

    const user = authState?.user || null;
    const sub = authState?.subscription || { status: 'anonymous' };

    if (!user) {
        isHeaderMenuOpen = false;
        container.innerHTML = `<span class="text-xs px-3 py-1.5 rounded-full bg-emerald-600/15 text-emerald-400 border border-emerald-500/20 font-medium">Free Access</span>`;
        return;
    }

    isHeaderMenuOpen = false;
    const b = accessBadge();
    const tone = {
        gold: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
        green: 'bg-emerald-600/15 text-emerald-400 border-emerald-500/20',
        blue: 'bg-blue-600/15 text-blue-300 border-blue-500/20',
        amber: 'bg-amber-600/15 text-amber-300 border-amber-500/20',
        neutral: 'bg-white/5 text-gray-300 border-white/10',
    }[b.tone] || 'bg-white/5 text-gray-300 border-white/10';
    let badge = `<span class="text-xs px-2.5 py-1 rounded-full border font-medium ${tone}">${b.text}</span>`;

    container.innerHTML = `
        <div id="headerMenuRoot" class="relative flex items-center gap-3">
            ${badge}
            <button
                id="headerMenuButton"
                type="button"
                aria-label="Open account menu"
                aria-expanded="${isHeaderMenuOpen ? 'true' : 'false'}"
                class="flex h-11 w-11 items-center justify-center rounded-2xl border border-surface-border bg-surface-light text-gray-300 transition hover:border-gray-500 hover:text-white"
            >
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75" d="M4 7h16M7 12h13M10 17h10"/>
                </svg>
            </button>
            <div
                id="headerMenuPanel"
                class="${isHeaderMenuOpen ? '' : 'hidden '}absolute right-0 top-[calc(100%+0.75rem)] w-64 overflow-hidden rounded-2xl border border-surface-border bg-surface shadow-2xl shadow-black/40"
            >
                <div class="border-b border-surface-border px-4 py-3">
                    <p class="text-[11px] uppercase tracking-[0.2em] text-gray-500">Account</p>
                    <p class="mt-1 truncate text-sm font-medium text-white">${escapeHtml(user.email || 'Signed in')}</p>
                </div>
                <div class="p-2">
                    <button type="button" id="menuPastReports" class="menu-action-button">My Deals</button>
                    <button type="button" id="menuRedeemCode" class="menu-action-button">Redeem a Code</button>
                    <button type="button" id="menuSubscription" class="menu-action-button">Subscription</button>
                    <div class="my-2 border-t border-surface-border"></div>
                    <button type="button" id="menuSignOut" class="menu-action-button menu-action-button-danger">Sign Out</button>
                </div>
            </div>
        </div>
    `;

    container.querySelector('#headerMenuButton')?.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleHeaderMenu();
    });
    container.querySelector('#menuPastReports')?.addEventListener('click', () => {
        closeHeaderMenu();
        if (typeof openMyDeals === 'function') openMyDeals();
    });
    container.querySelector('#menuRedeemCode')?.addEventListener('click', () => {
        closeHeaderMenu();
        openCodeModal();
    });
    container.querySelector('#menuSubscription')?.addEventListener('click', () => {
        closeHeaderMenu();
        openModal('subscriptionModal');
    });
    container.querySelector('#menuSignOut')?.addEventListener('click', async () => {
        closeHeaderMenu();
        await handleSignOut();
    });
}

function renderHeaderLoading() {
    const container = document.getElementById('headerAuth');
    if (!container) return;
    container.innerHTML = '<span class="text-sm text-gray-500 animate-pulse">Checking session...</span>';
}

function toggleHeaderMenu(force = !isHeaderMenuOpen) {
    isHeaderMenuOpen = force;
    const panel = document.getElementById('headerMenuPanel');
    const button = document.getElementById('headerMenuButton');
    if (panel) {
        panel.classList.toggle('hidden', !isHeaderMenuOpen);
    }
    if (button) {
        button.setAttribute('aria-expanded', String(isHeaderMenuOpen));
    }
}

function closeHeaderMenu() {
    if (!isHeaderMenuOpen) return;
    toggleHeaderMenu(false);
}

// ════════════════════════════════════════════════
//  MODALS
// ════════════════════════════════════════════════

export function openModal(id) {
    closeHeaderMenu();
    document.getElementById(id)?.classList.remove('hidden');

    if (id === 'reportsModal') {
        void loadPastReports();
    }
    if (id === 'subscriptionModal') {
        void loadSubscriptionSummary();
    }
}

function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
    // Reset auth modal button if it was stuck in a loading state
    if (id === 'authModal') {
        const btn = document.getElementById('authSubmit');
        if (btn && btn.disabled) {
            btn.disabled = false;
            btn.textContent = _authMode === 'signup' ? 'Create Free Account' : 'Sign In';
        }
    }
}

function closeAllModals() {
    MODAL_IDS.forEach((id) => closeModal(id));
}

function restoreAndReanalyze() {
    const restored = restoreFormState();
    if (restored) {
        setTimeout(() => {
            document.getElementById('analyzeBtn')?.click();
        }, 500);
    }
}

function captureCurrentFormState() {
    const formData = { _savedAt: Date.now() };
    const inputs = document.querySelectorAll('#inputSidebar input, #inputSidebar select');
    inputs.forEach((el) => {
        if (!el.id) return;
        if (el.type === 'checkbox') {
            formData[el.id] = el.checked;
        } else {
            formData[el.id] = el.value;
        }
    });
    return formData;
}

// Save all form inputs to localStorage before auth redirect
function saveFormState() {
    localStorage.setItem('kassidy_form_state', JSON.stringify(captureCurrentFormState()));
}

function applyFormState(formData) {
    if (!formData || typeof formData !== 'object') return false;

    const inputs = document.querySelectorAll('#inputSidebar input, #inputSidebar select');
    inputs.forEach((el) => {
        if (!el.id || !(el.id in formData)) return;
        const value = formData[el.id];
        if (el.type === 'checkbox') {
            el.checked = Boolean(value);
        } else if (value === null || value === undefined) {
            el.value = '';
        } else {
            el.value = value;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const price = parseFloat(String(formData.listedPrice || '').replace(/,/g, ''));
    return price > 0;
}

// Restore form inputs from localStorage after auth redirect
export function restoreFormState() {
    const saved = localStorage.getItem('kassidy_form_state');
    if (!saved) return false;

    try {
        const formData = JSON.parse(saved);

        // Discard stale saves (> 30 minutes old)
        if (formData._savedAt && Date.now() - formData._savedAt > 30 * 60 * 1000) {
            localStorage.removeItem('kassidy_form_state');
            return false;
        }

        const restored = applyFormState(formData);
        localStorage.removeItem('kassidy_form_state');
        return restored;
    } catch {
        localStorage.removeItem('kassidy_form_state');
        return false;
    }
}

async function loadPastReports() {
    const listEl = document.getElementById('reportsList');
    const statusEl = document.getElementById('reportsStatus');
    if (!listEl || !statusEl) return;

    if (pendingReportSavePromise) {
        statusEl.textContent = 'Saving your latest report...';
        await pendingReportSavePromise;
    } else {
        statusEl.textContent = lastReportSaveError;
    }

    listEl.innerHTML = '<div class="reports-empty-state">Loading your saved reports...</div>';

    try {
        const payload = await listReports();
        const reports = payload?.reports || [];
        statusEl.textContent = lastReportSaveError;

        if (reports.length === 0) {
            listEl.innerHTML = '<div class="reports-empty-state">No saved reports yet. Run an analysis and it will show up here.</div>';
            return;
        }

        listEl.innerHTML = reports.map((report) => renderReportListItem(report)).join('');
        listEl.querySelectorAll('[data-report-id]').forEach((button) => {
            button.addEventListener('click', () => {
                void handleReportSelect(button.dataset.reportId);
            });
        });
    } catch (err) {
        console.error('[Reports] Load failed:', err);
        listEl.innerHTML = '<div class="reports-empty-state">Unable to load reports right now. Please try again.</div>';
        statusEl.textContent = [lastReportSaveError, err.message].filter(Boolean).join(' ');
    }
}

function renderReportListItem(report) {
    const score = Number.isFinite(Number(report.totalScore)) ? `${Math.round(Number(report.totalScore))}/100` : '--';
    const price = formatCurrency(Number(report.listedPrice) || 0);
    const stamp = formatDate(report.createdAt);
    const title = escapeHtml(report.title || report.propertyAddress || 'Saved report');
    const subtitle = escapeHtml(report.propertyAddress || report.propertyType || 'Underwriting report');
    const isSelected = report.id === selectedReportId;

    return `
        <button type="button" class="report-list-item ${isSelected ? 'report-list-item-active' : ''}" data-report-id="${report.id}">
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-white">${title}</p>
                    <p class="mt-1 truncate text-xs text-gray-500">${subtitle}</p>
                </div>
                <span class="report-score-pill">${score}</span>
            </div>
            <div class="mt-4 flex items-center justify-between gap-3 text-xs text-gray-500">
                <span>${price}</span>
                <span>${stamp}</span>
            </div>
        </button>
    `;
}

async function handleReportSelect(reportId) {
    const statusEl = document.getElementById('reportsStatus');
    const listEl = document.getElementById('reportsList');
    if (!statusEl || !listEl) return;

    statusEl.textContent = 'Opening report...';
    listEl.querySelectorAll('[data-report-id]').forEach((button) => {
        button.disabled = true;
    });

    try {
        const payload = await getReport(reportId);
        const report = payload?.report;
        const formState = getSavedFormStateFromReport(report);
        if (!formState) {
            throw new Error('This report is missing the saved inputs needed to restore it.');
        }

        selectedReportId = report.id;
        applyFormState(formState);
        closeModal('reportsModal');

        setTimeout(() => {
            document.getElementById('analyzeBtn')?.click();
        }, 120);
    } catch (err) {
        console.error('[Reports] Restore failed:', err);
        statusEl.textContent = err.message || 'Unable to open that report.';
    } finally {
        listEl.querySelectorAll('[data-report-id]').forEach((button) => {
            button.disabled = false;
        });
    }
}

function getSavedFormStateFromReport(report) {
    const snapshot = report?.inputs;
    if (!snapshot || typeof snapshot !== 'object') return null;

    if (snapshot.formState && typeof snapshot.formState === 'object') {
        return snapshot.formState;
    }

    const calculated = snapshot.calculated && typeof snapshot.calculated === 'object'
        ? snapshot.calculated
        : snapshot;
    return buildLegacyFormState(report, calculated);
}

function buildLegacyFormState(report, inputs) {
    if (!inputs || typeof inputs !== 'object') return null;

    const propertyType = inputs.propertyType || report?.propertyType || 'hotel';
    const state = {
        propertyAddress: report?.propertyAddress || '',
        propertyType,
        listedPrice: formatFieldValue(inputs.listedPrice),
        renovationBudget: formatFieldValue(inputs.renovationBudget),
        arv: inputs.arvOverride === false ? '' : formatFieldValue(inputs.arv, { blankIfZero: true }),
        annualRevenueInput: propertyType === 'str'
            ? formatFieldValue(inputs.annualRevenue, { blankIfZero: true })
            : '',
        adr: formatFieldValue(inputs.adr),
        numKeys: formatFieldValue(inputs.numKeys),
        operatingExpenses: formatFieldValue(inputs.monthlyFixedOpex),
        perStayCost: formatFieldValue(inputs.perStayCost),
        ancillaryRevenue: formatFieldValue((inputs.ancillaryRevenue || 0) / 12, { blankIfZero: true }),
        holdPeriod: formatFieldValue(inputs.holdPeriod),
        householdIncome: formatFieldValue(inputs.householdIncome),
        filingStatus: inputs.filingStatus || 'married',
        constructionDuration: formatFieldValue(inputs.constructionDuration, { blankIfZero: propertyType !== 'hotel' }),
        furnishingBudget: formatFieldValue(inputs.furnishingBudget, { blankIfZero: true }),
        refiToggle: Boolean(inputs.refiPlanned),
        refiTiming: formatFieldValue(inputs.refiTimingMonths, { blankIfZero: true }),
        contingencySlider: formatFieldValue(
            inputs.renovationBudget > 0 ? ((inputs.contingencyAmount || 0) / inputs.renovationBudget) * 100 : 0,
            { blankIfZero: propertyType !== 'hotel' }
        ),
        expenseRatioSlider: formatFieldValue((inputs.expenseRatio || 0) * 100, { blankIfZero: propertyType !== 'hotel' }),
        perKeyRenoSlider: formatFieldValue(
            propertyType === 'hotel' && inputs.numKeys > 0
                ? (inputs.renovationBudget || 0) / inputs.numKeys
                : 15000
        ),
    };

    setSliderPair(state, 'downPayment', toPercent(inputs.downPct));
    setSliderPair(state, 'interestRate', inputs.interestRate);
    setSliderPair(state, 'occupancyRate', toPercent(inputs.occupancyRate));
    setSliderPair(state, 'annualAppreciation', toPercent(inputs.annualAppreciation));
    setSliderPair(state, 'revenueGrowth', toPercent(inputs.revenueGrowth));
    setSliderPair(state, 'marketCapRate', toPercent(inputs.marketCapRate));
    setSliderPair(state, 'exitCapRate', toPercent(inputs.exitCapRate));
    setSliderPair(state, 'closingCosts', toPercent(inputs.closingCostsPct));
    setSliderPair(state, 'refiRate', inputs.refiRate);
    setSliderPair(state, 'refiLTV', toPercent(inputs.refiLTV));

    return state;
}

function setSliderPair(state, inputId, value) {
    const normalized = formatFieldValue(value);
    state[inputId] = normalized;
    state[`${inputId}Slider`] = normalized;
}

function toPercent(value) {
    if (value === null || value === undefined || value === '') return '';
    return Number(value) <= 1 ? Number(value) * 100 : Number(value);
}

function formatFieldValue(value, options = {}) {
    const { blankIfZero = false } = options;
    if (value === null || value === undefined || value === '') return '';
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    if (blankIfZero && Math.abs(num) < 0.0001) return '';
    if (Math.abs(num - Math.round(num)) < 0.0001) return String(Math.round(num));
    return String(Number(num.toFixed(2)));
}

async function loadSubscriptionSummary() {
    const body = document.getElementById('subscriptionModalBody');
    const feedback = document.getElementById('subscriptionFeedback');
    if (!body || !feedback) return;

    body.innerHTML = '<div class="reports-empty-state">Loading your subscription details...</div>';
    feedback.textContent = '';

    try {
        const summary = await getBillingSummary();
        billingSummaryCache = summary;
        renderSubscriptionSummary(summary);
    } catch (err) {
        console.error('[Billing] Summary failed:', err);
        body.innerHTML = '<div class="reports-empty-state">Unable to load subscription details right now.</div>';
    }
}

function renderSubscriptionSummary(summary, feedbackMessage = '') {
    const body = document.getElementById('subscriptionModalBody');
    const feedback = document.getElementById('subscriptionFeedback');
    if (!body || !feedback) return;

    feedback.textContent = feedbackMessage;

    const statusLabel = summary.status === 'active'
        ? 'Active'
        : summary.status === 'trialing'
            ? 'Trial'
            : summary.status === 'expired'
                ? 'Expired'
                : 'Inactive';
    const planLabel = summary.plan?.label || 'No plan selected';
    const renewalLabel = summary.cancelAtPeriodEnd
        ? `Cancellation scheduled for ${formatDate(summary.periodEnd)}`
        : summary.periodEnd
            ? `Renews on ${formatDate(summary.periodEnd)}`
            : summary.trialEndsAt
                ? `Trial ends on ${formatDate(summary.trialEndsAt)}`
                : 'Manage your access below';

    body.innerHTML = `
        <div class="subscription-summary-card">
            <div class="flex items-start justify-between gap-4">
                <div>
                    <p class="text-[11px] uppercase tracking-[0.24em] text-gray-500">Current Access</p>
                    <h3 class="mt-2 text-2xl font-bold text-white">${escapeHtml(planLabel)}</h3>
                    <p class="mt-2 text-sm text-gray-400">${escapeHtml(renewalLabel)}</p>
                </div>
                <span class="report-score-pill">${statusLabel}</span>
            </div>
        </div>
        ${renderSubscriptionActions(summary)}
    `;

    attachSubscriptionActions(summary);
}

function renderSubscriptionActions(summary) {
    if (summary.status === 'active' && (summary.plan?.key === 'monthly' || summary.plan?.key === 'annual')) {
        return `
            <div class="mt-6 space-y-3">
                <div class="subscription-plan-row ${summary.plan.key === 'monthly' ? 'subscription-plan-row-active' : ''}">
                    <div>
                        <p class="text-sm font-semibold text-white">Monthly</p>
                        <p class="text-xs text-gray-500">$29 billed every month</p>
                    </div>
                    <button
                        id="subscriptionMonthlyBtn"
                        class="px-4 py-2 text-sm font-semibold rounded-lg ${summary.plan.key === 'monthly' ? 'border border-surface-border text-gray-500 cursor-default' : 'bg-white text-black hover:bg-gray-200'} transition"
                        ${summary.plan.key === 'monthly' ? 'disabled' : ''}
                    >
                        ${summary.plan.key === 'monthly' ? 'Current Plan' : 'Switch'}
                    </button>
                </div>
                <div class="subscription-plan-row ${summary.plan.key === 'annual' ? 'subscription-plan-row-active' : ''}">
                    <div>
                        <p class="text-sm font-semibold text-white">Annual</p>
                        <p class="text-xs text-gray-500">$199 billed yearly</p>
                    </div>
                    <button
                        id="subscriptionAnnualBtn"
                        class="px-4 py-2 text-sm font-semibold rounded-lg ${summary.plan.key === 'annual' ? 'border border-surface-border text-gray-500 cursor-default' : 'bg-white text-black hover:bg-gray-200'} transition"
                        ${summary.plan.key === 'annual' ? 'disabled' : ''}
                    >
                        ${summary.plan.key === 'annual' ? 'Current Plan' : 'Switch'}
                    </button>
                </div>
                <div class="mt-4 flex flex-col gap-3 sm:flex-row">
                    <button id="subscriptionPortalBtn" class="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg border border-surface-border text-white hover:border-gray-500 transition">
                        Open Billing Portal
                    </button>
                    <button
                        id="subscriptionCancelBtn"
                        class="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg border border-red-500/30 text-red-300 hover:border-red-400 hover:text-red-200 transition"
                        ${summary.cancelAtPeriodEnd ? 'disabled' : ''}
                    >
                        ${summary.cancelAtPeriodEnd ? 'Cancellation Scheduled' : 'Cancel at Period End'}
                    </button>
                </div>
            </div>
        `;
    }

    if (summary.status === 'trialing') {
        return `
            <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button id="subscriptionTrialMonthlyBtn" class="px-4 py-3 text-sm font-semibold rounded-xl border border-surface-border text-white hover:border-gray-500 transition">
                    Start Monthly Plan
                </button>
                <button id="subscriptionTrialAnnualBtn" class="px-4 py-3 text-sm font-semibold rounded-xl bg-white text-black hover:bg-gray-200 transition">
                    Start Annual Plan
                </button>
            </div>
        `;
    }

    return `
        <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button id="subscriptionExpiredMonthlyBtn" class="px-4 py-3 text-sm font-semibold rounded-xl border border-surface-border text-white hover:border-gray-500 transition">
                Subscribe Monthly
            </button>
            <button id="subscriptionExpiredAnnualBtn" class="px-4 py-3 text-sm font-semibold rounded-xl bg-white text-black hover:bg-gray-200 transition">
                Subscribe Annually
            </button>
        </div>
    `;
}

function attachSubscriptionActions(summary) {
    document.getElementById('subscriptionMonthlyBtn')?.addEventListener('click', () => {
        void handleSubscriptionPlanChange('monthly');
    });
    document.getElementById('subscriptionAnnualBtn')?.addEventListener('click', () => {
        void handleSubscriptionPlanChange('annual');
    });
    document.getElementById('subscriptionPortalBtn')?.addEventListener('click', () => {
        void handleOpenBillingPortal();
    });
    document.getElementById('subscriptionCancelBtn')?.addEventListener('click', () => {
        if (summary.cancelAtPeriodEnd) return;
        void handleSubscriptionCancel();
    });
    document.getElementById('subscriptionTrialMonthlyBtn')?.addEventListener('click', () => {
        void handleCheckout('monthly');
    });
    document.getElementById('subscriptionTrialAnnualBtn')?.addEventListener('click', () => {
        void handleCheckout('annual');
    });
    document.getElementById('subscriptionExpiredMonthlyBtn')?.addEventListener('click', () => {
        void handleCheckout('monthly');
    });
    document.getElementById('subscriptionExpiredAnnualBtn')?.addEventListener('click', () => {
        void handleCheckout('annual');
    });
}

async function handleSubscriptionPlanChange(plan) {
    const feedback = document.getElementById('subscriptionFeedback');
    if (feedback) {
        feedback.textContent = 'Updating your subscription...';
    }

    try {
        const payload = await changeSubscriptionPlan(plan);
        billingSummaryCache = payload.summary || null;
        await refreshAccess();
        renderSubscriptionSummary(payload.summary || billingSummaryCache, 'Subscription updated.');
    } catch (err) {
        console.error('[Billing] Plan change failed:', err);
        if (feedback) {
            feedback.textContent = err.message || 'Unable to update your plan.';
        }
    }
}

async function handleSubscriptionCancel() {
    const feedback = document.getElementById('subscriptionFeedback');
    if (feedback) {
        feedback.textContent = 'Scheduling cancellation...';
    }

    try {
        const payload = await cancelSubscription();
        billingSummaryCache = payload.summary || null;
        await refreshAccess();
        renderSubscriptionSummary(payload.summary || billingSummaryCache, 'Your subscription will end at the close of the current billing period.');
    } catch (err) {
        console.error('[Billing] Cancel failed:', err);
        if (feedback) {
            feedback.textContent = err.message || 'Unable to cancel your subscription.';
        }
    }
}

async function handleOpenBillingPortal() {
    const feedback = document.getElementById('subscriptionFeedback');
    if (feedback) {
        feedback.textContent = 'Opening billing portal...';
    }

    try {
        const payload = await createBillingPortalSession();
        if (payload?.url) {
            window.location.href = payload.url;
        } else if (feedback) {
            feedback.textContent = 'Unable to open billing portal.';
        }
    } catch (err) {
        console.error('[Billing] Portal failed:', err);
        if (feedback) {
            feedback.textContent = err.message || 'Unable to open billing portal.';
        }
    }
}

let _authMode = 'signin'; // 'signin' | 'signup' | 'forgot' | 'reset'

export function setAuthMode(mode) {
    _authMode = mode;
    const btn = document.getElementById('authSubmit');
    const title = document.getElementById('authTitle');
    const switchLink = document.getElementById('authSwitchToSignUp');
    const forgotLink = document.getElementById('authForgotLink');
    const subtitle = document.querySelector('#authModal p.text-sm.text-gray-400');
    const passwordField = document.getElementById('authPassword');
    const confirmPasswordWrap = document.getElementById('authConfirmPasswordWrap');
    const status = document.getElementById('authStatus');
    if (status) status.textContent = '';

    // Toggle field visibility
    if (passwordField) {
        passwordField.style.display = (mode === 'forgot') ? 'none' : '';
        passwordField.value = '';
    }
    if (confirmPasswordWrap) {
        confirmPasswordWrap.style.display = (mode === 'reset') ? '' : 'none';
    }
    if (forgotLink) {
        forgotLink.style.display = (mode === 'signin') ? '' : 'none';
    }

    if (mode === 'signup') {
        if (title) title.textContent = 'Create your account';
        if (btn) btn.textContent = 'Create Free Account';
        if (switchLink) { switchLink.textContent = 'Already have an account? Sign in'; switchLink.onclick = () => setAuthMode('signin'); }
        if (subtitle) subtitle.textContent = 'Free. No credit card required.';
    } else if (mode === 'forgot') {
        if (title) title.textContent = 'Reset your password';
        if (btn) btn.textContent = 'Send Reset Link';
        if (switchLink) { switchLink.textContent = 'Back to sign in'; switchLink.onclick = () => setAuthMode('signin'); }
        if (subtitle) subtitle.textContent = 'Enter your email and we\'ll send a reset link.';
    } else if (mode === 'reset') {
        if (title) title.textContent = 'Set new password';
        if (btn) btn.textContent = 'Set New Password';
        if (switchLink) switchLink.style.display = 'none';
        if (subtitle) subtitle.textContent = 'Enter your new password.';
        const emailField = document.getElementById('authEmail');
        if (emailField) emailField.style.display = 'none';
    } else {
        // signin
        if (title) title.textContent = 'Welcome back';
        if (btn) btn.textContent = 'Sign In';
        if (switchLink) { switchLink.textContent = 'New here? Create a free account'; switchLink.onclick = () => setAuthMode('signup'); switchLink.style.display = ''; }
        if (subtitle) subtitle.textContent = 'Sign in to access your analyses.';
        const emailField = document.getElementById('authEmail');
        if (emailField) emailField.style.display = '';
    }
}

async function handleForgotPassword() {
    const email = document.getElementById('authEmail')?.value?.trim();
    const btn = document.getElementById('authSubmit');
    const status = document.getElementById('authStatus');

    if (!email) {
        status.textContent = 'Please enter your email.';
        status.className = 'text-sm mt-3 text-red-400';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Sending...';
    status.textContent = '';

    const { error } = await resetPasswordForEmail(email);
    btn.disabled = false;
    btn.textContent = 'Send Reset Link';

    if (error) {
        status.textContent = error.message || 'Unable to send reset email.';
        status.className = 'text-sm mt-3 text-red-400';
    } else {
        status.textContent = 'Check your email for a reset link.';
        status.className = 'text-sm mt-3 text-emerald-400';
    }
}

async function handlePasswordReset() {
    const password = document.getElementById('authPassword')?.value || '';
    const confirm = document.getElementById('authConfirmPassword')?.value || '';
    const btn = document.getElementById('authSubmit');
    const status = document.getElementById('authStatus');

    if (!password || password.length < 6) {
        status.textContent = 'Password must be at least 6 characters.';
        status.className = 'text-sm mt-3 text-red-400';
        return;
    }
    if (password !== confirm) {
        status.textContent = 'Passwords do not match.';
        status.className = 'text-sm mt-3 text-red-400';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Setting password...';
    status.textContent = '';

    const { error } = await updateUserPassword(password);
    btn.disabled = false;

    if (error) {
        btn.textContent = 'Set New Password';
        status.textContent = error.message || 'Unable to update password.';
        status.className = 'text-sm mt-3 text-red-400';
    } else {
        status.textContent = 'Password updated! Signing you in…';
        status.className = 'text-sm mt-3 text-emerald-400';
        btn.textContent = 'Done';
        setTimeout(() => closeModal('authModal'), 1500);
    }
}

async function handleMagicLink() {
    // Dispatch to specific handlers for non-credential modes
    if (_authMode === 'forgot') return handleForgotPassword();
    if (_authMode === 'reset') return handlePasswordReset();

    const email = document.getElementById('authEmail')?.value?.trim();
    const password = document.getElementById('authPassword')?.value || '';
    const btn = document.getElementById('authSubmit');
    const status = document.getElementById('authStatus');

    if (!email) {
        status.textContent = 'Please enter your email.';
        status.className = 'text-sm mt-3 text-red-400';
        return;
    }
    if (!password) {
        status.textContent = 'Please enter your password.';
        status.className = 'text-sm mt-3 text-red-400';
        return;
    }

    btn.disabled = true;
    btn.textContent = _authMode === 'signup' ? 'Creating account...' : 'Signing in...';
    status.textContent = '';

    try {
        let error;
        if (_authMode === 'signup') {
            ({ error } = await signUpWithEmail(email, password));
            if (!error) {
                captureEmailToCRM(email);
                status.textContent = 'Account created! You now have full access.';
                status.className = 'text-sm mt-3 text-emerald-400';
                btn.textContent = 'Done';
                setTimeout(() => closeModal('authModal'), 1500);
                return;
            }
        } else {
            const signInTimeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Sign-in timed out. Please try again.')), 10000)
            );
            ({ error } = await Promise.race([signInWithEmail(email, password), signInTimeout]));
            if (!error) {
                status.textContent = 'Signed in!';
                status.className = 'text-sm mt-3 text-emerald-400';
                btn.textContent = 'Done';
                setTimeout(() => closeModal('authModal'), 800);
                return;
            }
        }
        // Show error and re-enable button
        const msg = error?.message || 'Something went wrong. Try again.';
        status.textContent = msg === 'Email not confirmed'
            ? 'Please check your email for a confirmation link, or contact support.'
            : msg;
        status.className = 'text-sm mt-3 text-red-400';
        btn.disabled = false;
        btn.textContent = _authMode === 'signup' ? 'Create Free Account' : 'Sign In';
    } catch (err) {
        status.textContent = 'Connection error. Please try again.';
        status.className = 'text-sm mt-3 text-red-400';
        btn.disabled = false;
        btn.textContent = _authMode === 'signup' ? 'Create Free Account' : 'Sign In';
    }
}

function captureEmailToCRM(email) {
    try {
        fetch('https://vault.kassidywarren.com/api/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: email.trim().toLowerCase(),
                source: 'vom_calculator',
                utm_source: 'vom-calculator',
                utm_medium: 'tool',
                utm_campaign: 'vom-calc-signup',
            }),
        }).catch(() => {}); // silent fail — never block UX
    } catch { /* ignore */ }
}

async function handleSignOut() {
    currentAuthState = { user: null, subscription: { status: 'anonymous' } };
    currentStatus = 'anonymous';
    currentSub = { status: 'anonymous' };
    gateTriggered = false;
    selectedReportId = null;
    billingSummaryCache = null;
    pendingReportSavePromise = null;
    lastReportSaveError = '';
    closeHeaderMenu();
    closeAllModals();
    applyGating(currentSub);
    updateHeaderAuth(currentAuthState);

    try {
        await signOut();
    } catch (err) {
        console.error('[Auth] Sign out cleanup failed:', err);
    }
}

async function handleCheckout(plan) {
    if (!currentAuthState?.user) {
        closeModal('pricingModal');
        closeModal('subscriptionModal');
        openModal('authModal');
        return;
    }

    const planButtonMap = {
        monthly: ['planMonthly', 'subscriptionTrialMonthlyBtn', 'subscriptionExpiredMonthlyBtn'],
        annual: ['planAnnual', 'subscriptionTrialAnnualBtn', 'subscriptionExpiredAnnualBtn'],
    };
    const btn = planButtonMap[plan]
        .map((id) => document.getElementById(id))
        .find(Boolean);
    const origText = btn?.textContent;
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Processing...';
    }

    try {
        const result = await startStripeCheckout(plan);
        if (result.ok) return;   // navigating to Stripe
        alert(result.message || 'Failed to start checkout. Please try again.');
    } catch (err) {
        console.error('[Checkout] Error:', err);
        alert('Connection error. Please try again.');
    }
    if (btn) {
        btn.disabled = false;
        btn.textContent = origText;
    }
}

/** Self-contained "redeem a code" modal — works whether or not the gate is showing. */
function openCodeModal() {
    let modal = document.getElementById('codeModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'codeModal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px)';
        modal.innerHTML = `
            <div style="background:#141414;border:1px solid #2a2a2a;border-radius:14px;padding:26px;width:min(420px,92vw);text-align:center">
                <button id="codeClose" style="float:right;background:none;border:none;color:#6b7280;font-size:20px;cursor:pointer;line-height:1">&times;</button>
                <h3 style="color:#fff;font-size:17px;font-weight:700;margin-bottom:6px">Redeem a Code</h3>
                <p style="color:#9ca3af;font-size:13px;margin-bottom:16px">Codes from YouTube, Instagram or the Escape Velocity community unlock free access.</p>
                ${codeRedeemMarkup('Your code')}
            </div>
        `;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeCodeModal(); });
        modal.querySelector('#codeClose')?.addEventListener('click', closeCodeModal);
        wireCodeRedeem(modal);
    }
    modal.style.display = 'flex';
}

function closeCodeModal() {
    const modal = document.getElementById('codeModal');
    if (modal) modal.style.display = 'none';
}

function showSaveNudge() {
    // Auth disabled — tool is free access, no nudge
}

function hideSaveNudge() {
    document.getElementById('saveNudge')?.classList.add('hidden');
}

export async function persistLatestReport(report) {
    if (!currentAuthState?.user) {
        // Auth disabled — silently skip save
        return null;
    }
    hideSaveNudge();

    let savePromise;
    savePromise = (async () => {
        try {
            lastReportSaveError = '';
            return await saveReport({
                ...report,
                listedPrice: sanitizeForStorage(report.listedPrice),
                totalScore: sanitizeForStorage(report.totalScore),
                moic: sanitizeForStorage(report.moic),
                irr: sanitizeForStorage(report.irr),
                inputs: sanitizeForStorage({
                    formState: captureCurrentFormState(),
                    calculated: report.inputs,
                }),
                // Re-opening a saved report only needs the saved form state; keep the stored
                // results snapshot intentionally lean so save requests stay fast and reliable.
                results: buildSavedResultsSnapshot(report),
            });
        } catch (err) {
            lastReportSaveError = err.message || 'Unable to save report.';
            console.error('[Reports] Save failed:', err);
            return null;
        } finally {
            if (pendingReportSavePromise === savePromise) {
                pendingReportSavePromise = null;
            }
        }
    })();

    pendingReportSavePromise = savePromise;
    return await savePromise;
}

function buildSavedResultsSnapshot(report) {
    return sanitizeForStorage({
        savedAt: new Date().toISOString(),
        totalScore: report.totalScore,
        moic: report.moic,
        irr: report.irr,
        propertyType: report.propertyType,
    });
}

function sanitizeForStorage(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForStorage(item));
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    const sanitized = {};
    Object.entries(value).forEach(([key, entryValue]) => {
        const normalized = sanitizeForStorage(entryValue);
        if (normalized !== undefined) {
            sanitized[key] = normalized;
        }
    });
    return sanitized;
}

function formatDate(value) {
    if (!value) return 'Unknown date';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(date);
}

function formatCurrency(value) {
    return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
    }).format(Number(value) || 0);
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

// ════════════════════════════════════════════════
//  EVENT WIRING
// ════════════════════════════════════════════════

function wireEvents() {
    console.log('[Gating] wireEvents called');

        // analyzeBtn intercept removed — no auth gate on analysis

    // Auth modal
    document.getElementById('authSubmit')?.addEventListener('click', handleMagicLink);
    document.getElementById('authSwitchToSignUp')?.addEventListener('click', () => setAuthMode('signup'));
    document.getElementById('authForgotLink')?.addEventListener('click', () => setAuthMode('forgot'));
    document.getElementById('authPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleMagicLink();
    });
    document.getElementById('authEmail')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleMagicLink();
    });
    document.getElementById('authConfirmPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleMagicLink();
    });
    document.getElementById('authClose')?.addEventListener('click', () => {
        closeModal('authModal');
        setAuthMode('signin'); // reset to default on close
    });

    // Pricing modal
    document.getElementById('pricingClose')?.addEventListener('click', () => closeModal('pricingModal'));
    document.getElementById('planMonthly')?.addEventListener('click', () => handleCheckout('monthly'));
    document.getElementById('planAnnual')?.addEventListener('click', () => handleCheckout('annual'));

    // Reports modal
    document.getElementById('reportsClose')?.addEventListener('click', () => closeModal('reportsModal'));

    // Subscription modal
    document.getElementById('subscriptionClose')?.addEventListener('click', () => closeModal('subscriptionModal'));

    // Close modals on backdrop click
    MODAL_IDS.forEach((id) => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            if (e.target.id === id) closeModal(id);
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#headerMenuRoot')) {
            closeHeaderMenu();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeHeaderMenu();
        }
    });
}
