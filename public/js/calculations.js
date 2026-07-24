/**
 * Core calculations — cash flows, MOIC, IRR, stabilized value, tax benefits, depreciation
 */

import { BONUS_DEPRECIATION_PERCENT, RENO_BONUS_DEPRECIATION_PERCENT, TAX_RATE_FLAT, LAND_VALUE_PERCENT } from './constants.js';
import { calculateMortgage, calculateRemainingBalance, calculateFederalTax } from './utils.js';

/**
 * Compute remaining balance across all debt tranches at `years` elapsed.
 * IO tranches: no paydown. Amortizing: standard formula.
 * Falls back to single-loan if no tranches defined.
 */
function computeTotalRemainingBalance(inputs, years) {
    const { debtTranches, loanAmount, interestRate, monthlyMortgage } = inputs;
    if (debtTranches && debtTranches.length > 0 && debtTranches.some(t => t.amount > 0)) {
        return debtTranches.reduce((sum, t) => {
            if (!t.amount || t.amount <= 0) return sum;
            if (t.interestOnly) return sum + t.amount;
            const mp = t.amount > 0 && t.rate > 0
                ? t.amount * ((t.rate/100/12) * Math.pow(1+t.rate/100/12, (t.termYears||25)*12)) /
                  (Math.pow(1+t.rate/100/12, (t.termYears||25)*12) - 1)
                : 0;
            const r = t.rate / 100 / 12;
            const paid = years * 12;
            if (r <= 0) return sum + Math.max(0, t.amount - mp * paid);
            return sum + Math.max(0, t.amount * Math.pow(1+r, paid) - mp * (Math.pow(1+r, paid) - 1) / r);
        }, 0);
    }
    return calculateRemainingBalance(loanAmount, interestRate, monthlyMortgage, years);
}

export function calculateAnnualCashFlows(inputs) {
    const {
        totalEquity, annualOpex,
        revenueGrowth, holdPeriod, arv, annualAppreciation,
        exitCapRate, loanAmount, interestRate, monthlyMortgage, annualDebtService
    } = inputs;

    const baseRevenue = inputs.totalRevenue || inputs.annualRevenue;
    const flows = [-totalEquity];

    // Refinance parameters
    const hasRefi = inputs.refiPlanned && inputs.refiRate > 0 && inputs.refiTimingMonths > 0;
    const refiYear = hasRefi ? Math.ceil(inputs.refiTimingMonths / 12) : Infinity;

    // Pre-compute refi loan details if applicable
    let refiLoanAmount = 0;
    let refiMonthlyMortgage = 0;
    let refiAnnualDS = 0;
    let refiCashOut = 0;

    if (hasRefi) {
        // At refi time, appraised value is estimated from current trajectory
        const refiAppraisalValue = calculateStabilizedValue({
            ...inputs, holdPeriod: refiYear
        });
        refiLoanAmount = refiAppraisalValue * (inputs.refiLTV || 0.70);
        const bridgeBalanceAtRefi = computeTotalRemainingBalance(inputs, refiYear);
        refiCashOut = Math.max(0, refiLoanAmount - bridgeBalanceAtRefi);
        refiMonthlyMortgage = calculateMortgage(refiLoanAmount, inputs.refiRate);
        refiAnnualDS = refiMonthlyMortgage * 12;
    }

    // Construction timeline parameters (hotel only) — uses phase array for precise calculation
    const phases = inputs.constructionPhases && inputs.constructionPhases.length > 0
        ? inputs.constructionPhases
        : (inputs.constructionDuration > 0
            ? [{ keysOut: inputs.constructionKeysOut || 0, months: inputs.constructionDuration }]
            : []);
    const rampMonths = inputs.rampUpMonths || 0;
    const totalKeys = inputs.numKeys || 1;

    // Build month-by-month revenue fractions for construction + ramp period
    const monthRevFracs = [];
    for (const phase of phases) {
        const frac = totalKeys > 0 ? (totalKeys - Math.min(phase.keysOut, totalKeys)) / totalKeys : 1;
        for (let m = 0; m < (phase.months || 0); m++) monthRevFracs.push(frac);
    }
    for (let r = 0; r < rampMonths; r++) {
        monthRevFracs.push(0.30 + 0.70 * (r + 1) / Math.max(1, rampMonths));
    }

    // Year 1 multiplier = average of first 12 months of revenue fracs (rest = 1.0)
    const yr1Frac = monthRevFracs.length > 0
        ? Array.from({ length: 12 }, (_, i) => monthRevFracs[i] ?? 1.0).reduce((s, v) => s + v, 0) / 12
        : 1.0;

    for (let yr = 1; yr <= holdPeriod; yr++) {
        const revGrowthFactor = Math.pow(1 + revenueGrowth, yr - 1);
        let yearRevenue = baseRevenue * revGrowthFactor;

        // Year 1: apply phased construction revenue reduction
        if (yr === 1 && yr1Frac < 1.0) {
            yearRevenue = yearRevenue * yr1Frac;
        }

        const yearNOI = yearRevenue - annualOpex;

        // Use bridge debt service pre-refi, refi debt service post-refi
        const yearDS = (hasRefi && yr > refiYear) ? refiAnnualDS : annualDebtService;
        let yearCF = yearNOI - yearDS;

        // Add refi cash-out in the refi year
        if (hasRefi && yr === refiYear) {
            yearCF += refiCashOut;
        }

        if (yr < holdPeriod) {
            flows.push(yearCF);
        } else {
            let exitValue;
            if (inputs.propertyType === 'str') {
                exitValue = arv * Math.pow(1 + annualAppreciation, holdPeriod);
            } else {
                const exitNOI = yearRevenue * (1 + revenueGrowth) - annualOpex;
                const exitValueByCap = exitCapRate > 0 && exitNOI > 0 ? exitNOI / exitCapRate : 0;
                const exitValueByAppreciation = arv * Math.pow(1 + annualAppreciation, holdPeriod);
                exitValue = exitValueByCap > 0 ? exitValueByCap : exitValueByAppreciation;
            }

            // Remaining balance depends on which loan is active
            let remainingBalance;
            if (hasRefi && holdPeriod > refiYear) {
                remainingBalance = calculateRemainingBalance(refiLoanAmount, inputs.refiRate, refiMonthlyMortgage, holdPeriod - refiYear);
            } else {
                remainingBalance = computeTotalRemainingBalance(inputs, holdPeriod);
            }
            const saleProceeds = exitValue - remainingBalance;
            flows.push(yearCF + saleProceeds);
        }
    }
    return flows;
}

export function calculateMOIC(cashFlows, totalEquity) {
    if (totalEquity <= 0) return 0;
    const totalReturns = cashFlows.slice(1).reduce((s, v) => s + v, 0);
    return totalReturns / totalEquity;
}

export function calculateIRR(cashFlows, guess = 0.15, maxIter = 200, tol = 1e-7) {
    // If total returns are negative (all cash flows sum negative), IRR is meaningfully negative
    const totalReturn = cashFlows.reduce((s, v) => s + v, 0);
    if (totalReturn < 0 && cashFlows[0] < 0) {
        // Deal loses money overall — use wider bisection range to find negative IRR
        let lo = -0.99, hi = 5.0;
        for (let i = 0; i < 300; i++) {
            const mid = (lo + hi) / 2;
            let npv = 0;
            for (let t = 0; t < cashFlows.length; t++) {
                npv += cashFlows[t] / Math.pow(1 + mid, t);
            }
            if (Math.abs(npv) < tol) return mid;
            if (npv > 0) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    let rate = guess;

    for (let i = 0; i < maxIter; i++) {
        let npv = 0, dnpv = 0;
        for (let t = 0; t < cashFlows.length; t++) {
            const pv = cashFlows[t] / Math.pow(1 + rate, t);
            npv += pv;
            if (t > 0) dnpv -= t * cashFlows[t] / Math.pow(1 + rate, t + 1);
        }
        if (Math.abs(npv) < tol) return rate;
        if (Math.abs(dnpv) < 1e-12) break;
        const newRate = rate - npv / dnpv;
        if (newRate < -0.99 || newRate > 10) break;
        rate = newRate;
    }

    let lo = -0.5, hi = 5.0;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        let npv = 0;
        for (let t = 0; t < cashFlows.length; t++) {
            npv += cashFlows[t] / Math.pow(1 + mid, t);
        }
        if (Math.abs(npv) < tol) return mid;
        if (npv > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * Equity Multiple — equity creation score basis.
 * Formula: Equity at exit ÷ Equity invested
 * Equity at exit = ARV after appreciation − remaining loan balance at hold end
 * Does NOT include operating cash flows (that's MOIC) or tax benefits.
 */
export function calculateEquityMultiple(inputs) {
    const exitValue = calculateStabilizedValue(inputs);
    const { holdPeriod, totalEquity } = inputs;
    if (totalEquity <= 0) return 0;
    const remainingBalance = computeTotalRemainingBalance(inputs, holdPeriod);
    const equityAtExit = Math.max(0, exitValue - remainingBalance);
    return equityAtExit / totalEquity;
}

export function calculateStabilizedValue(inputs) {
    const { propertyType, arv, arvOverride, annualAppreciation, holdPeriod, exitCapRate, noi, revenueGrowth } = inputs;

    if (propertyType === 'str') {
        // STR: exit value based on ARV + appreciation (comp-based, no cap rate)
        return arv * Math.pow(1 + annualAppreciation, holdPeriod);
    }

    // Hotel with explicit user-entered exit value: respect it
    if (arvOverride) {
        return arv * Math.pow(1 + annualAppreciation, holdPeriod);
    }

    // Hotel: exit value = projected NOI / exit cap rate (income-based, no ARV)
    const exitNOI = noi * Math.pow(1 + revenueGrowth, holdPeriod);
    if (exitCapRate > 0 && exitNOI > 0) {
        return exitNOI / exitCapRate;
    }

    // Fallback if NOI is negative or cap rate missing: appreciate listed price
    return (inputs.listedPrice || arv) * Math.pow(1 + annualAppreciation, holdPeriod);
}

/**
 * Calculate ALL years of tax benefits with carryforward logic.
 *
 * Depreciation structure:
 *   Land: 20% of purchase price — NOT depreciable
 *   Depreciable basis: 80% of purchase price
 *     └─ Structure (straight-line): 50% of depreciable basis ÷ 27.5yr (STR) or 39yr (hotel)
 *     └─ Personal property/contents (bonus dep): 50% of depreciable basis → 100% in year 1
 *   Renovation budget: 100% bonus dep in year 1
 *
 * Carryforward logic:
 *   Only take as much depreciation as needed to bring effective tax rate to 10%.
 *   Any unused depreciation carries forward to the next year.
 *
 * Returns: array of annual tax savings (length = holdPeriod)
 */
/**
 * Cost Segregation Tax Model for STRs
 *
 * Asset classes (of depreciable basis = 80% of purchase price):
 *   • 5-yr personal property (appliances, fixtures, carpets, furniture): 30% of dep basis
 *     → 100% bonus depreciation year 1 (simulates a cost seg study; STR loophole allows
 *       full loss against ordinary income since avg rental < 7 days = non-passive)
 *   • 15-yr land improvements (landscaping, parking, sidewalks): 20% of dep basis
 *     → 100% bonus depreciation year 1
 *   • 27.5-yr residential structure (walls, roof, foundation): 50% of dep basis
 *     → Straight-line over 27.5 years (year 1 and every year)
 *   • Renovation budget: 100% bonus depreciation year 1 (all personal property / qualified improvement)
 *
 * Tax savings: actual marginal rate on the income offset, capped at income (can't go negative).
 * Any depreciation above income carries forward.
 */
export function calculateAllTaxBenefits(inputs) {
    const { listedPrice, renovationBudget, householdIncome, propertyType, holdPeriod, filingStatus } = inputs;
    if (!listedPrice || listedPrice <= 0) return new Array(holdPeriod || 5).fill({ depTaken: 0, carryforward: 0, taxSavings: 0, annualStraightLine: 0 });
    if (!householdIncome || householdIncome <= 0) return new Array(holdPeriod || 5).fill({ depTaken: 0, carryforward: 0, taxSavings: 0, annualStraightLine: 0 });

    const depYears = propertyType === 'hotel' ? 39 : 27.5;
    const filing = filingStatus || 'married';

    // ── Asset class splits ────────────────────────────────────────────────────
    const depBasis = listedPrice * 0.80;  // 80% depreciable (land = 20%)

    const personalProp    = depBasis * 0.30;   // 5-yr class — 100% bonus dep yr1
    const landImprovements = depBasis * 0.20;  // 15-yr class — 100% bonus dep yr1
    const structure        = depBasis * 0.50;  // 27.5-yr (or 39-yr) — straight-line
    const renoBonus        = renovationBudget || 0;  // 100% bonus dep yr1

    const annualStraightLine = structure / depYears;

    // Year 1 bonus depreciation = all 5-yr + all 15-yr + reno + first year structure
    const year1BonusDep = personalProp + landImprovements + renoBonus;
    // Years 2+ ongoing: just straight-line structure (personal prop / improvements are fully expensed yr1)
    const ongoingStraightLine = annualStraightLine;

    // ── Per-year marginal tax rate helper ────────────────────────────────────
    // Tax savings = tax(income) - tax(income - depreciation taken)
    const taxSavingsOnDep = (income, dep) => {
        if (dep <= 0 || income <= 0) return 0;
        const normalTax = calculateFederalTax(income, filing);
        const reducedIncome = Math.max(0, income - dep);
        const reducedTax = calculateFederalTax(reducedIncome, filing);
        return normalTax - reducedTax;
    };

    const results = [];
    let carryforward = 0;

    for (let yr = 1; yr <= holdPeriod; yr++) {
        // Available depreciation this year = ongoing straight-line + any prior carryforward + year1 bonus
        let availableDep = ongoingStraightLine + carryforward;
        if (yr === 1) availableDep += year1BonusDep;

        // Cap at household income — can't deduct more than income in any given year.
        // Excess carries forward to the next year automatically.
        const maxDep = householdIncome;
        const depTaken = Math.min(availableDep, maxDep);
        carryforward = availableDep - depTaken;

        const savings = taxSavingsOnDep(householdIncome, depTaken);

        results.push({
            depTaken: Math.round(depTaken),
            carryforward: Math.round(carryforward),
            taxSavings: Math.round(savings),
            year1BonusDep: yr === 1 ? Math.round(year1BonusDep) : 0,
            annualStraightLine: Math.round(annualStraightLine),
            personalProp: yr === 1 ? Math.round(personalProp) : 0,
            landImprovements: yr === 1 ? Math.round(landImprovements) : 0,
            renoBonus: yr === 1 ? Math.round(renoBonus) : 0,
        });
    }

    return results;
}

/** Legacy single-year wrapper (used by proForma and other callers) */
export function calculateTaxBenefits(inputs, year) {
    const all = calculateAllTaxBenefits(inputs);
    return all[year - 1]?.taxSavings ?? 0;
}

export function calculateDepreciationExhaustion(inputs) {
    const { listedPrice, renovationBudget, propertyType, holdPeriod } = inputs;
    const structureValue = listedPrice * (1 - LAND_VALUE_PERCENT);
    const depYears = propertyType === 'hotel' ? 39 : 27.5;

    // Total depreciable amount = structure value + renovation budget
    const totalDepreciable = structureValue + (renovationBudget || 0);

    // Year 1 bonus: 50% of structure + 100% of reno
    const year1Bonus = structureValue * BONUS_DEPRECIATION_PERCENT + (renovationBudget || 0) * RENO_BONUS_DEPRECIATION_PERCENT;
    // Remaining structure spread over dep life
    const remainingStructure = structureValue * (1 - BONUS_DEPRECIATION_PERCENT);
    const annualStraightLine = remainingStructure / depYears;

    let exhaustionYear = null;
    let cumulative = year1Bonus + annualStraightLine;
    if (cumulative >= totalDepreciable * 0.90) {
        exhaustionYear = 1;
    } else {
        for (let yr = 2; yr <= Math.ceil(depYears) + 1; yr++) {
            cumulative += annualStraightLine;
            if (cumulative >= totalDepreciable * 0.90) {
                exhaustionYear = yr;
                break;
            }
        }
    }
    if (!exhaustionYear) exhaustionYear = Math.ceil(depYears) + 1;

    let depAtHold = year1Bonus + annualStraightLine;
    for (let yr = 2; yr <= holdPeriod; yr++) {
        depAtHold += annualStraightLine;
    }
    const pctConsumed = Math.min(1, depAtHold / totalDepreciable);

    return { pctConsumed, exhaustionYear, totalDepreciation: totalDepreciable };
}

export function calculateProForma(inputs) {
    const baseRevenue = inputs.totalRevenue || inputs.annualRevenue;
    const rows = [];

    for (let yr = 1; yr <= inputs.holdPeriod; yr++) {
        const revGrowth = Math.pow(1 + (inputs.revenueGrowth || 0.02), yr - 1);
        const yearRevenue = baseRevenue * revGrowth;
        const yearNOI = yearRevenue - inputs.annualOpex;
        const yearCashFlow = yearNOI - inputs.annualDebtService;
        // Use pre-computed allTaxBenefits if available (includes carryforward)
        const taxRow = inputs.allTaxBenefits ? inputs.allTaxBenefits[yr - 1] : null;
        const yearTaxBenefit = taxRow ? taxRow.taxSavings : calculateTaxBenefits(inputs, yr);

        // Principal paydown: balance at start of year minus balance at end of year
        const balanceStart = yr === 1
            ? inputs.loanAmount
            : computeTotalRemainingBalance(inputs, yr - 1);
        const balanceEnd = computeTotalRemainingBalance(inputs, yr);
        const principalPaydown = balanceStart - balanceEnd;

        // Equity growth:
        // Hotels → income-based (NOI / exitCapRate grows with revenue)
        // STR    → comp-based (ARV appreciates annually)
        let equityGrowth;
        if (inputs.propertyType === 'hotel') {
            const capRate = inputs.exitCapRate || 0.09;
            if (capRate > 0 && yearNOI > 0) {
                const currentValue = yearNOI / capRate;
                if (yr === 1) {
                    // Forced appreciation: income-based value vs. total capital deployed
                    const totalCostBasis = inputs.listedPrice + (inputs.renovationBudget || 0) +
                        (inputs.closingCosts || 0) + (inputs.contingencyAmount || 0) + (inputs.furnishingBudget || 0);
                    equityGrowth = Math.max(0, currentValue - totalCostBasis);
                } else {
                    const prevYearRevenue = baseRevenue * Math.pow(1 + (inputs.revenueGrowth || 0.02), yr - 2);
                    const prevNOI = prevYearRevenue - inputs.annualOpex;
                    const prevValue = prevNOI > 0 ? prevNOI / capRate : inputs.listedPrice;
                    equityGrowth = Math.max(0, currentValue - prevValue);
                }
            } else {
                equityGrowth = 0;
            }
        } else {
            // STR: appreciation on ARV
            const arvBase = inputs.arv || inputs.listedPrice;
            const totalCostBasis = inputs.listedPrice + (inputs.renovationBudget || 0) +
                (inputs.closingCosts || 0) + (inputs.contingencyAmount || 0) + (inputs.furnishingBudget || 0);
            const appreciation = inputs.annualAppreciation || 0.03;
            if (yr === 1) {
                const forcedAppreciation = Math.max(0, arvBase - totalCostBasis);
                const yearAppreciation = arvBase * appreciation;
                equityGrowth = forcedAppreciation + yearAppreciation;
            } else {
                const propertyValue = arvBase * Math.pow(1 + appreciation, yr);
                const priorValue = arvBase * Math.pow(1 + appreciation, yr - 1);
                equityGrowth = propertyValue - priorValue;
            }
        }

        rows.push({
            year: yr,
            revenue: yearRevenue,
            expenses: inputs.annualOpex,
            noi: yearNOI,
            debtService: inputs.annualDebtService,
            cashFlow: yearCashFlow,
            taxBenefit: yearTaxBenefit,
            principalPaydown,
            equityGrowth,
            totalReturn: yearCashFlow + yearTaxBenefit + principalPaydown + equityGrowth
        });
    }

    return rows;
}

export function calculateWorkingCapitalCushion(inputs) {
    const { renovationBudget, propertyType, annualOpex, monthlyMortgage, totalRevenue, numKeys } = inputs;

    // For hotels with phase data: use precise month-by-month deficit calculation
    if (propertyType === 'hotel') {
        return calculateConstructionReserve(inputs);
    }

    // STR fallback
    if (renovationBudget <= 0) {
        return { cushionNeeded: 0, monthsOfDeficit: 0, constructionReserve: 0, flag: false };
    }

    const renoMonths = 3;
    const renoScope = Math.min(1, renovationBudget / (inputs.listedPrice * 0.5));
    const revenueReduction = renoScope * 0.5;
    const monthlyRevenue = totalRevenue / 12;
    const monthlyOpex = annualOpex / 12;

    let totalDeficit = 0;
    let monthsOfDeficit = 0;
    for (let m = 0; m < renoMonths; m++) {
        const burn = (monthlyOpex + monthlyMortgage) - monthlyRevenue * (1 - revenueReduction);
        if (burn > 0) { totalDeficit += burn; monthsOfDeficit++; }
    }

    return {
        cushionNeeded: Math.round(totalDeficit),
        monthsOfDeficit,
        constructionReserve: Math.round(totalDeficit),
        flag: totalDeficit > monthlyOpex * 6
    };
}

/**
 * Precise month-by-month construction cash deficit for hotels.
 * Uses constructionPhases array: [{ keysOut, months }, ...]
 * Plus rampUpMonths after all phases complete.
 */
export function calculateConstructionReserve(inputs) {
    const { annualOpex, monthlyMortgage, totalRevenue, numKeys, constructionPhases, rampUpMonths } = inputs;
    const phases = (constructionPhases && constructionPhases.length > 0) ? constructionPhases
        : [{ keysOut: inputs.constructionKeysOut || 0, months: inputs.constructionDuration || 0 }];

    const totalKeys = numKeys || 1;
    const monthlyRevFull = totalRevenue / 12;
    const monthlyOpex = annualOpex / 12;
    const rampMo = rampUpMonths || 0;

    // Build month-by-month revenue fractions
    const monthRevFracs = [];
    for (const phase of phases) {
        const frac = (totalKeys - Math.min(phase.keysOut, totalKeys)) / totalKeys;
        for (let m = 0; m < (phase.months || 0); m++) monthRevFracs.push(frac);
    }
    // Ramp-up after all phases
    for (let r = 0; r < rampMo; r++) {
        monthRevFracs.push(0.30 + 0.70 * (r + 1) / Math.max(1, rampMo));
    }

    let totalDeficit = 0;
    let monthsOfDeficit = 0;
    for (const frac of monthRevFracs) {
        const rev = monthlyRevFull * frac;
        const burn = (monthlyOpex + monthlyMortgage) - rev;
        if (burn > 0) { totalDeficit += burn; monthsOfDeficit++; }
    }

    const reserve = Math.round(totalDeficit);
    return {
        cushionNeeded: reserve,
        constructionReserve: reserve,
        monthsOfDeficit,
        flag: reserve > 0
    };
}

export function calculateReturnAttribution(inputs) {
    const { holdPeriod, revenueGrowth, annualOpex, loanAmount, interestRate, monthlyMortgage } = inputs;
    const baseRevenue = inputs.totalRevenue || inputs.annualRevenue;

    // Cash flow = cumulative after-debt-service cash flow (matches Pro Forma)
    let totalCashFlow = 0;
    for (let yr = 1; yr <= holdPeriod; yr++) {
        const yearRev = baseRevenue * Math.pow(1 + revenueGrowth, yr - 1);
        const yearNOI = yearRev - annualOpex;
        totalCashFlow += yearNOI - inputs.annualDebtService;
    }

    // Equity creation = exit value minus all capital deployed
    const exitValue = calculateStabilizedValue(inputs);
    const totalCost = inputs.listedPrice + (inputs.renovationBudget || 0) +
        (inputs.closingCosts || 0) + (inputs.contingencyAmount || 0) + (inputs.furnishingBudget || 0);
    const equityCreation = exitValue - totalCost;

    // Debt paydown: principal paid over hold period (accounts for refi)
    const hasRefi = inputs.refiPlanned && inputs.refiRate > 0 && inputs.refiTimingMonths > 0;
    const refiYear = hasRefi ? Math.ceil(inputs.refiTimingMonths / 12) : Infinity;

    let remainingBalance, refiLoanAmount = 0;
    if (hasRefi && holdPeriod > refiYear) {
        const refiAppraisalValue = calculateStabilizedValue({ ...inputs, holdPeriod: refiYear });
        refiLoanAmount = refiAppraisalValue * (inputs.refiLTV || 0.70);
        const refiMonthlyMortgage = calculateMortgage(refiLoanAmount, inputs.refiRate);
        // Principal paid on bridge up to refi + principal paid on refi loan after
        const bridgePaydown = loanAmount - computeTotalRemainingBalance(inputs, refiYear);
        const refiPaydown = refiLoanAmount - calculateRemainingBalance(refiLoanAmount, inputs.refiRate, refiMonthlyMortgage, holdPeriod - refiYear);
        remainingBalance = refiLoanAmount - refiPaydown;
        var debtPaydown = bridgePaydown + refiPaydown;
    } else {
        remainingBalance = computeTotalRemainingBalance(inputs, holdPeriod);
        var debtPaydown = loanAmount - remainingBalance;
    }

    // Tax benefits
    let totalTaxBenefits = 0;
    for (let yr = 1; yr <= holdPeriod; yr++) {
        totalTaxBenefits += calculateTaxBenefits(inputs, yr);
    }

    const total = Math.abs(totalCashFlow) + Math.abs(equityCreation) + totalTaxBenefits + debtPaydown;

    return {
        cashFlow: totalCashFlow,
        equity: equityCreation,
        taxBenefits: totalTaxBenefits,
        debtPaydown,
        total,
        cashFlowPct: total > 0 ? (Math.abs(totalCashFlow) / total) * 100 : 25,
        equityPct: total > 0 ? (Math.abs(equityCreation) / total) * 100 : 25,
        taxPct: total > 0 ? (totalTaxBenefits / total) * 100 : 25,
        debtPaydownPct: total > 0 ? (debtPaydown / total) * 100 : 25
    };
}
