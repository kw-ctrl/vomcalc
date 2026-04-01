/**
 * Scoring model — 4 categories + friction penalty
 */

import { calculateStabilizedValue } from './calculations.js';
import { calculateRemainingBalance } from './utils.js';

/**
 * Equity Creation score — based on equity multiple, NOT MOIC.
 * Equity multiple = (ARV after appreciation − remaining loan) ÷ equity invested.
 * This measures only equity built (forced + natural appreciation + debt paydown).
 * Operating cash flows and tax benefits are excluded — scored separately.
 *
 * Scale (tightened — requires 3.5x for max, 2x = 24/40):
 *   3.5x+ → 40 | 2.5x → 32 | 2x → 24 | 1.5x → 16 | 1x → 8 | 0.5x → 3 | 0 → 0
 */
export function scoreEquityCreation(equityMultiple) {
    if (equityMultiple >= 3.5) return 40;
    if (equityMultiple >= 2.5) return 32 + (equityMultiple - 2.5) / 1.0 * 8;
    if (equityMultiple >= 2.0) return 24 + (equityMultiple - 2.0) / 0.5 * 8;
    if (equityMultiple >= 1.5) return 16 + (equityMultiple - 1.5) / 0.5 * 8;
    if (equityMultiple >= 1.0) return 8  + (equityMultiple - 1.0) / 0.5 * 8;
    if (equityMultiple >= 0.5) return 3  + (equityMultiple - 0.5) / 0.5 * 5;
    return Math.max(0, equityMultiple / 0.5 * 3);
}

export function scoreSpeedOfCapital(irr) {
    const irrPct = irr * 100;
    if (irrPct >= 25) return 25;
    if (irrPct >= 20) return 18 + (irrPct - 20) / 5 * 7;
    if (irrPct >= 15) return 10 + (irrPct - 15) / 5 * 8;
    if (irrPct >= 10) return 5  + (irrPct - 10) / 5 * 5;
    if (irrPct >= 5)  return 2  + (irrPct - 5)  / 5 * 3;
    return Math.max(0, irrPct / 5 * 2);
}

export function scoreTaxEfficiency(totalTaxBenefits, totalEquity, year1TaxBenefits, householdIncome) {
    if (totalEquity <= 0) return 0;

    // Metric 1: Capital efficiency — total tax savings relative to equity invested
    const capitalRatio = totalTaxBenefits / totalEquity;
    const capitalScore = scoreRatio(capitalRatio, 0.40, 0.30, 0.20, 0.10);

    // Metric 2: Income sheltering — year-1 tax savings relative to household income
    // This captures the "STR loophole" / cost-seg benefit that Kassidy emphasizes:
    // a large reno + bonus depreciation can wipe out most of an investor's tax bill
    let incomeScore = 0;
    if (householdIncome > 0 && year1TaxBenefits > 0) {
        const incomeRatio = year1TaxBenefits / householdIncome;
        incomeScore = scoreRatio(incomeRatio, 0.25, 0.18, 0.12, 0.06);
    }

    // Take the better of the two — a deal with high reno costs may have a low
    // capital ratio (denominator inflated by reno) but excellent income sheltering
    return Math.max(capitalScore, incomeScore);
}

function scoreRatio(ratio, tier4, tier3, tier2, tier1) {
    if (ratio >= tier4) return 15;
    if (ratio >= tier3) return 12 + (ratio - tier3) / (tier4 - tier3) * 3;
    if (ratio >= tier2) return 8 + (ratio - tier2) / (tier3 - tier2) * 4;
    if (ratio >= tier1) return 4 + (ratio - tier1) / (tier2 - tier1) * 4;
    return ratio / tier1 * 4;
}

/**
 * Cash Flow score — Cash-on-Cash return.
 * Max 20 pts. 30%+ CoC = 20pts (max). 15% CoC = 15pts.
 * Scale: 30% → 20 | 15% → 15 | 10% → 10 | 5% → 5 | 0% → 0 | negative → 0
 * DSCR shown for reference only — does NOT drive score.
 */
export function scoreStability(inputs) {
    const { noi, annualDebtService, arv, listedPrice, exitCapRate,
            loanAmount, interestRate, monthlyMortgage, holdPeriod,
            totalEquity, annualCashFlow } = inputs;

    // Cash-on-Cash based score (primary). 30% = max, 15% = 15pts
    const coc = totalEquity > 0 ? (annualCashFlow / totalEquity) * 100 : 0;
    let cfScore;
    if (coc >= 30)       cfScore = 20;                              // 30%+ = max
    else if (coc >= 15)  cfScore = 15 + (coc - 15) / 15 * 5;      // 15%–30%: 15→20
    else if (coc >= 10)  cfScore = 10 + (coc - 10) / 5 * 5;       // 10%–15%: 10→15
    else if (coc >= 5)   cfScore = 5  + (coc - 5)  / 5 * 5;       // 5%–10%: 5→10
    else if (coc >= 0)   cfScore = coc / 5 * 5;                    // 0%–5%: 0→5
    else                 cfScore = 0;                               // negative = 0

    const score = Math.min(20, Math.max(0, cfScore));

    // DSCR — used only for flags/display
    const dscr = annualDebtService > 0 ? noi / annualDebtService : 10;
    const dscrFlag = dscr < 1.25;

    const stabilizedValue = calculateStabilizedValue(inputs);
    const remainingBalance = calculateRemainingBalance(loanAmount, interestRate, monthlyMortgage, holdPeriod);
    const netRefiProceeds = (stabilizedValue * 0.65) - remainingBalance;
    const negEquityFlag = netRefiProceeds < 0;

    return { score, dscr, dscrFlag, negEquityFlag, netRefiProceeds, stabilizedValue, coc };
}

export function calculateFrictionPenalty(inputs) {
    let penalty = 0;
    if (inputs.interestRate >= 10) penalty += 1.5;
    if (inputs.renovationBudget > inputs.listedPrice * 0.20) penalty += 1.5;
    if (inputs.annualCashFlow < 0) penalty += 2;
    return Math.min(5, penalty);
}

/**
 * Metric penalties — penalizes CoC below 15% and IRR below 20%.
 * Tightened: 0.75 pts/pp (was 0.5), cap raised to 13.
 */
export function calculateMetricPenalties(coc, irr) {
    let penalty = 0;

    // CoC penalty: 0 at 15%+, 0.75 pts per pp below 15%
    if (coc < 15) {
        const gap = Math.min(15, 15 - coc);
        penalty += gap * 0.75;
    }

    // IRR penalty: 0 at 20%+, 0.75 pts per pp below 20%
    const irrPct = irr * 100;
    if (irrPct < 20) {
        const gap = Math.min(15, 20 - irrPct);
        penalty += gap * 0.75;
    }

    return Math.min(13, penalty); // cap at 13pts combined
}

export function getScoreColor(score) {
    if (score >= 85) return '#10b981';
    if (score >= 68) return '#3b82f6';
    if (score >= 48) return '#f59e0b';
    return '#ef4444';
}

export function getScoreRating(score) {
    if (score >= 85) return { text: 'Excellent Deal', cls: 'score-excellent' };
    if (score >= 68) return { text: 'Good Deal', cls: 'score-good' };
    if (score >= 48) return { text: 'Average Deal', cls: 'score-warning' };
    return { text: 'Poor Deal', cls: 'score-poor' };
}
