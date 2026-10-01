/**
 * Why the evaluator showed a loss.
 *
 * Holds ONE deal constant and changes ONLY the financing structure, using VOMCalc's
 * own calculation + scoring modules. Numbers are the Westport 2-bed Kassidy underwrote
 * on the 9/30 call (ask $429k, $60k/yr revenue, $1,900/mo fixed opex, 20% down) — ARV
 * left at the app's own fallback (listed price) because it drives exit equity, not cash flow.
 */
import { calculateAnnualCashFlows, calculateMOIC, calculateIRR, calculateAllTaxBenefits, calculateEquityMultiple } from '../public/js/calculations.js';
import { scoreEquityCreation, scoreSpeedOfCapital, scoreTaxEfficiency, scoreStability, calculateFrictionPenalty, calculateMetricPenalties } from '../public/js/scoring.js';
import { calculateMortgage } from '../public/js/utils.js';

function tranchePayment(t) {
  const amt = t.amount;
  if (!amt) return 0;
  if (t.interestOnly) return amt * (t.rate / 100) / 12;
  return calculateMortgage(amt, t.rate, t.termYears || 25);
}

function buildDeal(financing) {
  const listedPrice = 429000;
  const downPct = financing.downPaymentPct / 100;
  const revenue = 60000;
  const monthlyFixedOpex = 1900;
  const occupancy = 0.65;
  const annualOpex = monthlyFixedOpex * 12;
  const arv = listedPrice;                 // app fallback when ARV is blank
  const closingCostsPct = 0.03;
  const furnishingBudget = 15000;

  const downPayment = listedPrice * downPct;
  const debtTranches = financing.tranches.map(t => ({
    label: t.label, rate: t.rate, interestOnly: t.interestOnly, termYears: t.termYears,
    ltv: t.ltv, amount: Math.round(listedPrice * t.ltv / 100),
  }));
  const loanAmount = debtTranches.reduce((s, t) => s + t.amount, 0);
  const monthlyMortgage = debtTranches.reduce((s, t) => s + tranchePayment(t), 0);
  const annualDebtService = monthlyMortgage * 12;
  const totalEquity = downPayment + listedPrice * closingCostsPct + furnishingBudget;
  const noi = revenue - annualOpex;

  return {
    propertyType: 'str', listedPrice, downPct, renovationBudget: 0, furnishingBudget,
    arv, arvOverride: false, interestRate: debtTranches[0].rate, debtTranches,
    adr: 0, occupancyRate: occupancy, numKeys: 1, monthlyOpex: monthlyFixedOpex,
    monthlyFixedOpex, perStayCost: 0, annualVariableCosts: 0,
    holdPeriod: 5, annualAppreciation: 0.03, revenueGrowth: 0.02,
    exitCapRate: 0.09, marketCapRate: 0.08,
    householdIncome: 300000, filingStatus: 'married', closingCostsPct,
    downPayment, loanAmount, closingCosts: listedPrice * closingCostsPct,
    totalEquity, contingencyAmount: 0, totalRenoBudget: 0,
    constructionDuration: 0, constructionKeysOut: 0, rampUpMonths: 0, constructionPhases: [],
    constructionReservePreCalc: 0,
    annualRevenue: revenue, ancillaryRevenue: 0, totalRevenue: revenue,
    annualOpex, expenseRatio: annualOpex / revenue, ancillaryPct: 0,
    monthlyMortgage, annualDebtService, noi, annualCashFlow: noi - annualDebtService,
    refiPlanned: false, refiRate: 0, refiTimingMonths: 0, refiLTV: 0,
  };
}

function score(inputs) {
  const cashFlows = calculateAnnualCashFlows(inputs);
  const irr = calculateIRR(cashFlows);
  const allTax = calculateAllTaxBenefits(inputs);
  const year1 = allTax[0]?.taxSavings ?? 0;
  const totalTax = allTax.reduce((s, y) => s + (y?.taxSavings ?? 0), 0);
  const eqMultiple = calculateEquityMultiple(inputs);
  const st = scoreStability(inputs);
  const coc = inputs.totalEquity > 0 ? (inputs.annualCashFlow / inputs.totalEquity) * 100 : 0;
  const dscr = inputs.annualDebtService > 0 ? inputs.noi / inputs.annualDebtService : 0;
  const eq = scoreEquityCreation(eqMultiple), sp = scoreSpeedOfCapital(irr);
  const tx = scoreTaxEfficiency(totalTax, inputs.totalEquity, year1, inputs.householdIncome);
  const friction = calculateFrictionPenalty(inputs);
  const metric = calculateMetricPenalties(coc, irr);
  const total = Math.max(0, Math.min(100, Math.round(eq + sp + tx + st.score - friction - metric)));
  return {
    monthlyDS: Math.round(inputs.monthlyMortgage), annualDS: Math.round(inputs.annualDebtService),
    cashFlow: Math.round(inputs.annualCashFlow), coc: +coc.toFixed(1), dscr: +dscr.toFixed(2),
    equityMultiple: +eqMultiple.toFixed(2), irr: +(irr * 100).toFixed(1),
    year1Tax: Math.round(year1), equityScore: +eq.toFixed(1), speedScore: +sp.toFixed(1),
    taxScore: +tx.toFixed(1), cashScore: +st.score.toFixed(1),
    penalties: -Math.round((friction + metric) * 10) / 10, score: total,
  };
}

const scenarios = {
  'OLD DEFAULT — Bridge loan 70% LTV @12% interest-only, 3-yr balloon': { downPaymentPct: 30, tranches: [{ label: 'Bridge Loan', ltv: 70, rate: 12.0, interestOnly: true, termYears: 3 }] },
  'NEW DEFAULT — Conventional 80% LTV @7.5%, 30-yr P&I': { downPaymentPct: 20, tranches: [{ label: 'Conventional', ltv: 80, rate: 7.5, interestOnly: false, termYears: 30 }] },
  'Conventional 80% LTV @8.25%, 30-yr P&I (today\'s higher rate)': { downPaymentPct: 20, tranches: [{ label: 'Conventional', ltv: 80, rate: 8.25, interestOnly: false, termYears: 30 }] },
  'DSCR 75% LTV @7.75%, 30-yr P&I': { downPaymentPct: 25, tranches: [{ label: 'DSCR Loan', ltv: 75, rate: 7.75, interestOnly: false, termYears: 30 }] },
};

const rows = {};
for (const [name, f] of Object.entries(scenarios)) rows[name] = score(buildDeal(f));
console.log(JSON.stringify(rows, null, 2));
const a = rows['OLD DEFAULT — Bridge loan 70% LTV @12% interest-only, 3-yr balloon'];
const b = rows['NEW DEFAULT — Conventional 80% LTV @7.5%, 30-yr P&I'];
console.log(`\nSWING on the identical deal: cash flow $${a.cashFlow} -> $${b.cashFlow} (${b.cashFlow - a.cashFlow >= 0 ? '+' : ''}$${b.cashFlow - a.cashFlow}) · score ${a.score} -> ${b.score}`);
console.log(`Old default debt service $${a.monthlyDS}/mo at 12% IO vs $${b.monthlyDS}/mo conventional.`);
