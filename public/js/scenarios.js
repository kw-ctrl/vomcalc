/**
 * Scenario builder, buy box solver, deal lever analysis
 */

import { calculateMortgage, formatCurrency } from './utils.js';
import {
    calculateAnnualCashFlows, calculateMOIC, calculateIRR,
    calculateStabilizedValue
} from './calculations.js';

// ════════════════════════════════════════════════
//  BUY BOX SOLVER
// ════════════════════════════════════════════════

export function buildInputsAtPrice(baseInputs, price) {
    const downPayment = price * baseInputs.downPct;
    const loanAmount = price - downPayment;
    const closingCosts = price * baseInputs.closingCostsPct;
    const totalRenoBudget = baseInputs.totalRenoBudget || baseInputs.renovationBudget;
    const furnishingBudget = baseInputs.furnishingBudget || 0;
    const totalEquity = downPayment + closingCosts + totalRenoBudget + furnishingBudget;
    const monthlyMortgage = calculateMortgage(loanAmount, baseInputs.interestRate);
    const annualDebtService = monthlyMortgage * 12;
    const annualCashFlow = baseInputs.noi - annualDebtService;

    return {
        ...baseInputs,
        listedPrice: price,
        downPayment,
        loanAmount,
        closingCosts,
        totalEquity,
        monthlyMortgage,
        annualDebtService,
        annualCashFlow
    };
}

export function solveBuyBoxPrices(inputs, targetMOIC = 2.5) {
    const solveForPrice = (moicTarget, overrideRate) => {
        let lo = inputs.listedPrice * 0.3;
        let hi = inputs.listedPrice * 10;
        for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            let testInputs = buildInputsAtPrice(inputs, mid);
            if (overrideRate !== undefined) {
                testInputs = { ...testInputs, interestRate: overrideRate };
                testInputs.monthlyMortgage = calculateMortgage(testInputs.loanAmount, overrideRate);
                testInputs.annualDebtService = testInputs.monthlyMortgage * 12;
                testInputs.annualCashFlow = testInputs.noi - testInputs.annualDebtService;
            }
            const flows = calculateAnnualCashFlows(testInputs);
            const moic = calculateMOIC(flows, testInputs.totalEquity);
            if (moic > moicTarget) lo = mid; else hi = mid;
        }
        return Math.round((lo + hi) / 2);
    };

    const idealMOIC = targetMOIC * 1.15;   // 2.875x — what you'd love to pay
    const maxMOIC = targetMOIC;             // 2.5x   — absolute ceiling
    const stretchMOIC = targetMOIC * 0.85; // 2.125x — acceptable stretch

    // NO cap at listed price — show real numbers.
    // If solved price > listed, it means the deal is UNDERPRICED at asking.
    // The render layer adds context (e.g. "Below asking — strong deal").
    const primary = {
        ideal: solveForPrice(idealMOIC),
        max: solveForPrice(maxMOIC),
        stretch: solveForPrice(stretchMOIC),
        listed: inputs.listedPrice,
        targetMOIC
    };

    const refiRate = Math.max(5.5, inputs.interestRate - 3);
    const refi = {
        ideal: solveForPrice(idealMOIC, refiRate),
        max: solveForPrice(maxMOIC, refiRate),
        stretch: solveForPrice(stretchMOIC, refiRate),
        listed: inputs.listedPrice,
        targetMOIC,
        rate: refiRate
    };

    return { primary, refi, currentRate: inputs.interestRate };
}

// ════════════════════════════════════════════════
//  SCENARIO BUILDER
// ════════════════════════════════════════════════

export function buildScenarios(inputs) {
    // Conservative: base inputs as-is
    const consvFlows = calculateAnnualCashFlows(inputs);
    const consvMOIC = calculateMOIC(consvFlows, inputs.totalEquity);
    const consvIRR = calculateIRR(consvFlows);
    const consvValue = calculateStabilizedValue(inputs);

    // Optimized: +15% ADR, +10pp occupancy, ARV-based appreciation
    const optInputs = { ...inputs };
    optInputs.adr = Math.round(inputs.adr * 1.15);
    optInputs.occupancyRate = Math.min(0.95, inputs.occupancyRate + 0.10);
    optInputs.annualRevenue = optInputs.adr * optInputs.occupancyRate * 365 * inputs.numKeys;
    optInputs.totalRevenue = optInputs.annualRevenue + inputs.ancillaryRevenue;
    optInputs.noi = optInputs.totalRevenue - inputs.annualOpex;
    optInputs.annualCashFlow = optInputs.noi - inputs.annualDebtService;
    if (inputs.arv > inputs.listedPrice) {
        optInputs.annualAppreciation = Math.max(inputs.annualAppreciation, 0.04);
    }

    const optFlows = calculateAnnualCashFlows(optInputs);
    const optMOIC = calculateMOIC(optFlows, optInputs.totalEquity);
    const optIRR = calculateIRR(optFlows);
    const optValue = calculateStabilizedValue(optInputs);

    // Stressed: force 70% expense ratio
    const stressedInputs = { ...inputs };
    const stressedOpex = inputs.totalRevenue * 0.70;
    stressedInputs.monthlyOpex = stressedOpex / 12;
    stressedInputs.annualOpex = stressedOpex;
    stressedInputs.noi = inputs.totalRevenue - stressedOpex;
    stressedInputs.annualCashFlow = stressedInputs.noi - inputs.annualDebtService;

    const stressedFlows = calculateAnnualCashFlows(stressedInputs);
    const stressedMOIC = calculateMOIC(stressedFlows, stressedInputs.totalEquity);
    const stressedIRR = calculateIRR(stressedFlows);
    const stressedValue = calculateStabilizedValue(stressedInputs);

    // Build explainer text with specific input changes
    const optADR = Math.round(inputs.adr * 1.15);
    const optOcc = Math.round(Math.min(95, inputs.occupancyRate * 100 + 10));
    const curOcc = Math.round(inputs.occupancyRate * 100);
    const stressedExpRatio = 70;
    const curExpRatio = inputs.totalRevenue > 0
        ? Math.round((inputs.annualOpex / inputs.totalRevenue) * 100) : 0;

    return {
        conservative: {
            moic: consvMOIC,
            irr: consvIRR,
            annualCF: inputs.annualCashFlow,
            stabilizedValue: consvValue,
            explainer: 'Your inputs as entered'
        },
        optimized: {
            moic: optMOIC,
            irr: optIRR,
            annualCF: optInputs.annualCashFlow,
            stabilizedValue: optValue,
            explainer: `ADR $${inputs.adr} → $${optADR} (+15%) | Occupancy ${curOcc}% → ${optOcc}%`
        },
        stressed: {
            moic: stressedMOIC,
            irr: stressedIRR,
            annualCF: stressedInputs.annualCashFlow,
            stabilizedValue: stressedValue,
            explainer: `Expenses forced to ${stressedExpRatio}% of revenue (currently ${curExpRatio}%)`
        }
    };
}

// ════════════════════════════════════════════════
//  LEVER ANALYSIS
// ════════════════════════════════════════════════

export function calculateDealLevers(inputs, baseMOIC, baseIRR, flags) {
    // Pre-compute specific numbers for lever insights
    const targetPrice = Math.round(inputs.listedPrice * 0.90);
    const priceSavings = inputs.listedPrice - targetPrice;
    const newADR = Math.round(inputs.adr * 1.15);
    const adrRevGain = (newADR - inputs.adr) * inputs.occupancyRate * 365 * inputs.numKeys;
    const newOcc = Math.min(0.90, inputs.occupancyRate + 0.10);
    const newOccPct = Math.round(newOcc * 100);
    const curOccPct = Math.round(inputs.occupancyRate * 100);
    const occRevGain = inputs.adr * (newOcc - inputs.occupancyRate) * 365 * inputs.numKeys;
    const opexSavings = inputs.monthlyOpex * 0.15;
    const refiRate = Math.max(5.5, inputs.interestRate - 3);
    const refiMortgage = calculateMortgage(inputs.loanAmount, refiRate);
    const refiDSSavings = (inputs.monthlyMortgage - refiMortgage) * 12;
    const newKeys = Math.ceil(inputs.numKeys * 1.2);
    const addedKeys = newKeys - inputs.numKeys;
    const keyRevGain = inputs.adr * inputs.occupancyRate * 365 * addedKeys;

    const levers = [
        {
            name: 'Negotiate Purchase Price',
            key: 'price',
            mutate: (inp) => { return buildInputsAtPrice(inp, inp.listedPrice * 0.90); },
            insight: `Reduce from ${formatCurrency(inputs.listedPrice)} to ${formatCurrency(targetPrice)} (-10%). Saves ${formatCurrency(priceSavings)} in equity.`,
            direction: 'Negotiate below asking or find off-market deals'
        },
        {
            name: 'Grow Revenue',
            key: 'revenue',
            mutate: (inp) => {
                // Combined: +15% ADR + +10pp occupancy
                const m = { ...inp, adr: inp.adr * 1.15, occupancyRate: Math.min(0.90, inp.occupancyRate + 0.10) };
                m.annualRevenue = m.adr * m.occupancyRate * 365 * m.numKeys;
                m.totalRevenue = m.annualRevenue + (inp.ancillaryRevenue || 0);
                m.noi = m.totalRevenue - m.annualOpex;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: `Push ADR from $${inputs.adr} to $${newADR} and occupancy from ${curOccPct}% to ${newOccPct}%. Combined revenue lift: ${formatCurrency(adrRevGain + occRevGain)}/yr. Dynamic pricing alone typically adds 10-20%.`,
            direction: 'Professional photography, dynamic pricing tool (Pricelabs/Wheelhouse), and multi-OTA listing'
        },
        {
            name: 'Reduce Operating Expenses',
            key: 'opex',
            mutate: (inp) => {
                const m = { ...inp, monthlyOpex: inp.monthlyOpex * 0.85 };
                m.annualOpex = m.monthlyOpex * 12;
                m.noi = (inp.totalRevenue || inp.annualRevenue) - m.annualOpex;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: `Cut ${formatCurrency(opexSavings)}/mo in expenses (-15%). Saves ${formatCurrency(opexSavings * 12)}/yr.`,
            direction: 'Automate check-in, optimize staffing, renegotiate vendors'
        },
        {
            name: 'Refinance to Lower Rate',
            key: 'refi',
            mutate: (inp) => {
                const m = { ...inp, interestRate: refiRate };
                m.monthlyMortgage = calculateMortgage(m.loanAmount, refiRate);
                m.annualDebtService = m.monthlyMortgage * 12;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: `Refi from ${inputs.interestRate}% to ${refiRate}%. Saves ${formatCurrency(refiDSSavings)}/yr in debt service.`,
            direction: 'Plan refi at 12-18 months once NOI stabilizes'
        },
        {
            name: 'Add Keys / Units',
            key: 'keys',
            mutate: (inp) => {
                const m = { ...inp, numKeys: newKeys };
                m.annualRevenue = m.adr * m.occupancyRate * 365 * m.numKeys;
                m.totalRevenue = m.annualRevenue + (inp.ancillaryRevenue || 0);
                m.noi = m.totalRevenue - m.annualOpex * 1.05;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: `Add ${addedKeys} keys (${inputs.numKeys} → ${newKeys}). Adds ${formatCurrency(keyRevGain)}/yr in revenue.`,
            direction: 'Convert underused spaces or add modular units'
        },
        {
            name: 'Extend Hold Period',
            key: 'hold',
            mutate: (inp) => {
                return { ...inp, holdPeriod: inp.holdPeriod + 2 };
            },
            insight: `Hold ${inputs.holdPeriod} → ${inputs.holdPeriod + 2} years. Extra compounding on appreciation and revenue growth.`,
            direction: 'Plan for longer hold to capture full value cycle'
        }
    ];

    // Ancillary removal lever (when ancillary > 20%)
    if (inputs.ancillaryPct > 0.20) {
        levers.push({
            name: 'Remove Ancillary Revenue',
            key: 'ancillary',
            mutate: (inp) => {
                const m = { ...inp };
                m.ancillaryRevenue = 0;
                m.totalRevenue = m.annualRevenue;
                m.noi = m.totalRevenue - m.annualOpex;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: 'Shows returns if ancillary revenue (events, F&B) disappears entirely.',
            direction: 'Stress test: what happens without ancillary income streams'
        });
    }

    // Under-leverage exit lever
    if (flags && flags.underLeveragedFlag && inputs.holdPeriod > 2) {
        levers.push({
            name: 'Early Exit to Unlock Equity',
            key: 'earlyExit',
            mutate: (inp) => {
                return { ...inp, holdPeriod: Math.max(1, inp.holdPeriod - 2) };
            },
            insight: 'Capital is trapped — exiting 2 years sooner recycles equity faster.',
            direction: 'Refinance or sell to deploy capital into next deal'
        });
    }

    // Depreciation exhaustion lever
    if (flags && flags.depExhaustion && flags.depExhaustion.exhaustionYear < inputs.holdPeriod) {
        const exitYear = flags.depExhaustion.exhaustionYear;
        levers.push({
            name: 'Optimize Hold (Depreciation)',
            key: 'depHold',
            mutate: (inp) => {
                return { ...inp, holdPeriod: exitYear };
            },
            insight: `~90% of depreciation consumed by Year ${exitYear}. Holding longer yields diminishing tax benefit.`,
            direction: `Consider exit at Year ${exitYear} to maximize tax-adjusted returns`
        });
    }

    // ── Reno lever: only suggest skipping if reno is NOT creating ARV value ──
    const renoAmt = inputs.renovationBudget || 0;
    const arvGain = (inputs.arv || 0) - (inputs.listedPrice || 0);
    const renoIsValueCreating = renoAmt > 0 && arvGain > renoAmt * 0.8; // ARV gain covers 80%+ of reno cost
    if (renoAmt > 0 && !renoIsValueCreating) {
        // Reno cost isn't justified by ARV uplift — suggest phasing it
        levers.push({
            name: 'Phase Renovation Strategically',
            key: 'reno',
            mutate: (inp) => {
                const reduced = Math.round(inp.renovationBudget * 0.5);
                const m = { ...inp, renovationBudget: reduced, totalRenoBudget: reduced };
                m.totalEquity = m.downPayment + m.closingCosts + reduced + inp.furnishingBudget;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: `${formatCurrency(renoAmt)} reno isn't fully offset by ARV gain (${formatCurrency(arvGain)}). Phase it — do 50% upfront to launch, fund the rest from operating cash flow.`,
            direction: 'Launch with must-haves. Add premium amenities after first 90 days of revenue'
        });
    } else if (renoAmt > 0 && renoIsValueCreating) {
        // Reno IS value-creating — suggest optimizing spend for max ADR impact
        levers.push({
            name: 'Optimize Reno for ADR Impact',
            key: 'reno',
            mutate: (inp) => {
                const m = { ...inp, adr: inp.adr * 1.12 };
                m.annualRevenue = m.adr * inp.occupancyRate * 365 * inp.numKeys;
                m.totalRevenue = m.annualRevenue + (inp.ancillaryRevenue || 0);
                m.noi = m.totalRevenue - inp.annualOpex;
                m.annualCashFlow = m.noi - inp.annualDebtService;
                return m;
            },
            insight: `Your ${formatCurrency(renoAmt)} reno creates ${formatCurrency(arvGain)} in value — strong ROI. Focus remaining scope on ADR drivers: hot tub, outdoor spaces, premium kitchen. Target 10-12% ADR lift.`,
            direction: 'Prioritize amenities that appear in top-performing comp listings in your market'
        });
    }

    // ── Down payment lever: reduce to min viable ─────────────────────────────
    if (inputs.downPct > 0.20) {
        const altDown = 0.20;
        const savedEquity = (inputs.downPct - altDown) * inputs.listedPrice;
        levers.push({
            name: 'Lower Down Payment to 20%',
            key: 'downpayment',
            mutate: (inp) => {
                const m = { ...inp, downPct: altDown };
                m.downPayment = inp.listedPrice * altDown;
                m.loanAmount = inp.listedPrice * (1 - altDown);
                m.monthlyMortgage = calculateMortgage(m.loanAmount, inp.interestRate);
                m.annualDebtService = m.monthlyMortgage * 12;
                m.totalEquity = m.downPayment + inp.closingCosts + (inp.renovationBudget || 0) + (inp.furnishingBudget || 0);
                m.noi = (inp.totalRevenue || inp.annualRevenue) - inp.annualOpex;
                m.annualCashFlow = m.noi - m.annualDebtService;
                return m;
            },
            insight: `Put 20% down instead of ${Math.round(inputs.downPct * 100)}%. Frees ${formatCurrency(savedEquity)} to deploy elsewhere.`,
            direction: 'Use freed capital as 20% down on a second deal instead'
        });
    }

    // ── Furnishing lever: upgrade furnishing to boost ADR ─────────────────────
    if (inputs.furnishingBudget > 0 && inputs.furnishingBudget < inputs.listedPrice * 0.04) {
        const upgradedFurnish = inputs.furnishingBudget * 1.5;
        const adrBoost = inputs.adr * 0.10;
        const revBoost = adrBoost * inputs.occupancyRate * 365;
        levers.push({
            name: 'Upgrade Furnishing for Higher ADR',
            key: 'furnish',
            mutate: (inp) => {
                const m = { ...inp, furnishingBudget: upgradedFurnish };
                m.totalEquity = inp.downPayment + inp.closingCosts + (inp.renovationBudget || 0) + upgradedFurnish;
                m.adr = inp.adr * 1.10;
                m.annualRevenue = m.adr * inp.occupancyRate * 365;
                m.totalRevenue = m.annualRevenue + (inp.ancillaryRevenue || 0);
                m.noi = m.totalRevenue - inp.annualOpex;
                m.annualCashFlow = m.noi - inp.annualDebtService;
                return m;
            },
            insight: `Increase furnishing from ${formatCurrency(inputs.furnishingBudget)} to ${formatCurrency(upgradedFurnish)}. Premium design can lift ADR 10%+ (${formatCurrency(revBoost)}/yr).`,
            direction: 'Hire an STR interior designer — ROI is typically 6-12 months'
        });
    }

    // Filter out levers that don't apply to property type
    const filteredLevers = levers.filter(lever => {
        if (inputs.propertyType === 'str') {
            if (lever.key === 'keys' || lever.key === 'hold') return false;
        }
        return true;
    });

    const results = filteredLevers.map(lever => {
        const mutated = lever.mutate({ ...inputs });
        const flows = calculateAnnualCashFlows(mutated);
        const moic = calculateMOIC(flows, mutated.totalEquity);
        const irr = calculateIRR(flows);
        return {
            ...lever,
            newMOIC: moic,
            newIRR: irr,
            deltaMOIC: moic - baseMOIC,
            deltaIRR: irr - baseIRR
        };
    });

    results.sort((a, b) => b.deltaMOIC - a.deltaMOIC);
    return results.slice(0, 3);
}
