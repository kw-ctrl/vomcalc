/**
 * App entry point — input gathering, orchestration, event listeners
 */

import { SMART_DEFAULTS } from './constants.js';
import { calculateMortgage, formatCurrency } from './utils.js';
const fmtCurrency = formatCurrency; // alias for new UI helpers
const parseCurrency = v => parseFloat(String(v).replace(/[^0-9.-]/g, '')) || 0;
import {
    calculateAnnualCashFlows, calculateMOIC, calculateIRR,
    calculateTaxBenefits, calculateAllTaxBenefits, calculateEquityMultiple, calculateStabilizedValue,
    calculateDepreciationExhaustion, calculateWorkingCapitalCushion,
    calculateReturnAttribution
} from './calculations.js';
import {
    scoreEquityCreation, scoreSpeedOfCapital, scoreTaxEfficiency,
    scoreStability, calculateFrictionPenalty, calculateMetricPenalties
} from './scoring.js';
import { solveBuyBoxPrices, buildScenarios, calculateDealLevers } from './scenarios.js';
import { renderResults } from './rendering.js';
import { calculateRemainingBalance } from './utils.js';
import { initGating, checkAccess, persistLatestReport, applyAnonBlur, openModal, setAuthMode } from './gating.js';
import { API_BASE_URL } from './config.js';
import { getBrowserSession } from './auth.js';

// ════════════════════════════════════════════════
//  INPUT GATHERING
// ════════════════════════════════════════════════

function getVal(id, fallback = 0) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    // Strip commas from currency-formatted inputs
    const raw = String(el.value).replace(/,/g, '');
    const v = parseFloat(raw);
    return isNaN(v) ? fallback : v;
}

function formatNumberWithCommas(value) {
    const num = String(value).replace(/,/g, '');
    if (!num || isNaN(num)) return value;
    const parts = num.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
}

function setCurrencyVal(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = (value === '' || value === undefined) ? '' : formatNumberWithCommas(String(value));
}

function setupCurrencyInput(el) {
    el.addEventListener('input', () => {
        const cursorPos = el.selectionStart;
        const oldLen = el.value.length;
        const raw = el.value.replace(/[^0-9.]/g, '');
        el.value = formatNumberWithCommas(raw);
        const newLen = el.value.length;
        // Adjust cursor for added/removed commas
        el.setSelectionRange(cursorPos + (newLen - oldLen), cursorPos + (newLen - oldLen));
    });
    // Format initial value
    if (el.value && el.value !== '0') {
        el.value = formatNumberWithCommas(el.value);
    }
}

const GUIDANCE_GROUP_IDS = [
    'listedPriceGroup',
    'annualRevenueGroup',
    'adrGroup',
    'operatingExpensesGroup',
    'renovationBudgetGroup',
    'furnishingBudgetGroup',
];
let hasImportedListing = false;

function clearRequiredFieldHighlights() {
    GUIDANCE_GROUP_IDS.forEach((id) => {
        const group = document.getElementById(id);
        if (!group) return;
        group.classList.remove('field-required', 'field-missing');
    });

    const guidance = document.getElementById('analyzeGuidance');
    if (!guidance) return;
    guidance.textContent = '';
    guidance.classList.add('hidden');
    guidance.classList.remove('is-ready');
}

function getRequiredInputState() {
    const propertyType = document.getElementById('propertyType').value;

    // Helpers — currency fields need parseCurrency, not parseFloat
    const getPx = id => parseCurrency(document.getElementById(id)?.value || '0');
    const getComputed = id => parseFloat(document.getElementById(id)?.value || '0');

    const items = [
        {
            groupId: 'listedPriceGroup',
            label: 'Listed Price',
            missing: getPx('listedPrice') <= 0,
        },
        {
            groupId: 'operatingExpensesGroup',
            label: 'Monthly Fixed Expenses',
            missing: getPx('operatingExpenses') <= 0,
        },
    ];

    if (propertyType === 'str') {
        const annualRev = getPx('annualRevenueInput');
        const adr = getVal('adr');
        const revenueOk = annualRev > 0 || adr > 0;

        // Reno/furnish: always considered "set" since they have defaults
        // Only flag missing if somehow both computed and manual are 0 AND level is 'none' explicitly
        const renoSet = !(RENO_LEVEL === 'none' && getComputed('renovationBudgetComputed') === 0 && getPx('renovationBudget') === 0)
            || true; // always valid — defaults to mid
        const furnishSet = true; // always valid — defaults to mid

        items.push({
            groupId: 'annualRevenueGroup',
            label: 'Annual Revenue',
            missing: !revenueOk,
        });

        // ARV required when refi is planned
        const refiOn = document.getElementById('refiToggle')?.checked;
        if (refiOn) {
            const arv = getPx('arv');
            items.push({
                groupId: 'arvGroup',
                label: 'ARV (required for refi cash-out)',
                missing: arv <= 0,
            });
        }
    } else {
        // Hotel: ADR required; annual revenue derived from ADR × occ × keys
        items.push({
            groupId: 'adrGroup',
            label: 'ADR',
            missing: getVal('adr') <= 0,
        });
    }

    return {
        propertyType,
        items,
        missingItems: items.filter((item) => item.missing),
    };
}

function updateRequiredFieldHighlights(options = {}) {
    const { focusFirstMissing = false, forceVisible = false } = options;
    const { items, missingItems } = getRequiredInputState();
    const shouldRender = forceVisible || hasImportedListing;

    clearRequiredFieldHighlights();

    if (!shouldRender || missingItems.length === 0) {
        return { items, missingItems };
    }

    // Only highlight fields that are actually MISSING — not all required fields.
    // This prevents confusing "listed price is highlighted" when the real issue is reno/furnish.
    items.forEach(({ groupId, missing }) => {
        const group = document.getElementById(groupId);
        if (!group) return;
        if (missing) {
            group.classList.add('field-required', 'field-missing');
        }
        // Never add field-required to a filled field — it misleads the user
    });

    const guidance = document.getElementById('analyzeGuidance');
    if (guidance) {
        guidance.classList.remove('hidden', 'is-ready');
        const labels = missingItems.map((item) => item.label).join(', ');
        guidance.textContent = `Complete these before analyzing: ${labels}.`;
    }

    if (focusFirstMissing && missingItems.length > 0) {
        const firstGroup = document.getElementById(missingItems[0].groupId);
        firstGroup?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstGroup?.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    }

    return { items, missingItems };
}

function gatherInputs() {
    const propertyType = document.getElementById('propertyType').value;
    const listedPrice = getVal('listedPrice');
    const downPct = getVal('downPayment', 20) / 100;
    // Use computed reno/furnish values (from level buttons or manual override)
    const renovationBudget = parseFloat(document.getElementById('renovationBudgetComputed')?.value || 0) ||
                             getVal('renovationBudget', 0);
    const arvInput = getVal('arv');
    const interestRate = getVal('interestRate', SMART_DEFAULTS[propertyType].interestRate);
    const occupancyRate = getVal('occupancyRate', 65) / 100;
    const numKeys = propertyType === 'str' ? 1 : getVal('numKeys', SMART_DEFAULTS[propertyType].numKeys);

    // ADR: for STR, derive from annual revenue if provided; for hotel, use direct input
    let adr;
    const annualRevenueInput = parseCurrency(document.getElementById('annualRevenueInput')?.value || '0');
    if (propertyType === 'str' && annualRevenueInput > 0) {
        const occupiedNights = occupancyRate * 365 * numKeys;
        adr = occupiedNights > 0 ? annualRevenueInput / occupiedNights : 0;
        // Sync the display ADR field
        const adrEl = document.getElementById('adr');
        if (adrEl && !adrEl._userEditing) adrEl.value = Math.round(adr);
    } else {
        adr = getVal('adr');
    }
    const holdPeriod = getVal('holdPeriod', SMART_DEFAULTS[propertyType].holdPeriod);
    const annualAppreciation = getVal('annualAppreciation', 3) / 100;
    const revenueGrowth = getVal('revenueGrowth', 2) / 100;
    const exitCapRate = getVal('exitCapRate', 9) / 100;
    const marketCapRate = getVal('marketCapRate', 8) / 100;

    // Revenue calculations (needed before opex for ratio mode)
    const annualRevenue = adr * occupancyRate * 365 * numKeys;
    const monthlyAncillary = getVal('ancillaryRevenue', 0);
    const ancillaryRevenue = monthlyAncillary * 12;
    // Additional unit (STR casita/studio/guest house) — inputs are MONTHLY
    const addlUnitOn = document.getElementById('additionalUnitToggle')?.checked;
    const addlUnitMonthlyRevenue = addlUnitOn ? (parseFloat(document.getElementById('additionalUnitRevenue')?.value || 0)) : 0;
    const addlUnitMonthlyExpenses = addlUnitOn ? (parseFloat(document.getElementById('additionalUnitExpenses')?.value || 0)) : 0;
    const addlUnitRevenue = addlUnitMonthlyRevenue * 12;  // annualize
    const totalRevenue = annualRevenue + ancillaryRevenue + addlUnitRevenue;

    // Operating expenses: fixed monthly + per-stay variable costs
    const monthlyFixedOpex = getVal('operatingExpenses', 0) + addlUnitMonthlyExpenses;
    const perStayCost = getVal('perStayCost', 0);
    // Estimate stays per year: occupancy × 365 × keys, assume avg 2.5 nights per stay
    const estimatedStaysPerYear = (occupancyRate * 365 * numKeys) / 2.5;
    const annualVariableCosts = perStayCost * estimatedStaysPerYear;
    const monthlyOpex = monthlyFixedOpex + (annualVariableCosts / 12);

    // Refinance inputs
    const refiPlanned = document.getElementById('refiToggle').checked;
    const refiRate = refiPlanned ? getVal('refiRate', 6.5) : 0;
    const refiTimingMonths = refiPlanned ? getVal('refiTiming', 18) : 0;
    const refiLTV = refiPlanned ? getVal('refiLTV', 70) / 100 : 0;

    // For hotels, auto-calculate exit value from NOI / cap rate if not provided
    // For STR, default to listed price if ARV not provided
    let arv;
    const arvOverride = arvInput > 0;
    if (arvOverride) {
        arv = arvInput;
    } else if (propertyType === 'hotel' && exitCapRate > 0) {
        const estRevenue = adr * occupancyRate * 365 * numKeys;
        const estOpex = monthlyOpex * 12;
        const estNOI = estRevenue - estOpex;
        // Floor at listed price — ARV should never be less than what we're paying
        arv = estNOI > 0 ? Math.max(listedPrice, estNOI / exitCapRate) : listedPrice;
    } else {
        arv = listedPrice;
    }

    const householdIncome = getVal('householdIncome', 250000);
    const filingStatus = document.getElementById('filingStatus').value;
    const closingCostsPct = getVal('closingCosts', 3) / 100;

    const furnishingBudget = parseFloat(document.getElementById('furnishingBudgetComputed')?.value || 0) ||
                            getVal('furnishingBudget', 0);

    // Hotel-specific: contingency and construction
    const contingencyPct = propertyType === 'hotel' ? getVal('contingencySlider', 15) / 100 : 0;
    const contingencyAmount = renovationBudget * contingencyPct;
    const constructionDuration = propertyType === 'hotel' ? getVal('constructionDuration', 6) : 0;

    const downPayment = listedPrice * downPct;
    const loanAmount = listedPrice - downPayment;
    const closingCosts = listedPrice * closingCostsPct;
    const totalRenoBudget = renovationBudget + contingencyAmount;
    const totalEquity = downPayment + closingCosts + totalRenoBudget + furnishingBudget;

    const annualOpex = monthlyOpex * 12;
    const ancillaryPct = totalRevenue > 0 ? ancillaryRevenue / totalRevenue : 0;
    const monthlyMortgage = calculateMortgage(loanAmount, interestRate);
    const annualDebtService = monthlyMortgage * 12;
    const noi = totalRevenue - annualOpex;
    const annualCashFlow = noi - annualDebtService;

    // Expense ratio: operating expenses / gross revenue (excludes debt service for all property types)
    const expenseRatio = totalRevenue > 0 ? annualOpex / totalRevenue : 0;

    return {
        propertyType, listedPrice, downPct, renovationBudget, arv, arvOverride,
        interestRate, adr, occupancyRate, numKeys, monthlyOpex,
        monthlyFixedOpex, perStayCost, annualVariableCosts,
        holdPeriod, annualAppreciation, revenueGrowth, exitCapRate, marketCapRate,
        householdIncome, filingStatus, closingCostsPct,
        downPayment, loanAmount, closingCosts, totalEquity,
        contingencyAmount, totalRenoBudget, constructionDuration, furnishingBudget,
        annualRevenue, ancillaryRevenue, totalRevenue, annualOpex,
        expenseRatio, ancillaryPct,
        monthlyMortgage, annualDebtService, noi, annualCashFlow,
        refiPlanned, refiRate, refiTimingMonths, refiLTV
    };
}

// ════════════════════════════════════════════════
//  ORCHESTRATOR
// ════════════════════════════════════════════════

// Soft recalc — used by inline field changes. Runs calc+render if data is sufficient,
// without blocking or scrolling. Never called from the Analyze button.
function recalc() {
    const price = getVal('listedPrice');
    const rev = parseCurrency(document.getElementById('annualRevenueInput')?.value || '0');
    const opex = parseCurrency(document.getElementById('operatingExpenses')?.value || '0');
    if (price <= 0 || (rev <= 0 && getVal('adr') <= 0)) return; // not enough data yet
    _runCalculation({ scroll: false, validate: false });
}

function analyzeProperty() {
    const guidanceState = updateRequiredFieldHighlights({ focusFirstMissing: true, forceVisible: true });
    if (guidanceState.missingItems.length > 0) {
        return;
    }
    _runCalculation({ scroll: true, validate: false });
}

function _runCalculation({ scroll = true } = {}) {

    if (!checkAccess()) return;

    const inputs = gatherInputs();

    // Core calculations
    const cashFlows = calculateAnnualCashFlows(inputs);
    const moic = calculateMOIC(cashFlows, inputs.totalEquity);
    const irr = calculateIRR(cashFlows);

        // Tax benefits — all years with carryforward
    const allTaxBenefits = calculateAllTaxBenefits(inputs);
    const year1TaxBenefits = allTaxBenefits[0]?.taxSavings ?? 0;
    const totalTaxBenefits = allTaxBenefits.reduce((s, y) => s + (y?.taxSavings ?? 0), 0);

    // Equity Multiple — ARV appreciation + debt paydown only (no operating CF, no tax)
    const equityMultiple = calculateEquityMultiple(inputs);

    // Scoring
    const equityScore = scoreEquityCreation(equityMultiple);
    const speedScore = scoreSpeedOfCapital(irr);
    const taxScore = scoreTaxEfficiency(totalTaxBenefits, inputs.totalEquity, year1TaxBenefits, inputs.householdIncome);
    const stabilityResult = scoreStability(inputs);
    const stabilityScore = stabilityResult.score;
    const friction = calculateFrictionPenalty(inputs);
    const coc = inputs.totalEquity > 0 ? (inputs.annualCashFlow / inputs.totalEquity) * 100 : 0;
    const metricPenalty = calculateMetricPenalties(coc, irr);
    const totalScore = Math.max(0, Math.min(100,
        Math.round(equityScore + speedScore + taxScore + stabilityScore - friction - metricPenalty)
    ));

    // LTV health check
    const stabilizedValue = calculateStabilizedValue(inputs);
    const remainingBalance = calculateRemainingBalance(
        inputs.loanAmount, inputs.interestRate, inputs.monthlyMortgage, inputs.holdPeriod
    );
    const stabilizedLTV = stabilizedValue > 0 ? remainingBalance / stabilizedValue : 0;
    const underLeveragedFlag = stabilizedLTV < 0.50;
    const trappedEquity = underLeveragedFlag ? (stabilizedValue - remainingBalance) - inputs.totalEquity : 0;

    // Depreciation exhaustion
    const depExhaustion = calculateDepreciationExhaustion(inputs);

    // Working capital cushion
    const workingCapital = calculateWorkingCapitalCushion(inputs);

    // Flags object for levers
    const flags = { underLeveragedFlag, depExhaustion };

    // Buy Box (dual-rate)
    const buyBox = solveBuyBoxPrices(inputs);
    const listedMOIC = moic;

    // Scenarios (stressed)
    const scenarios = buildScenarios(inputs);

    // Attribution (debt paydown)
    const attribution = calculateReturnAttribution(inputs);

    // Levers (conditional levers)
    const levers = calculateDealLevers(inputs, moic, irr, flags);

    // Scroll to results only when user explicitly clicks Analyze
    if (scroll) {
        const resultsSection = document.getElementById('section-score');
        if (resultsSection) {
            resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // Render everything
    const renderPayload = {
        totalScore, equityScore, speedScore, taxScore, stabilityScore,
        moic, irr, buyBox, listedMOIC, scenarios, attribution, levers,
        propertyType: inputs.propertyType,
        holdPeriod: inputs.holdPeriod,
        expenseRatio: inputs.expenseRatio,
        ancillaryPct: inputs.ancillaryPct,
        ancillaryRevenue: inputs.ancillaryRevenue,
        totalRevenue: inputs.totalRevenue,
        annualRevenue: inputs.annualRevenue,
        annualOpex: inputs.annualOpex,
        noi: inputs.noi,
        annualCashFlow: inputs.annualCashFlow,
        annualDebtService: inputs.annualDebtService,
        revenueGrowth: inputs.revenueGrowth,
        adr: inputs.adr,
        occupancyRate: inputs.occupancyRate,
        numKeys: inputs.numKeys,
        totalEquity: inputs.totalEquity,
        stabilityResult,
        equityMultiple,
        allTaxBenefits,
        friction,
        metricPenalty,
        totalTaxBenefits,
        year1TaxBenefits,
        dscr: stabilityResult.dscr,
        dscrFlag: stabilityResult.dscrFlag,
        negEquityFlag: stabilityResult.negEquityFlag,
        netRefiProceeds: stabilityResult.netRefiProceeds,
        stabilizedLTV,
        underLeveragedFlag,
        trappedEquity,
        depExhaustion,
        workingCapital,
        downPayment: inputs.downPayment,
        closingCosts: inputs.closingCosts,
        renovationBudget: inputs.renovationBudget,
        contingencyAmount: inputs.contingencyAmount,
        totalRenoBudget: inputs.totalRenoBudget,
        constructionDuration: inputs.constructionDuration,
        furnishingBudget: inputs.furnishingBudget,
        listedPrice: inputs.listedPrice,
        stabilizedValue,
        refiPlanned: inputs.refiPlanned,
        inputs
    };

    renderResults(renderPayload, gatherInputs);
    _lastRenderPayload = renderPayload; // store for save

    const propertyAddress = document.getElementById('propertyAddress')?.value?.trim() || '';
    const title = propertyAddress || `${inputs.propertyType === 'hotel' ? 'Boutique Hotel' : 'STR'} Report`;

    void persistLatestReport({
        title,
        propertyAddress: propertyAddress || null,
        propertyType: inputs.propertyType,
        listedPrice: inputs.listedPrice,
        totalScore,
        moic,
        irr,
        inputs,
        results: renderPayload,
    });

    // Apply blur for anonymous users after render
    applyAnonBlur();
}

// ════════════════════════════════════════════════
//  INPUT SYSTEM — Smart Defaults & Panel Toggle
// ════════════════════════════════════════════════

function togglePanel(btn) {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', !expanded);
    const body = btn.nextElementSibling;
    body.classList.toggle('hidden');
    const chevron = btn.querySelector('.panel-chevron');
    chevron.style.transform = expanded ? 'rotate(-90deg)' : 'rotate(0deg)';
}

function applySmartDefaults() {
    const type = document.getElementById('propertyType').value;
    const defaults = SMART_DEFAULTS[type];

    // Non-slider fields
    document.getElementById('holdPeriod').value = defaults.holdPeriod;
    const numKeysEl = document.getElementById('numKeys');
    if (numKeysEl) numKeysEl.value = defaults.numKeys;

    // Slider fields
    setSliderValue('downPayment', type === 'str' ? 20 : 30);
    setSliderValue('interestRate', defaults.interestRate);
    setSliderValue('occupancyRate', defaults.occupancyRate);
    setSliderValue('annualAppreciation', defaults.annualAppreciation);
    setSliderValue('revenueGrowth', defaults.revenueGrowth);
    setSliderValue('closingCosts', defaults.closingCosts);
    setSliderValue('marketCapRate', defaults.marketCapRate);
    setSliderValue('exitCapRate', defaults.exitCapRate);

    document.getElementById('adr').placeholder = defaults.adrPlaceholder;
    document.getElementById('operatingExpenses').placeholder = defaults.opexPlaceholder;

    // Revenue section: STR = annual revenue primary; hotel = ADR primary
    const annualRevGroup = document.getElementById('annualRevenueGroup');
    const adrGroup = document.getElementById('adrGroup');
    const numKeysGroup = document.getElementById('numKeysGroup');
    const additionalUnitGroup = document.getElementById('additionalUnitGroup');
    if (type === 'str') {
        if (annualRevGroup) annualRevGroup.style.display = 'block';
        if (adrGroup) adrGroup.style.display = 'block'; // secondary adjuster
        if (numKeysGroup) numKeysGroup.style.display = 'none'; // hidden for STR
        if (additionalUnitGroup) additionalUnitGroup.style.display = 'block';
    } else {
        if (annualRevGroup) annualRevGroup.style.display = 'none';
        if (adrGroup) adrGroup.style.display = 'block';
        if (numKeysGroup) numKeysGroup.style.display = 'block';
        if (additionalUnitGroup) additionalUnitGroup.style.display = 'none';
    }
    // CHANGE 1: Hide beds/baths/sqft for boutique hotel
    const bedsBathsGroup = document.getElementById('bedsBathsGroup');
    if (bedsBathsGroup) bedsBathsGroup.style.display = type === 'str' ? 'block' : 'none';

    document.getElementById('rateHint').textContent =
        type === 'hotel' ? 'Bridge rate for hotel' : 'Conventional mortgage rate';

    // CHANGE 3: ARV — show for STR, hide for hotel (hotel uses cap rate for exit value)
    const arvWrapper = document.getElementById('arvWrapper');
    if (arvWrapper) arvWrapper.style.display = type === 'str' ? 'block' : 'none';

    // CHANGE 3: Cap rates — grayed for STR, active for hotel
    const marketCapGroup = document.getElementById('marketCapRateGroup');
    const capGroup = document.getElementById('exitCapRateGroup');
    const capHint = document.getElementById('exitCapRateHint');
    if (type === 'hotel') {
        if (marketCapGroup) { marketCapGroup.style.display = 'block'; marketCapGroup.style.opacity = '1'; }
        if (capGroup) { capGroup.style.display = 'block'; capGroup.style.opacity = '1'; }
        if (capHint) capHint.textContent = 'Used to calculate exit value: NOI ÷ cap rate';
    } else {
        if (marketCapGroup) { marketCapGroup.style.display = 'block'; marketCapGroup.style.opacity = '0.5'; }
        if (capGroup) { capGroup.style.display = 'block'; capGroup.style.opacity = '0.5'; }
        if (capHint) capHint.textContent = 'Not used for STR exit value (uses ARV + appreciation)';
    }

    // Refi defaults: STR = 12mo / 75% LTV / rate = interest rate; Hotel = 18mo / 70%
    const interestRate = getVal('interestRate', defaults.interestRate);
    if (type === 'str') {
        setSliderValue('refiRate', interestRate);
        setSliderValue('refiLTV', 75);
        const timingEl = document.getElementById('refiTiming');
        if (timingEl) timingEl.value = 12;
    } else {
        setSliderValue('refiRate', 6.5);
        setSliderValue('refiLTV', 70);
        const timingEl = document.getElementById('refiTiming');
        if (timingEl) timingEl.value = 18;
    }

    // CHANGE 3: Refi cap rate group (hotel only, when refi is on)
    const refiCapRateGroup = document.getElementById('refiCapRateGroup');
    if (refiCapRateGroup) {
        const refiOn = document.getElementById('refiToggle')?.checked;
        refiCapRateGroup.style.display = (type === 'hotel' && refiOn) ? 'block' : 'none';
    }

    // STR-only: furnishing budget visible
    const furnishingGroup = document.getElementById('furnishingBudgetGroup');
    if (furnishingGroup) furnishingGroup.style.display = type === 'str' ? 'block' : 'none';

    // CHANGE 2: Renovation — STR uses $/sqft buttons, hotel uses $/key slider
    const hotelRenoBudgetGroup = document.getElementById('hotelRenoBudgetGroup');
    const renovationBudgetGroup = document.getElementById('renovationBudgetGroup');
    if (hotelRenoBudgetGroup) hotelRenoBudgetGroup.style.display = type === 'hotel' ? 'block' : 'none';
    if (renovationBudgetGroup) renovationBudgetGroup.style.display = type === 'str' ? 'block' : 'none';

    // Update reno + furnish estimates for new type
    updateRenoEstimate();
    updateFurnishEstimate();
    updateRefiCashOut();

    // Hotel: show calculated annual revenue + expense ratio slider
    let hotelRevenueGroup = document.getElementById('hotelRevenueDisplayGroup');
    let expenseRatioGroup = document.getElementById('expenseRatioGroup');
    if (type === 'hotel') {
        if (hotelRevenueGroup) hotelRevenueGroup.style.display = 'block';
        if (expenseRatioGroup) expenseRatioGroup.style.display = 'block';
        updateHotelRevenueDisplay();
    } else {
        if (hotelRevenueGroup) hotelRevenueGroup.style.display = 'none';
        if (expenseRatioGroup) expenseRatioGroup.style.display = 'none';
    }

    updateDownPaymentHint();
    updateRequiredFieldHighlights();

    // CHANGE 4 Fix C: Auto-apply opex estimate when type changes
    if (type === 'str') {
        const total = estimateOpex();
        const opexEl = document.getElementById('operatingExpenses');
        if (opexEl) setCurrencyVal('operatingExpenses', total || 800);
    } else {
        // Hotel: run expense ratio calculation instead
        updateExpenseRatioOpex();
    }
}

// Generic slider sync: reads slider value, writes to hidden input + display span
function syncSlider(sliderEl) {
    const inputId = sliderEl.dataset.input;
    const decimals = parseInt(sliderEl.dataset.decimals || '0');
    const val = parseFloat(sliderEl.value);
    const displayVal = decimals > 0 ? val.toFixed(decimals) : Math.round(val);

    // Sync hidden number input
    document.getElementById(inputId).value = val;

    // Update display span (next sibling in slider-row)
    const displaySpan = sliderEl.parentElement.querySelector('.slider-value');
    if (displaySpan) displaySpan.textContent = displayVal + '%';

    // Special: market cap rate auto-syncs exit cap rate (+1%)
    if (sliderEl.dataset.sync) {
        const [targetId, offset] = sliderEl.dataset.sync.split(':');
        const syncVal = val + parseFloat(offset);
        setSliderValue(targetId, syncVal);
    }

    // Special: down payment shows dollar amount hint
    if (inputId === 'downPayment') {
        const price = getVal('listedPrice');
        const el = document.getElementById('downPaymentAmount');
        el.textContent = price > 0 ? formatCurrency(price * val / 100) : '';
    }
}

// Programmatically set a slider+input pair by input ID
function setSliderValue(inputId, value) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = value;
    const slider = document.querySelector(`[data-input="${inputId}"]`);
    if (slider) {
        slider.value = value;
        const decimals = parseInt(slider.dataset.decimals || '0');
        const displayVal = decimals > 0 ? parseFloat(value).toFixed(decimals) : Math.round(value);
        const displaySpan = slider.parentElement.querySelector('.slider-value');
        if (displaySpan) displaySpan.textContent = displayVal + '%';
    }
}

function updatePerKeyReno() {
    const perKey = getVal('perKeyRenoSlider', 15000);
    const keys = getVal('numKeys', 10);
    const total = perKey * keys;
    document.getElementById('perKeyRenoValue').textContent = '$' + Math.round(perKey / 1000) + 'K';
    document.getElementById('perKeyRenoHint').textContent = `Total: ${formatCurrency(total)} (${keys} keys × ${formatCurrency(perKey)})`;
    // Sync to renovation budget field
    setCurrencyVal('renovationBudget', total);
    updateContingency();
    updateRequiredFieldHighlights();
}

function updateContingency() {
    const reno = getVal('renovationBudget', 0);
    const pct = getVal('contingencySlider', 15);
    const contingencyAmount = reno * pct / 100;
    const valEl = document.getElementById('contingencyValue');
    const hintEl = document.getElementById('contingencyHint');
    if (valEl) valEl.textContent = pct + '%';
    if (hintEl) hintEl.textContent = `${formatCurrency(contingencyAmount)} contingency on ${formatCurrency(reno)} renovation`;
}

function updateFurnishingPlaceholder() {
    const type = document.getElementById('propertyType').value;
    if (type !== 'str') return;
    const price = getVal('listedPrice');
    const el = document.getElementById('furnishingBudget');
    if (price > 0 && el) {
        // Default furnishing estimate: ~$35/sqft, approximated as 3.5% of price for typical STR
        const estimate = Math.round(price * 0.035);
        el.placeholder = estimate.toLocaleString();
        // Pre-populate if empty or zero
        if (!el.value || el.value === '0') {
            el.value = estimate;
        }
    }
}

function updateHotelRevenueDisplay() {
    const display = document.getElementById('hotelRevenueValue');
    if (!display) return;
    const adr = getVal('adr');
    const occ = getVal('occupancyRate', 65) / 100;
    const keys = getVal('numKeys', 10);
    const annualRevenue = adr * occ * 365 * keys;
    display.textContent = annualRevenue > 0 ? formatCurrency(annualRevenue) : '--';
}

function updateExpenseRatioOpex() {
    const ratioPct = getVal('expenseRatioSlider', 65);
    const adr = getVal('adr');
    const occ = getVal('occupancyRate', 65) / 100;
    const keys = getVal('numKeys', 10);
    const annualRevenue = adr * occ * 365 * keys;
    const monthlyExpenses = Math.round((annualRevenue * ratioPct / 100) / 12);
    setCurrencyVal('operatingExpenses', monthlyExpenses);
    const display = document.getElementById('expenseRatioValue');
    if (display) display.textContent = ratioPct + '%';
    const hint = document.getElementById('expenseRatioHint');
    if (hint) hint.textContent = `${formatCurrency(monthlyExpenses)}/mo from ${formatCurrency(annualRevenue)} revenue`;
    updateRequiredFieldHighlights();
}

function updateDownPaymentHint() {
    const price = getVal('listedPrice');
    const pct = getVal('downPayment', 30);
    const el = document.getElementById('downPaymentAmount');
    // Sync slider display
    setSliderValue('downPayment', pct);
    if (price > 0) {
        el.textContent = formatCurrency(price * pct / 100);
    } else {
        el.textContent = '';
    }
    updateMonthlyMortgageDisplay();
}

function updateMonthlyMortgageDisplay() {
    const price = parseCurrency(document.getElementById('listedPrice')?.value || '0');
    const downPct = getVal('downPayment', 20) / 100;
    const rate = getVal('interestRate', 7.5);
    const loanAmount = price * (1 - downPct);
    const displayEl = document.getElementById('monthlyMortgageDisplay');
    const amountEl = document.getElementById('monthlyMortgageAmount');
    if (!displayEl || !amountEl) return;
    if (price <= 0 || loanAmount <= 0) {
        displayEl.style.display = 'none';
        return;
    }
    const monthly = calculateMortgage(loanAmount, rate);
    displayEl.style.display = 'flex';
    amountEl.textContent = `$${Math.round(monthly).toLocaleString()}/mo`;
}

// ════════════════════════════════════════════════
//  REFINANCE TOGGLE
// ════════════════════════════════════════════════

function toggleRefiInputs() {
    const checked = document.getElementById('refiToggle').checked;
    document.getElementById('refiInputsGroup').style.display = checked ? 'block' : 'none';
    if (checked) {
        updateRefiCashOut();
        // CHANGE 3: Show refi cap rate group for hotel
        const type = document.getElementById('propertyType')?.value;
        const refiCapRateGroup = document.getElementById('refiCapRateGroup');
        if (refiCapRateGroup) refiCapRateGroup.style.display = (type === 'hotel') ? 'block' : 'none';
    } else {
        const refiCapRateGroup = document.getElementById('refiCapRateGroup');
        if (refiCapRateGroup) refiCapRateGroup.style.display = 'none';
    }
}

// ════════════════════════════════════════════════
//  DEMO DATA
// ════════════════════════════════════════════════

const DEMO_SCENARIOS = [
    {
        name: 'Boutique Hotel — Savannah, GA',
        propertyType: 'hotel',
        address: '412 Bull St, Savannah, GA 31401',
        listedPrice: 2000000,
        downPayment: 30,
        renovationBudget: 1000000,
        arv: '',
        interestRate: 12,
        refi: true, refiRate: 6.5, refiTiming: 18, refiLTV: 70,
        adr: 145,
        occupancyRate: 65,
        numKeys: 20,
        operatingExpenses: 35000,
        ancillaryRevenue: 8000,
        holdPeriod: 7,
        annualAppreciation: 3,
        revenueGrowth: 2,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 350000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Blue Ridge Cabin',
        propertyType: 'str',
        address: '88 Mountain View Dr, Blue Ridge, GA 30513',
        listedPrice: 650000,
        downPayment: 20,
        renovationBudget: 50000,
        furnishingBudget: 25000,
        arv: 700000,
        interestRate: 7.5,
        refi: false,
        adr: 250,
        occupancyRate: 65,
        numKeys: 1,
        bedrooms: 3, bathrooms: 2,
        operatingExpenses: 2700,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 3,
        revenueGrowth: 2,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 300000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Scottsdale Luxury',
        propertyType: 'str',
        address: '7240 E Solano Dr, Scottsdale, AZ 85250',
        listedPrice: 835000,
        downPayment: 20,
        renovationBudget: 225000,
        furnishingBudget: 40000,
        arv: 1400000,
        interestRate: 7.75,
        refi: false,
        adr: 549,
        occupancyRate: 70,
        numKeys: 1,
        bedrooms: 5, bathrooms: 4,
        operatingExpenses: 4000,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 4,
        revenueGrowth: 3,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 400000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'Boutique Hotel — Austin, TX',
        propertyType: 'hotel',
        address: '1100 S Congress Ave, Austin, TX 78704',
        listedPrice: 3500000,
        downPayment: 25,
        renovationBudget: 800000,
        arv: '',
        interestRate: 11,
        refi: true, refiRate: 6.0, refiTiming: 24, refiLTV: 65,
        adr: 189,
        occupancyRate: 72,
        numKeys: 28,
        operatingExpenses: 72000,
        ancillaryRevenue: 15000,
        holdPeriod: 7,
        annualAppreciation: 3,
        revenueGrowth: 3,
        marketCapRate: 7.5,
        exitCapRate: 8.5,
        householdIncome: 500000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Destin Beachfront',
        propertyType: 'str',
        address: '2830 Scenic Gulf Dr, Destin, FL 32541',
        listedPrice: 920000,
        downPayment: 25,
        renovationBudget: 60000,
        furnishingBudget: 35000,
        arv: 1050000,
        interestRate: 7.25,
        refi: false,
        adr: 385,
        occupancyRate: 60,
        numKeys: 1,
        bedrooms: 4, bathrooms: 3,
        operatingExpenses: 3650,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 3.5,
        revenueGrowth: 2.5,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 275000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'Boutique Hotel — Charleston, SC',
        propertyType: 'hotel',
        address: '62 Queen St, Charleston, SC 29401',
        listedPrice: 4200000,
        downPayment: 25,
        renovationBudget: 950000,
        arv: '',
        interestRate: 10.5,
        refi: true, refiRate: 6.25, refiTiming: 18, refiLTV: 65,
        adr: 215,
        occupancyRate: 74,
        numKeys: 32,
        operatingExpenses: 95000,
        ancillaryRevenue: 22000,
        holdPeriod: 7,
        annualAppreciation: 3,
        revenueGrowth: 3,
        marketCapRate: 7,
        exitCapRate: 8,
        householdIncome: 450000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Smoky Mountain A-Frame',
        propertyType: 'str',
        address: '1415 Wears Valley Rd, Pigeon Forge, TN 37863',
        listedPrice: 425000,
        downPayment: 20,
        renovationBudget: 35000,
        furnishingBudget: 18000,
        arv: 520000,
        interestRate: 7.0,
        refi: false,
        adr: 195,
        occupancyRate: 68,
        numKeys: 1,
        bedrooms: 2, bathrooms: 2,
        operatingExpenses: 1800,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 4,
        revenueGrowth: 2,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 200000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'Boutique Hotel — Asheville, NC',
        propertyType: 'hotel',
        address: '87 Haywood St, Asheville, NC 28801',
        listedPrice: 2800000,
        downPayment: 30,
        renovationBudget: 600000,
        arv: '',
        interestRate: 11.5,
        refi: true, refiRate: 6.5, refiTiming: 24, refiLTV: 68,
        adr: 175,
        occupancyRate: 70,
        numKeys: 24,
        operatingExpenses: 62000,
        ancillaryRevenue: 12000,
        holdPeriod: 7,
        annualAppreciation: 3.5,
        revenueGrowth: 2.5,
        marketCapRate: 7.5,
        exitCapRate: 8.5,
        householdIncome: 375000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Joshua Tree Modern',
        propertyType: 'str',
        address: '6547 Juniper Ave, Joshua Tree, CA 92252',
        listedPrice: 380000,
        downPayment: 25,
        renovationBudget: 90000,
        furnishingBudget: 30000,
        arv: 575000,
        interestRate: 7.5,
        refi: false,
        adr: 275,
        occupancyRate: 62,
        numKeys: 1,
        bedrooms: 3, bathrooms: 2,
        operatingExpenses: 2200,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 5,
        revenueGrowth: 3,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 250000,
        filingStatus: 'single',
        closingCosts: 3,
    },
    {
        name: 'Boutique Hotel — Nashville, TN',
        propertyType: 'hotel',
        address: '1923 Broadway, Nashville, TN 37203',
        listedPrice: 5200000,
        downPayment: 25,
        renovationBudget: 1200000,
        arv: '',
        interestRate: 10,
        refi: true, refiRate: 5.75, refiTiming: 18, refiLTV: 70,
        adr: 199,
        occupancyRate: 76,
        numKeys: 45,
        operatingExpenses: 135000,
        ancillaryRevenue: 30000,
        holdPeriod: 7,
        annualAppreciation: 3,
        revenueGrowth: 3.5,
        marketCapRate: 7,
        exitCapRate: 7.5,
        householdIncome: 600000,
        filingStatus: 'married',
        closingCosts: 2.5,
    },
    {
        name: 'STR — Lake Tahoe Chalet',
        propertyType: 'str',
        address: '3340 Lake Tahoe Blvd, South Lake Tahoe, CA 96150',
        listedPrice: 1150000,
        downPayment: 25,
        renovationBudget: 120000,
        furnishingBudget: 45000,
        arv: 1450000,
        interestRate: 7.25,
        refi: false,
        adr: 450,
        occupancyRate: 58,
        numKeys: 1,
        bedrooms: 5, bathrooms: 3,
        operatingExpenses: 5200,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 3,
        revenueGrowth: 2,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 350000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'Boutique Hotel — Fredericksburg, TX',
        propertyType: 'hotel',
        address: '245 E Main St, Fredericksburg, TX 78624',
        listedPrice: 1800000,
        downPayment: 30,
        renovationBudget: 450000,
        arv: '',
        interestRate: 11,
        refi: true, refiRate: 6.75, refiTiming: 18, refiLTV: 65,
        adr: 225,
        occupancyRate: 68,
        numKeys: 12,
        operatingExpenses: 38000,
        ancillaryRevenue: 8000,
        holdPeriod: 7,
        annualAppreciation: 3.5,
        revenueGrowth: 2.5,
        marketCapRate: 8,
        exitCapRate: 8.5,
        householdIncome: 300000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Tulum-Style Miami Pool Home',
        propertyType: 'str',
        address: '1845 SW 23rd St, Miami, FL 33145',
        listedPrice: 720000,
        downPayment: 20,
        renovationBudget: 150000,
        furnishingBudget: 35000,
        arv: 1050000,
        interestRate: 7.5,
        refi: false,
        adr: 325,
        occupancyRate: 72,
        numKeys: 1,
        bedrooms: 4, bathrooms: 3,
        operatingExpenses: 3400,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 4,
        revenueGrowth: 3,
        marketCapRate: 7.5,
        exitCapRate: 8.5,
        householdIncome: 325000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'Boutique Hotel — Hudson Valley, NY',
        propertyType: 'hotel',
        address: '520 Warren St, Hudson, NY 12534',
        listedPrice: 3100000,
        downPayment: 25,
        renovationBudget: 700000,
        arv: '',
        interestRate: 10.5,
        refi: true, refiRate: 6.0, refiTiming: 24, refiLTV: 68,
        adr: 245,
        occupancyRate: 66,
        numKeys: 18,
        operatingExpenses: 55000,
        ancillaryRevenue: 10000,
        holdPeriod: 7,
        annualAppreciation: 3,
        revenueGrowth: 2.5,
        marketCapRate: 7.5,
        exitCapRate: 8,
        householdIncome: 425000,
        filingStatus: 'married',
        closingCosts: 3,
    },
    {
        name: 'STR — Sedona Red Rock Retreat',
        propertyType: 'str',
        address: '120 Canyon Diablo Rd, Sedona, AZ 86351',
        listedPrice: 590000,
        downPayment: 25,
        renovationBudget: 75000,
        furnishingBudget: 28000,
        arv: 780000,
        interestRate: 7.0,
        refi: false,
        adr: 310,
        occupancyRate: 65,
        numKeys: 1,
        bedrooms: 3, bathrooms: 2,
        operatingExpenses: 2600,
        ancillaryRevenue: 0,
        holdPeriod: 5,
        annualAppreciation: 4.5,
        revenueGrowth: 3,
        marketCapRate: 8,
        exitCapRate: 9,
        householdIncome: 280000,
        filingStatus: 'single',
        closingCosts: 3,
    },
];

let demoIndex = 0;

function loadDemoData() {
    const d = DEMO_SCENARIOS[demoIndex];
    demoIndex = (demoIndex + 1) % DEMO_SCENARIOS.length;

    // Property type first (triggers smart defaults)
    document.getElementById('propertyType').value = d.propertyType;
    applySmartDefaults();

    // The Deal
    document.getElementById('propertyAddress').value = d.address;
    setCurrencyVal('listedPrice', d.listedPrice);
    setSliderValue('downPayment', d.downPayment);
    setCurrencyVal('renovationBudget', d.renovationBudget);
    setCurrencyVal('arv', d.arv);
    setSliderValue('interestRate', d.interestRate);

    // Furnishing (STR only)
    if (d.furnishingBudget) {
        document.getElementById('furnishingBudget').value = d.furnishingBudget;
    }

    // Beds/baths (STR only)
    if (d.bedrooms) {
        document.getElementById('bedrooms').value = d.bedrooms;
        document.getElementById('bathrooms').value = d.bathrooms;
    }

    // Refi
    document.getElementById('refiToggle').checked = d.refi;
    toggleRefiInputs();
    if (d.refi) {
        setSliderValue('refiRate', d.refiRate);
        document.getElementById('refiTiming').value = d.refiTiming;
        setSliderValue('refiLTV', d.refiLTV);
    }

    // Revenue & Costs
    document.getElementById('annualRevenueInput').value = '';
    document.getElementById('adr').value = d.adr;
    setSliderValue('occupancyRate', d.occupancyRate);
    document.getElementById('numKeys').value = d.numKeys;

    if (d.operatingExpenses) {
        setCurrencyVal('operatingExpenses', d.operatingExpenses);
    }

    document.getElementById('ancillaryRevenue').value = d.ancillaryRevenue || '';

    // Assumptions
    document.getElementById('holdPeriod').value = d.holdPeriod;
    setSliderValue('annualAppreciation', d.annualAppreciation);
    setSliderValue('revenueGrowth', d.revenueGrowth);
    setSliderValue('marketCapRate', d.marketCapRate);
    setSliderValue('exitCapRate', d.exitCapRate);
    setCurrencyVal('householdIncome', d.householdIncome);
    document.getElementById('filingStatus').value = d.filingStatus;
    setSliderValue('closingCosts', d.closingCosts);

    updateDownPaymentHint();

    // Auto-analyze
    analyzeProperty();
}

// ════════════════════════════════════════════════
//  LISTING IMPORT (Zillow / Redfin)
// ════════════════════════════════════════════════

function showFetchStatus(message, type) {
    const el = document.getElementById('fetchStatus');
    el.textContent = message;
    el.classList.remove('hidden', 'text-blue-400', 'text-green-400', 'text-red-400');
    const colorClass = type === 'loading' ? 'text-blue-400' : type === 'success' ? 'text-green-400' : 'text-red-400';
    el.classList.add(colorClass);
    if (type === 'success') {
        setTimeout(() => el.classList.add('hidden'), 3000);
    }
}

function populateFromListing(data) {
    // Map property type — detect hotel from propertyType keywords or high unit count
    const rawType = (data.propertyType || '').toLowerCase();
    const hotelKeywords = ['hotel', 'motel', 'hospitality', 'inn', 'lodge', 'resort', 'bed and breakfast', 'b&b'];
    const isHotel = hotelKeywords.some(kw => rawType.includes(kw)) || (data.numUnits > 4 && rawType !== 'multifamily');
    hasImportedListing = true;
    document.getElementById('propertyType').value = isHotel ? 'hotel' : 'str';
    applySmartDefaults();

    // Populate fields
    if (data.address)    document.getElementById('propertyAddress').value = data.address;
    if (data.price)      setCurrencyVal('listedPrice', data.price);
    if (data.listedPrice && !data.price) setCurrencyVal('listedPrice', data.listedPrice);
    if (data.bedrooms)   document.getElementById('bedrooms').value = data.bedrooms;
    if (data.bathrooms)  document.getElementById('bathrooms').value = data.bathrooms;
    if (data.squareFeet) {
        const sqftEl = document.getElementById('squareFeet');
        if (sqftEl) sqftEl.value = data.squareFeet;
    }
    if (data.estimatedValue) setCurrencyVal('arv', data.estimatedValue);
    if (data.numUnits)   { const el = document.getElementById('numKeys'); if (el) el.value = data.numUnits; }

    // Trigger reno + furnish + opex estimates now that fields are set
    updateRenoEstimate();
    updateFurnishEstimate();
    updateRefiCashOut();
    updateDownPaymentHint();
    updateRequiredFieldHighlights();
    if (document.getElementById('propertyType').value === 'str') {
        const t = estimateOpex();
        if (t > 0) setCurrencyVal('operatingExpenses', t);
    }

    // Show warnings if any
    if (data.warnings && data.warnings.length > 0) {
        showFetchStatus('Warning: ' + data.warnings[0], 'error');
    }
}

async function fetchListingData() {
    const urlInput = document.getElementById('listingUrl');
    const btn = document.getElementById('fetchListingBtn');
    const url = urlInput.value.trim();

    if (!url) {
        showFetchStatus('Please paste a URL first.', 'error');
        return;
    }

    // Client-side URL validation
    let hostname;
    let resolvedUrl = url;
    try {
        hostname = new URL(url).hostname;
    } catch {
        showFetchStatus('That doesn\'t look like a valid URL.', 'error');
        return;
    }

    // Handle redf.in shorthand links — expand server-side
    if (hostname === 'redf.in' || hostname === 'www.redf.in') {
        showFetchStatus('Expanding Redfin short link…', 'loading');
        try {
            const r = await fetch(`/api/expand-url?url=${encodeURIComponent(url)}`);
            const d = await r.json();
            if (d.url && d.url.includes('redfin.com')) {
                resolvedUrl = d.url;
                hostname = new URL(resolvedUrl).hostname;
                urlInput.value = resolvedUrl;
            } else {
                showFetchStatus('Could not expand that Redfin link. Try the full redfin.com URL.', 'error');
                return;
            }
        } catch {
            showFetchStatus('Could not expand that Redfin link. Try the full redfin.com URL.', 'error');
            return;
        }
    }

    const allowedDomains = ['zillow.com', 'redfin.com', 'crexi.com', 'loopnet.com', 'costar.com'];
    const isAllowed = allowedDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain));
    if (!isAllowed) {
        showFetchStatus('Supported: Zillow, Redfin (redf.in), Crexi, LoopNet, CoStar', 'error');
        return;
    }

    btn.disabled = true;
    showFetchStatus('Fetching listing data...', 'loading');

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30000);

    try {
        const resp = await fetch('/api/listings/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ url: resolvedUrl }),
        });

        const data = await resp.json();

        if (!resp.ok) {
            showFetchStatus(data.error || 'Failed to fetch listing.', 'error');
            return;
        }

        populateFromListing(data);
        const gotSomething = data.price || data.listedPrice || data.address || data.squareFeet;
        if (gotSomething) {
            showFetchStatus('✓ Listing imported — review and fill any highlighted fields.', 'success');
        } else {
            showFetchStatus('Could not extract data from that listing (site may block automated access). Try the 📄 document upload, or enter details manually.', 'error');
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            showFetchStatus('Request timed out — try the document upload instead, or enter details manually.', 'error');
        } else {
            showFetchStatus('Could not reach that listing — the site may be blocking automated access. Try the 📄 document upload or enter details manually.', 'error');
        }
    } finally {
        window.clearTimeout(timeoutId);
        btn.disabled = false;
    }
}

// ════════════════════════════════════════════════
//  EVENT LISTENERS (all wired via addEventListener)
// ════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Panel collapse/expand
    document.querySelectorAll('[data-action="toggle-panel"]').forEach(btn => {
        btn.addEventListener('click', () => togglePanel(btn));
    });

    // Analyze button
    document.getElementById('analyzeBtn').addEventListener('click', analyzeProperty);

    // Property type → smart defaults
    document.getElementById('propertyType').addEventListener('change', applySmartDefaults);

    // Listed price → down payment hint + furnishing placeholder
    document.getElementById('listedPrice').addEventListener('input', () => {
        updateDownPaymentHint();
        updateFurnishingPlaceholder();
        updateRequiredFieldHighlights();
        // Auto-run full opex estimate when price changes (drives insurance + maintenance)
        const newTotal = estimateOpex();
        if (newTotal > 0) setCurrencyVal('operatingExpenses', newTotal);
    });

    // All sliders with data-input attribute → syncSlider
    document.querySelectorAll('.field-slider[data-input]').forEach(slider => {
        slider.addEventListener('input', () => {
            syncSlider(slider);
            // Update hotel revenue display when occupancy changes
            if (slider.dataset.input === 'occupancyRate' && document.getElementById('propertyType').value === 'hotel') {
                updateHotelRevenueDisplay();
                updateExpenseRatioOpex(); // CHANGE 4 Fix E
            }
            // Mirror interest rate → refi rate for STR (if refi rate hasn't been manually changed)
            if (slider.dataset.input === 'interestRate' && document.getElementById('propertyType').value === 'str') {
                const rate = parseFloat(slider.value);
                setSliderValue('refiRate', rate);
            }
            // Update refi cash out any time relevant sliders change
            if (['downPayment','interestRate','refiLTV','refiRate'].includes(slider.dataset.input)) {
                updateRefiCashOut();
            }
            // Update monthly mortgage display when down payment or rate changes
            if (['downPayment','interestRate'].includes(slider.dataset.input)) {
                updateMonthlyMortgageDisplay();
                // Also re-estimate opex (mgmt fee + insurance driven by price/revenue)
                const t = estimateOpex();
                if (t > 0) setCurrencyVal('operatingExpenses', t);
            }
        });
    });

    // Annual revenue input → update ADR hint + auto-estimate opex (mgmt fee is % of revenue)
    document.getElementById('annualRevenueInput').addEventListener('input', () => {
        const rev = getVal('annualRevenueInput');
        const occ = getVal('occupancyRate', 65) / 100;
        const keys = getVal('numKeys', 1);
        const nights = occ * 365 * keys;
        const hint = document.getElementById('annualRevenueHint');
        if (rev > 0 && nights > 0) {
            const computedADR = Math.round(rev / nights);
            hint.textContent = `Implied ADR: $${computedADR}/night`;
        } else {
            hint.textContent = 'ADR will be calculated from revenue, occupancy, and keys';
        }
        updateRequiredFieldHighlights();
        // Auto-populate opex (management fee is driven by revenue)
        if (document.getElementById('propertyType').value === 'str') {
            const t = estimateOpex();
            setCurrencyVal('operatingExpenses', t || 0);
        }
    });

    // Expense ratio slider (hotel)
    document.getElementById('expenseRatioSlider').addEventListener('input', updateExpenseRatioOpex);

    // Hotel revenue display: update when ADR, occupancy, or keys change
    ['adr', 'numKeys'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
            if (document.getElementById('propertyType').value === 'hotel') {
                updateHotelRevenueDisplay();
                updateExpenseRatioOpex(); // CHANGE 4 Fix D
            }
            updateRequiredFieldHighlights();
        });
    });

    // Per-key renovation slider (hotel) — now a real slider in hotelRenoBudgetGroup
    document.getElementById('perKeyRenoSlider')?.addEventListener('input', updatePerKeyReno);
    document.getElementById('contingencySlider')?.addEventListener('input', updateContingency);
    // When numKeys changes, update per-key reno total if hotel
    document.getElementById('numKeys').addEventListener('input', () => {
        if (document.getElementById('propertyType').value === 'hotel') {
            updatePerKeyReno();
        }
    });

    // Refi toggle
    document.getElementById('refiToggle').addEventListener('change', toggleRefiInputs);

    // Listing import
    document.getElementById('fetchListingBtn').addEventListener('click', fetchListingData);
    document.getElementById('listingUrl').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchListingData();
    });

    // Prevent scroll-to-change on number inputs
    document.querySelectorAll('input[type="number"]').forEach(el => {
        el.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    });

    // Auto-format currency inputs with commas
    document.querySelectorAll('[data-currency]').forEach(el => setupCurrencyInput(el));
    ['operatingExpenses', 'renovationBudget', 'furnishingBudget'].forEach((id) => {
        document.getElementById(id)?.addEventListener('input', updateRequiredFieldHighlights);
    });

    // Square footage — auto-update reno/furnish estimates + opex (utilities driven by sqft)
    document.getElementById('squareFeet')?.addEventListener('input', () => {
        updateRenoEstimate();
        updateFurnishEstimate();
        if (document.getElementById('propertyType').value === 'str') {
            const t = estimateOpex();
            setCurrencyVal('operatingExpenses', t || 0);
        }
    });

    // Bedrooms/bathrooms — affects reno amenity totals
    ['bedrooms', 'bathrooms'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', () => updateRenoEstimate());
    });

    // Reno/furnish override fields — when user types a custom dollar amount
    document.getElementById('renoOverrideInput')?.addEventListener('input', () => {
        const val = parseCurrency(document.getElementById('renoOverrideInput').value);
        document.getElementById('renovationBudgetComputed').value = val;
        // Deactivate level buttons visually
        document.querySelectorAll('.reno-lvl-btn').forEach(b => {
            b.style.borderColor = '#2a2a3a'; b.style.background = '#1a1a26';
            b.style.color = '#9ca3af'; b.style.fontWeight = '500';
        });
        RENO_LEVEL = 'custom';
        recalc();
    });
    document.getElementById('furnishOverrideInput')?.addEventListener('input', () => {
        const val = parseCurrency(document.getElementById('furnishOverrideInput').value);
        document.getElementById('furnishingBudgetComputed').value = val;
        document.querySelectorAll('.furnish-lvl-btn').forEach(b => {
            b.style.borderColor = '#2a2a3a'; b.style.background = '#1a1a26';
            b.style.color = '#9ca3af'; b.style.fontWeight = '500';
        });
        FURNISH_LEVEL = 'custom';
        recalc();
    });

    // CHANGE 2: Hotel reno override input — reverse-calculate per-key from total
    document.getElementById('hotelRenoOverrideInput')?.addEventListener('input', () => {
        const total = parseCurrency(document.getElementById('hotelRenoOverrideInput').value);
        const numKeys = getVal('numKeys', 10);
        const perKey = numKeys > 0 ? Math.round(total / numKeys / 1000) * 1000 : 0;
        const slider = document.getElementById('perKeyRenoSlider');
        if (slider) slider.value = Math.min(100000, perKey);
        const valueDisplay = document.getElementById('perKeyRenoValue');
        if (valueDisplay) valueDisplay.textContent = '$' + Math.round(perKey / 1000) + 'K';
        const hint = document.getElementById('perKeyRenoHint');
        if (hint) hint.textContent = `Total: ${formatCurrency(total)} (${numKeys} keys × ${formatCurrency(perKey)})`;
        setCurrencyVal('renovationBudget', total);
        updateRequiredFieldHighlights();
        recalc();
    });

    // Initialize
    applySmartDefaults();
    updateDownPaymentHint();
    updateRequiredFieldHighlights();

    // Auth & gating
    initGating();
});

// ── Renovation Budget ─────────────────────────────────────────────────────────
let RENO_LEVEL = 'mid';
const RENO_RATES = { none: 0, low: 25, mid: 55, high: 100 }; // $/sqft
// Amenity defaults (user can override inline in the modal)
const RENO_AMENITY_DEFAULTS = { kitchen: 25000, bath: 8000, hottub: 6000, pool: 35000, plunge: 8000, sauna: 8000, deck: 12000, roof: 15000, luxury: 15000 };
const getAmenityAmt = key => parseFloat(document.getElementById(`rc_${key}_amt`)?.value || RENO_AMENITY_DEFAULTS[key] || 0);

function setRenoLevel(level) {
    RENO_LEVEL = level;
    document.querySelectorAll('.reno-lvl-btn').forEach(b => {
        const active = b.dataset.level === level;
        b.style.borderColor = active ? '#6c63ff' : '#2a2a3a';
        b.style.background = active ? 'rgba(108,99,255,0.15)' : '#1a1a26';
        b.style.color = active ? '#a89fff' : '#9ca3af';
        b.style.fontWeight = active ? '600' : '500';
    });
    if (level !== 'custom') updateRenoEstimate();
    else syncRenoComputed();
}

function getRenoAmenityTotal() {
    let total = 0;
    const baths = parseInt(document.getElementById('bathrooms')?.value || 1);
    const chk = id => document.getElementById(id)?.checked;
    if (chk('rc_kitchen')) total += getAmenityAmt('kitchen');
    if (chk('rc_bath'))    total += getAmenityAmt('bath') * Math.max(1, baths);
    if (chk('rc_hottub'))  total += getAmenityAmt('hottub');
    if (chk('rc_pool'))    total += getAmenityAmt('pool');
    if (chk('rc_plunge'))  total += getAmenityAmt('plunge');
    if (chk('rc_sauna'))   total += getAmenityAmt('sauna');
    if (chk('rc_deck'))    total += getAmenityAmt('deck');
    if (chk('rc_roof'))    total += getAmenityAmt('roof');
    if (chk('rc_luxury'))  total += getAmenityAmt('luxury');
    return total;
}

function updateRenoEstimate() {
    if (RENO_LEVEL === 'custom') { syncRenoComputed(); return; }
    const sqft = parseInt(document.getElementById('squareFeet')?.value || 0);
    const rate = RENO_RATES[RENO_LEVEL] || 0;
    const base = sqft > 0 ? sqft * rate : 0;
    const amenities = getRenoAmenityTotal();
    const total = base + amenities;
    const label = document.getElementById('renoEstimateLabel');
    if (label) label.textContent = '~' + fmtCurrency(total);
    const amenityTotal = document.getElementById('renoAmenityTotal');
    if (amenityTotal) amenityTotal.textContent = fmtCurrency(amenities);
    const computed = document.getElementById('renovationBudgetComputed');
    if (computed) computed.value = total;
    // Sync override display field
    const overrideEl = document.getElementById('renoOverrideInput');
    if (overrideEl && RENO_LEVEL !== 'custom') overrideEl.value = total > 0 ? total : '';
    syncRenoComputed();
}

function syncRenoComputed() {
    // Keep hidden computed field in sync with renovationBudget for calc engine
    if (RENO_LEVEL === 'manual') {
        const manualVal = parseCurrency(document.getElementById('renovationBudget')?.value || '0');
        document.getElementById('renovationBudgetComputed').value = manualVal;
    }
    updateRefiCashOut();
    recalc();
}

// ── Deals — Save / Load / My Deals ───────────────────────────────────────────
let _lastRenderPayload = null;   // populated after every Analyze
let _currentDealId = null;       // set when a saved deal is loaded
let _allDeals = [];              // cached deals list

async function _getSession() {
    try {
        // auth.js exposes getBrowserSession()
        const session = typeof getBrowserSession === 'function' ? await getBrowserSession() : null;
        return session;
    } catch { return null; }
}

function openSaveDeal() {
    if (!_lastRenderPayload) {
        alert('Analyze a deal first before saving.');
        return;
    }
    const modal = document.getElementById('saveDealModal');
    modal.style.display = 'flex';
    // Pre-fill name from address
    const addr = document.getElementById('propertyAddress')?.value || '';
    const nameEl = document.getElementById('saveDealName');
    if (!nameEl.value) nameEl.value = addr || '';
    if (_currentDealId) {
        document.getElementById('saveDealTitle').textContent = 'Update Deal';
    }
    // Load existing deals for variant picker
    loadDealsForVariantPicker();
}

function closeSaveDeal() {
    document.getElementById('saveDealModal').style.display = 'none';
    document.getElementById('saveDealMsg').textContent = '';
}

async function loadDealsForVariantPicker() {
    const session = await _getSession();
    if (!session) return;
    try {
        const r = await fetch('/api/deals', { headers: { Authorization: `Bearer ${session.access_token}` } });
        const deals = await r.json();
        _allDeals = Array.isArray(deals) ? deals : [];
        const sel = document.getElementById('variantParentId');
        sel.innerHTML = _allDeals.map(d => `<option value="${d.id}">${d.name || d.title || d.property_address}</option>`).join('');
    } catch {}
}

document.getElementById('saveAsVariant')?.addEventListener('change', function() {
    document.getElementById('variantParentRow').style.display = this.checked ? 'block' : 'none';
});

async function saveDeal() {
    const btn = document.getElementById('saveDealConfirmBtn');
    const msg = document.getElementById('saveDealMsg');
    btn.disabled = true; btn.textContent = 'Saving...';
    msg.textContent = '';

    const session = await _getSession();
    if (!session) {
        msg.style.color = '#f87171';
        msg.textContent = 'Sign in to save deals.';
        btn.disabled = false; btn.textContent = 'Save Deal';
        return;
    }

    const r = _lastRenderPayload;
    const coc = r.stabilityResult?.coc ?? (r.totalEquity > 0 ? (r.annualCashFlow / r.totalEquity) * 100 : 0);
    const isVariant = document.getElementById('saveAsVariant')?.checked;

    const payload = {
        id: _currentDealId || undefined,
        user_id: session.user.id,
        name: document.getElementById('saveDealName').value.trim() || r.inputs?.address || 'Untitled Deal',
        address: document.getElementById('propertyAddress')?.value || '',
        property_type: r.inputs?.propertyType || 'str',
        status: document.getElementById('saveDealStatus').value,
        notes: document.getElementById('saveDealNotes').value.trim(),
        velocity_score: r.totalScore,
        listed_price: r.inputs?.listedPrice || 0,
        equity_multiple: r.equityMultiple,
        irr: r.irr,
        coc,
        moic: r.moic,
        total_equity: r.totalEquity,
        annual_cash_flow: r.annualCashFlow,
        variant_of: isVariant ? (document.getElementById('variantParentId')?.value || null) : null,
        variant_name: isVariant ? (document.getElementById('variantName')?.value.trim() || null) : null,
        is_base_case: !isVariant,
        inputs: gatherAllInputs(),
        outputs: {
            totalScore: r.totalScore,
            equityScore: r.equityScore,
            speedScore: r.speedScore,
            taxScore: r.taxScore,
            stabilityScore: r.stabilityScore,
            moic: r.moic,
            irr: r.irr,
            coc,
            equityMultiple: r.equityMultiple,
            totalRevenue: r.totalRevenue,
            annualOpex: r.annualOpex,
            noi: r.noi,
            annualCashFlow: r.annualCashFlow,
            totalEquity: r.totalEquity,
            dscr: r.dscr,
        },
    };

    try {
        const resp = await fetch('/api/deals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (resp.ok || resp.status === 201) {
            const saved = Array.isArray(data) ? data[0] : data;
            _currentDealId = saved?.id || _currentDealId;
            msg.style.color = '#34d399';
            msg.textContent = '✓ Deal saved!';
            document.getElementById('saveDealBtn').textContent = '✓ Saved';
            setTimeout(closeSaveDeal, 1200);
        } else {
            throw new Error(JSON.stringify(data));
        }
    } catch (err) {
        msg.style.color = '#f87171';
        msg.textContent = 'Save failed: ' + err.message;
    }
    btn.disabled = false; btn.textContent = 'Save Deal';
}

function gatherAllInputs() {
    const inputs = {};
    document.querySelectorAll('[id]').forEach(el => {
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
            if (el.type === 'checkbox') inputs[el.id] = el.checked;
            else if (el.type !== 'hidden' || el.id.endsWith('Computed')) inputs[el.id] = el.value;
        }
    });
    return inputs;
}

// ── My Deals Modal ──────────────────────────────────────────────────────────
async function openMyDeals() {
    document.getElementById('myDealsModal').style.display = 'flex';
    await refreshDealsList();
}

function closeMyDeals() {
    document.getElementById('myDealsModal').style.display = 'none';
}

async function refreshDealsList() {
    const container = document.getElementById('dealsListContainer');
    container.innerHTML = '<p style="color:#6b7280;font-size:13px;text-align:center;padding:20px">Loading...</p>';
    const session = await _getSession();
    if (!session) {
        container.innerHTML = '<p style="color:#f87171;font-size:13px;text-align:center;padding:20px">Sign in to view saved deals.</p>';
        return;
    }
    try {
        const r = await fetch('/api/deals', { headers: { Authorization: `Bearer ${session.access_token}` } });
        _allDeals = await r.json();
        filterDeals();
    } catch (err) {
        container.innerHTML = `<p style="color:#f87171;font-size:13px;text-align:center;padding:20px">Error: ${err.message}</p>`;
    }
}

function filterDeals() {
    const container = document.getElementById('dealsListContainer');
    const statusFilter = document.getElementById('dealsFilterStatus')?.value || '';
    let deals = Array.isArray(_allDeals) ? _allDeals : [];
    if (statusFilter) deals = deals.filter(d => (d.result_snapshot?.status || d.status || 'analyzing') === statusFilter);

    if (!deals.length) {
        container.innerHTML = '<p style="color:#6b7280;font-size:13px;text-align:center;padding:30px">No deals saved yet. Analyze a deal and click Save Deal.</p>';
        return;
    }

    const STATUS_LABELS = { analyzing: '🔍 Analyzing', active: '✅ Active', under_contract: '🤝 Under Contract', closed: '🏆 Closed', passed: '❌ Passed' };
    const SCORE_COLOR = s => s >= 80 ? '#10b981' : s >= 60 ? '#3b82f6' : s >= 40 ? '#f59e0b' : '#ef4444';

    // Group base cases and their variants
    const bases = deals.filter(d => !(d.result_snapshot?.variant_of));
    const variantMap = {};
    deals.filter(d => d.result_snapshot?.variant_of).forEach(v => {
        const pid = v.result_snapshot.variant_of;
        if (!variantMap[pid]) variantMap[pid] = [];
        variantMap[pid].push(v);
    });

    container.innerHTML = bases.map(deal => {
        const rs = deal.result_snapshot || {};
        const score = deal.velocity_score || rs.totalScore || 0;
        const status = rs.status || 'analyzing';
        const coc = rs.coc ? rs.coc.toFixed(1) + '%' : '--';
        const irr = deal.irr ? (deal.irr * 100).toFixed(1) + '%' : '--';
        const em = rs.equity_multiple ? rs.equity_multiple.toFixed(2) + 'x' : '--';
        const price = deal.listed_price ? '$' + (deal.listed_price/1000).toFixed(0) + 'k' : '--';
        const date = new Date(deal.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const variants = variantMap[deal.id] || [];

        return `
        <div style="border:1px solid #2a2a3a;border-radius:10px;padding:14px 16px;margin-bottom:10px;background:#0f0f18">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span style="font-weight:700;font-size:14px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">${deal.title || deal.name || 'Untitled'}</span>
                <span style="font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(108,99,255,0.15);color:#a89fff">${(deal.property_type || 'STR').toUpperCase()}</span>
                <span style="font-size:11px;color:#6b7280">${STATUS_LABELS[status] || status}</span>
              </div>
              <div style="display:flex;gap:14px;margin-top:8px;flex-wrap:wrap">
                <span style="font-size:12px;color:#9ca3af">Score: <strong style="color:${SCORE_COLOR(score)}">${score}</strong></span>
                <span style="font-size:12px;color:#9ca3af">CoC: <strong style="color:#fff">${coc}</strong></span>
                <span style="font-size:12px;color:#9ca3af">IRR: <strong style="color:#3b82f6">${irr}</strong></span>
                <span style="font-size:12px;color:#9ca3af">Equity: <strong style="color:#10b981">${em}</strong></span>
                <span style="font-size:12px;color:#9ca3af">Ask: <strong style="color:#fff">${price}</strong></span>
                <span style="font-size:12px;color:#6b7280">${date}</span>
              </div>
              ${rs.notes ? `<p style="font-size:11px;color:#6b7280;margin-top:6px;font-style:italic">${rs.notes}</p>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
              <button onclick="loadDeal('${deal.id}')" style="padding:6px 12px;background:#6c63ff;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">Load</button>
              <button onclick="saveVariantOf('${deal.id}','${(deal.title||'').replace(/'/g,"\\'")}'); closeMyDeals();" style="padding:6px 12px;background:#1a1a26;color:#9ca3af;border:1px solid #2a2a3a;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap">+ Variant</button>
              <button onclick="deleteDeal('${deal.id}')" style="padding:5px 10px;background:none;color:#6b7280;border:1px solid #2a2a3a;border-radius:6px;font-size:11px;cursor:pointer">Delete</button>
            </div>
          </div>
          ${variants.length ? `
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid #1e1e2e">
            <span style="font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Variants</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
              ${variants.map(v => `
                <button onclick="loadDeal('${v.id}')" style="padding:4px 10px;background:#1a1a26;color:#a89fff;border:1px solid rgba(108,99,255,0.3);border-radius:5px;font-size:11px;cursor:pointer">
                  ${v.result_snapshot?.variant_name || v.title || 'Variant'} · ${(v.result_snapshot?.coc||0).toFixed(1)}% CoC
                </button>
              `).join('')}
            </div>
          </div>` : ''}
        </div>`;
    }).join('');
}

async function loadDeal(id) {
    closeMyDeals();
    const session = await _getSession();

    // Try cache first, then fetch full deal from load endpoint
    let inputs = _allDeals.find(d => d.id === id)?.input_snapshot || null;
    if (!inputs) {
        try {
            const r = await fetch(`/api/deals/load?id=${id}`, {
                headers: session ? { Authorization: `Bearer ${session.access_token}` } : {}
            });
            const deal = await r.json();
            inputs = deal?.inputs || null;
        } catch { inputs = null; }
    }

    if (!inputs) return alert('Could not load deal — no inputs saved.');

    // Restore inputs from snapshot
    if (typeof inputs === 'object') {
        Object.entries(inputs).forEach(([key, val]) => {
            const el = document.getElementById(key);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = !!val;
            else el.value = val ?? '';
        });
    }

    _currentDealId = id;
    document.getElementById('saveDealBtn').textContent = '💾 Update Deal';

    // Re-run analysis
    document.getElementById('analyzeBtn')?.click();
}

function saveVariantOf(parentId, parentName) {
    openSaveDeal();
    document.getElementById('saveAsVariant').checked = true;
    document.getElementById('variantParentRow').style.display = 'block';
    document.getElementById('saveDealName').value = parentName + ' — Variant';
    // Pre-select parent in dropdown
    setTimeout(() => {
        const sel = document.getElementById('variantParentId');
        if (sel) sel.value = parentId;
    }, 300);
}

async function deleteDeal(id) {
    if (!confirm('Delete this deal?')) return;
    const session = await _getSession();
    if (!session) return;
    await fetch(`/api/deals?id=${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
    });
    await refreshDealsList();
}

function toggleMethodology() {
    const body = document.getElementById('methodologyBody');
    const chevron = document.getElementById('methodologyChevron');
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    if (chevron) chevron.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
}

function openRenoChecklist() {
    const el = document.getElementById('renoChecklistModal');
    if (el) { el.style.display = 'flex'; updateRenoEstimate(); }
}
function closeRenoChecklist() {
    const el = document.getElementById('renoChecklistModal');
    if (el) el.style.display = 'none';
    updateRenoEstimate();
}

// ── Furnishing Budget ─────────────────────────────────────────────────────────
let FURNISH_LEVEL = 'mid';
const FURNISH_RATES = { low: 15, mid: 25, high: 35 };

function setFurnishLevel(level) {
    FURNISH_LEVEL = level;
    document.querySelectorAll('.furnish-lvl-btn').forEach(b => {
        const active = b.dataset.level === level;
        b.style.borderColor = active ? '#6c63ff' : '#2a2a3a';
        b.style.background = active ? 'rgba(108,99,255,0.15)' : '#1a1a26';
        b.style.color = active ? '#a89fff' : '#9ca3af';
        b.style.fontWeight = active ? '600' : '500';
    });
    if (level !== 'custom') updateFurnishEstimate();
    else syncFurnishComputed();
}

function updateFurnishEstimate() {
    if (FURNISH_LEVEL === 'custom') { syncFurnishComputed(); return; }
    const sqft = parseInt(document.getElementById('squareFeet')?.value || 0);
    const rate = FURNISH_RATES[FURNISH_LEVEL] || 25;
    const total = sqft > 0 ? sqft * rate : 0;
    const label = document.getElementById('furnishEstimateLabel');
    if (label) label.textContent = sqft > 0 ? `$${rate}/sqft` : 'enter sq ft above';
    const computed = document.getElementById('furnishingBudgetComputed');
    if (computed) computed.value = total;
    // Sync override display field
    const overrideEl = document.getElementById('furnishOverrideInput');
    if (overrideEl && FURNISH_LEVEL !== 'custom') overrideEl.value = total > 0 ? total : '';
    syncFurnishComputed();
}

function syncFurnishComputed() {
    // Nothing extra needed — furnishingBudgetComputed is already kept in sync
    recalc();
}

// ── Refi Cash Out ─────────────────────────────────────────────────────────────
function updateRefiCashOut() {
    const refiOn = document.getElementById('refiToggle')?.checked;
    const display = document.getElementById('refiCashOutDisplay');
    if (!display) return;
    if (!refiOn) return;
    const arv = parseCurrency(document.getElementById('arv')?.value || '0') ||
                parseCurrency(document.getElementById('listedPrice')?.value || '0');
    const ltv = getVal('refiLTV', 75) / 100;
    const listedPrice = parseCurrency(document.getElementById('listedPrice')?.value || '0');
    const downPct = getVal('downPayment', 20) / 100;
    const originalLoan = listedPrice * (1 - downPct);
    const refiLoanAmt = arv * ltv;
    const cashOut = refiLoanAmt - originalLoan;
    display.textContent = cashOut > 0 ? fmtCurrency(cashOut) : '$0 (no equity yet)';
    display.style.color = cashOut > 0 ? '#a89fff' : '#6b7280';
}

// ── Fixed Expenses Estimator ──────────────────────────────────────────────────
const SNOW_ZIPS = ['80','81','82','83','84','85960','85961','85962','96150','96151','96152','96153','96154','96155','96156','96157','96158']; // mountain/north prefix

function isSnowZip(address) {
    const snowStates = /\b(MT|ID|WY|CO|UT|VT|NH|ME|MN|WI|MI|ND|SD|AK|WA|OR)\b/i;
    const tahoeArea = /tahoe|mammoth|truckee|reno|incline/i;
    return snowStates.test(address) || tahoeArea.test(address);
}

function estimateOpex() {
    // Hotel uses expense ratio slider, not this estimator
    const type = document.getElementById('propertyType')?.value;
    if (type === 'hotel') return 0;
    const address = document.getElementById('propertyAddress')?.value || '';
    const annualRev = parseCurrency(document.getElementById('annualRevenueInput')?.value || '0');
    const sqft = parseInt(document.getElementById('squareFeet')?.value || 0);
    const price = parseCurrency(document.getElementById('listedPrice')?.value || '0');

    const mgmt        = Math.round(annualRev * 0.20 / 12);
    const insurance   = Math.round(Math.max(150, price * 0.001 / 12));
    const internet    = 100;
    const utilities   = sqft > 0 ? Math.round(Math.max(150, sqft * 0.12)) : 200;
    const landscaping = 150;
    const pest        = 50;
    const snow        = isSnowZip(address) ? 200 : 0;
    const maint       = Math.round(Math.max(100, price * 0.005 / 12));
    const propTax     = price > 0 ? Math.round(price * 0.011 / 12) : 0; // ~1.1% annually

    // Update detail modal
    const fmt = v => v > 0 ? `$${v.toLocaleString()}/mo` : '—';
    document.getElementById('opex_mgmt').textContent = fmt(mgmt);
    document.getElementById('opex_insurance').textContent = fmt(insurance);
    document.getElementById('opex_internet').textContent = fmt(internet);
    document.getElementById('opex_utilities').textContent = fmt(utilities);
    document.getElementById('opex_landscaping').textContent = fmt(landscaping);
    document.getElementById('opex_pest').textContent = fmt(pest);
    const snowRow = document.getElementById('opex_snow_row');
    if (snowRow) snowRow.style.display = snow > 0 ? 'flex' : 'none';
    document.getElementById('opex_snow').textContent = fmt(snow);
    document.getElementById('opex_maint').textContent = fmt(maint);
    const taxEl = document.getElementById('opex_tax');
    if (taxEl) taxEl.textContent = fmt(propTax);

    const total = mgmt + insurance + internet + utilities + landscaping + pest + snow + maint + propTax;
    document.getElementById('opex_total_display').textContent = `$${total.toLocaleString()}/mo`;
    return total;
}

function openOpexDetail() {
    const total = estimateOpex();
    // Always apply immediately — no extra click required
    setCurrencyVal('operatingExpenses', total || 0);
    recalc();
    const el = document.getElementById('opexDetailModal');
    if (el) el.style.display = 'flex';
}
function closeOpexDetail() {
    const el = document.getElementById('opexDetailModal');
    if (el) el.style.display = 'none';
}
function applyOpexEstimate() {
    // Re-calculate and apply (used when user adjusts values inside the modal)
    const total = estimateOpex();
    setCurrencyVal('operatingExpenses', total || 0);
    recalc();
}
function onAddressChange() {
    // Auto-estimate opex any time address changes (snow zone detection)
    if (document.getElementById('propertyType').value === 'str') {
        const t = estimateOpex();
        setCurrencyVal('operatingExpenses', t || 0);
    }
}

// ── Revenue Sync (Annual Revenue ↔ ADR ↔ Occupancy) ──────────────────────────
let _revenueSource = 'revenue'; // 'revenue' | 'adr'

function _syncADRFromRevenue() {
    const rev = parseCurrency(document.getElementById('annualRevenueInput')?.value || '0');
    const occ = getVal('occupancyRate', 65) / 100;
    const adrEl = document.getElementById('adr');
    if (rev > 0 && occ > 0 && adrEl) {
        adrEl.value = Math.round(rev / (occ * 365));
    }
}

function onAnnualRevenueChange() {
    _revenueSource = 'revenue';
    _syncADRFromRevenue();
    updateRequiredFieldHighlights();
    // Auto-update opex estimate (management fee is % of revenue)
    if (document.getElementById('propertyType').value === 'str') {
        const t = estimateOpex();
        setCurrencyVal('operatingExpenses', t || 0);
    }
    recalc();
}

function onADRChange() {
    _revenueSource = 'adr';
    const adr = parseFloat(document.getElementById('adr')?.value || 0);
    const occ = getVal('occupancyRate', 65) / 100;
    if (adr > 0 && occ > 0) {
        const impliedRev = Math.round(adr * occ * 365);
        const revEl = document.getElementById('annualRevenueInput');
        if (revEl) {
            revEl.value = impliedRev.toLocaleString();
        }
    }
    updateRequiredFieldHighlights();
    recalc();
}

function onOccupancyChange() {
    // Always re-derive ADR from revenue when occupancy moves
    _syncADRFromRevenue();
    updateRequiredFieldHighlights();
    recalc();
}

// ── Additional Unit ───────────────────────────────────────────────────────────
function toggleAdditionalUnit() {
    const checked = document.getElementById('additionalUnitToggle')?.checked;
    const inputs = document.getElementById('additionalUnitInputs');
    if (inputs) inputs.style.display = checked ? 'block' : 'none';
    recalc();
}

// ── Combined paste/drop zone helpers ────────────────────────────────────────
function updateCombinedZone(textarea) {
    const btn = document.getElementById('extractPasteBtn');
    if (!btn) return;
    const hasText = textarea.value.trim().length > 10;
    btn.style.opacity = hasText ? '1' : '0.4';
    btn.style.pointerEvents = hasText ? 'auto' : 'none';
}

// no-op kept for any lingering references
function setImportTab() {}

// ── Paste Listing Text Extraction ────────────────────────────────────────────
async function extractFromPastedText() {
    const text = document.getElementById('listingPasteText')?.value?.trim();
    if (!text || text.length < 20) {
        showFetchStatus('Paste some listing text first.', 'error');
        return;
    }
    const btn = document.getElementById('extractPasteBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }
    showFetchStatus('Extracting property details…', 'loading');
    try {
        const resp = await fetch('/api/extract-doc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, filename: 'listing-paste' }),
        });
        const result = await resp.json();
        if (!resp.ok || result.error) {
            showFetchStatus(result.error || 'Extraction failed.', 'error');
            return;
        }
        populateFromDoc(result.data);
        const got = result.data?.address || result.data?.listedPrice || result.data?.squareFeet;
        if (got) {
            showFetchStatus('✓ Property details extracted — review highlighted fields.', 'success');
            document.getElementById('listingPasteText').value = '';
        } else {
            showFetchStatus('Could not find property details in that text. Try including more of the listing.', 'error');
        }
    } catch (err) {
        showFetchStatus('Extraction failed: ' + err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Extract Property Details'; }
    }
}

// ── Document Upload & AI Extraction ─────────────────────────────────────────
async function handleDocDrop(file) { if (file) handleDocFile(file); }

async function handleDocFile(file) {
  if (!file) return;
  const zone = document.getElementById('docDropZone');
  const status = document.getElementById('fetchStatus');

  const showStatus = (msg, type) => {
    if (!status) return;
    status.textContent = msg;
    status.className = `text-xs mt-3 ${type === 'error' ? 'text-red-400' : type === 'success' ? 'text-emerald-400' : 'text-blue-400'}`;
    status.classList.remove('hidden');
  };

  showStatus(`Reading ${file.name}…`, 'loading');
  if (zone) zone.querySelector('div:nth-child(2)').textContent = `📄 ${file.name}`;

  let text = '';
  try {
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      text = await extractPdfText(file);
    } else {
      text = await file.text();
    }
  } catch (err) {
    showStatus('Could not read file: ' + err.message, 'error');
    return;
  }

  if (!text || text.length < 30) {
    showStatus('File appears empty or unreadable.', 'error');
    return;
  }

  showStatus('Extracting property details with AI…', 'loading');
  try {
    const resp = await fetch('/api/extract-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, filename: file.name }),
    });
    const result = await resp.json();
    if (!resp.ok || result.error) {
      showStatus(result.error || 'Extraction failed.', 'error');
      return;
    }
    populateFromDoc(result.data);
    showStatus(`✓ Filled from ${file.name}`, 'success');
  } catch (err) {
    showStatus('Connection error: ' + err.message, 'error');
  }
}

async function extractPdfText(file) {
  // Use PDF.js if available, otherwise read as text
  if (window.pdfjsLib) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 15); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(' ') + '\n';
    }
    return text;
  }
  // Fallback: try reading as text (works for text-based PDFs sometimes)
  return await file.text();
}

function populateFromDoc(data) {
  if (!data) return;

  // Helper: set value + fire input event
  const set = (id, val) => {
    if (val === null || val === undefined) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Property type first — so applySmartDefaults uses correct type
  if (data.propertyType) {
    const raw = data.propertyType.toLowerCase().trim();
    const hotelKw = ['hotel', 'motel', 'inn', 'resort', 'lodge', 'hospitality', 'b&b', 'bed and breakfast'];
    const typeVal = hotelKw.some(k => raw.includes(k)) ? 'hotel' : 'str';
    const el = document.getElementById('propertyType');
    if (el) { el.value = typeVal; }
  }
  applySmartDefaults();   // apply defaults for detected type BEFORE overriding with listing data

  // Core fields
  if (data.address)      set('propertyAddress', data.address);
  if (data.listedPrice)  setCurrencyVal('listedPrice', data.listedPrice);
  if (data.squareFeet)   set('squareFeet', data.squareFeet);
  if (data.bedrooms)     set('bedrooms', data.bedrooms);
  if (data.bathrooms)    set('bathrooms', data.bathrooms);
  if (data.yearBuilt)    set('yearBuilt', data.yearBuilt);

  // Revenue
  if (data.annualRevenue) {
    const el = document.getElementById('annualRevenueInput');
    if (el) {
      el.value = Number(data.annualRevenue).toLocaleString();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  if (data.adr)          set('adr', data.adr);
  if (data.occupancyRate) set('occupancyRate', data.occupancyRate > 1 ? data.occupancyRate : Math.round(data.occupancyRate * 100));
  if (data.numberOfUnits) set('numKeys', data.numberOfUnits);

  // Expenses (only override if explicitly provided; don't stomp defaults)
  if (data.operatingExpenses) setCurrencyVal('operatingExpenses', data.operatingExpenses);
  if (data.propertyTax)       setCurrencyVal('propertyTax', data.propertyTax);
  if (data.hoaFees)           setCurrencyVal('hoaFees', data.hoaFees);

  // Update reno/furnish estimates now that sqft is populated
  updateRenoEstimate();
  updateFurnishEstimate();
  updateRequiredFieldHighlights();
  updateRefiCashOut();
}

// ── Expose functions needed by inline HTML onclick handlers ──────────────────
// app.js loads as type="module" so functions aren't global by default.
Object.assign(window, {
  openModal,
  setAuthMode,
  setImportTab,
  extractFromPastedText,
  updateCombinedZone,
  setRenoLevel,
  setFurnishLevel,
  openRenoChecklist,
  closeRenoChecklist,
  openOpexDetail,
  closeOpexDetail,
  applyOpexEstimate,
  openSaveDeal,
  closeSaveDeal,
  saveDeal,
  openMyDeals,
  closeMyDeals,
  loadDeal,
  toggleMethodology,
  // Revenue sync handlers (called from inline oninput= attributes)
  onAnnualRevenueChange,
  onADRChange,
  onOccupancyChange,
  onAddressChange,
  toggleAdditionalUnit,
  filterDeals,
  handleDocFile,
  updateRenoEstimate,
  updateRefiCashOut,
  recalc,
});
