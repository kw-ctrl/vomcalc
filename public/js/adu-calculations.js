/**
 * ADU Underwriter — pure calculation logic for VomCalc
 * Kirkland / Bothell ADU development deals: buy a lot with an existing house,
 * repurpose or renovate, build new units, and understand equity / cash-out / exit.
 *
 * Pure module: no DOM, no window — testable in Node and the browser.
 */
export const CITY_RULES = {
    Kirkland: {
        maxAduSqft: 1200,
        maxAdus: 2,
        coveredDeckExclusion: 200,
        ownerOccupancy: 'Not required',
        unitLotSubdivision: 'Allowed — ADUs may be sold separately',
        daduFarRelief: 'F.A.R. relief: first 500 sqft excluded (lots <8,500 sqft); 800 sqft (lots ≥8,500 sqft)',
        detachedHeight: '—',
        permitWeeks: [8, 16],
        zipDefault: '98033',
        strNote: 'Kirkland has low STR supply, and KZC 115.07 places no ADU-specific rental restrictions — running one unit as a short-term rental (ADU or main) is a legal workaround for year-round STR. Unit-lot subdivision lets you sell ADUs separately.',
    },
    Bothell: {
        maxAduSqft: 1200,
        maxAdus: 2,
        coveredDeckExclusion: 0,
        ownerOccupancy: 'Not required',
        unitLotSubdivision: 'Allowed (BMC 15.07)',
        daduFarRelief: '—',
        detachedHeight: '30 ft (33 ft over garage)',
        permitWeeks: [8, 16],
        zipDefault: '98011',
        strNote: 'Bothell allows 2 ADUs per lot with unit-lot subdivision. STR rules are tighter than Kirkland — verify short-term rental licensing before planning a STR unit.',
    },
    Custom: {
        maxAduSqft: 1300,
        maxAdus: 2,
        coveredDeckExclusion: 0,
        ownerOccupancy: 'Check local code',
        unitLotSubdivision: 'Check local code',
        daduFarRelief: '—',
        detachedHeight: '—',
        permitWeeks: [10, 20],
        zipDefault: '98033',
        strNote: 'Custom city — verify local ADU, STR, and subdivision rules before committing.',
    },
};

/** After-build comps + rental assumptions by zip. All "default — edit" market estimates (Aug 2026). */
export const ZIP_DATA = {
    '98033': { city: 'Kirkland', label: 'Kirkland — Rose Hill / Downtown', newMainCpsf: 700, aduCpsf: 520, rentPsf: 2.5, adr: 250, occupancy: 0.62 },
    '98034': { city: 'Kirkland', label: 'Kirkland — North / Finn Hill', newMainCpsf: 640, aduCpsf: 470, rentPsf: 2.3, adr: 230, occupancy: 0.60 },
    '98011': { city: 'Bothell', label: 'Bothell — East', newMainCpsf: 580, aduCpsf: 420, rentPsf: 2.2, adr: 215, occupancy: 0.58 },
    '98012': { city: 'Bothell', label: 'Bothell — West / Mill Creek', newMainCpsf: 560, aduCpsf: 400, rentPsf: 2.1, adr: 205, occupancy: 0.57 },
    '98021': { city: 'Bothell', label: 'Bothell — Canyon Park', newMainCpsf: 540, aduCpsf: 390, rentPsf: 2.0, adr: 200, occupancy: 0.57 },
};
export const FALLBACK_ZIP = { city: 'Custom', label: 'Custom comps', newMainCpsf: 600, aduCpsf: 440, rentPsf: 2.2, adr: 220, occupancy: 0.60 };

export const CONDITIONS = {
    turnkey:   { label: 'Turnkey',   renoCpsf: 35,  mainValueFactor: 0.95, buildMonths: 3 },
    light:     { label: 'Light refresh', renoCpsf: 45, mainValueFactor: 0.93, buildMonths: 4 },
    moderate:  { label: 'Major reno', renoCpsf: 90,  mainValueFactor: 0.90, buildMonths: 5 },
    full:      { label: 'Full gut reno', renoCpsf: 160, mainValueFactor: 0.97, buildMonths: 6 },
    teardown:  { label: 'Teardown',   renoCpsf: 0,   mainValueFactor: 1.00, buildMonths: 1 },
};

/** Default cost/financing assumptions — "default — edit" market estimates. */
export const DEFAULTS = {
    cpsfNewMain: 350, cpsfDetachedAdu: 315, cpsfAttachedAdu: 285, cpsfGarage: 150,
    softPct: 0.22, siteWorkBase: 15000, treeCostEach: 2500, demoCost: 30000,
    sideSewerCost: 20000, downPct: 0.20, constructionRate: 0.085, refiLtv: 0.75,
    cashOutThreshold: 0.20, taxesInsPct: 0.014, oppCostPct: 0.05, closingPct: 0.015,
    strExpensePct: 0.45, ltrOpexPct: 0.30, lotAllowsSecondAduMinSqft: 6500,
    newMainSqft: 1800, adu1Sqft: 800, adu2Sqft: 700,
};

/* ── helpers ─────────────────────────────────────────────── */
export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
export function num(v, fallback = 0) { const n = parseFloat(v); return isFinite(n) ? n : fallback; }
export function fmtMoney(v) {
    const n = Math.round(v);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');
}
export function fmtCompact(v) {
    const n = Math.round(v);
    const sign = n < 0 ? '-' : '';
    const a = Math.abs(n);
    const trim = (s) => s.replace(/\.?0+$/, '');
    if (a >= 1e9) return `${sign}$${trim((a / 1e9).toFixed(2))}B`;
    if (a >= 1e6) return `${sign}$${trim((a / 1e6).toFixed(2))}M`;
    if (a >= 1e3) return `${sign}$${trim((a / 1e3).toFixed(1))}K`;
    return `${sign}$${a}`;
}
export function fmtPct(v, digits = 1) { return `${(v * 100).toFixed(digits)}%`; }

export function resolveCityRules(inputs) {
    return CITY_RULES[inputs.city] || CITY_RULES.Custom;
}
export function resolveComps(inputs) {
    return ZIP_DATA[inputs.zip] || FALLBACK_ZIP;
}

/* ── 1. Configuration (the heart: sqft threshold drives main-vs-ADU) ── */
export function determineConfiguration(inputs) {
    const rules = resolveCityRules(inputs);
    const maxAduSqft = inputs.maxAduSqftOverride > 0 ? inputs.maxAduSqftOverride : rules.maxAduSqft;
    const teardown = inputs.condition === 'teardown';
    const hasExisting = inputs.existingHouseSqft > 0;
    const existingIsAdu = hasExisting && !teardown && inputs.existingHouseSqft < maxAduSqft;
    const lotAllowsSecondAdu = !!inputs.lotAllowsSecondAdu;

    const newMainSqft = Math.max(0, inputs.newMainSqft || 0);
    const adu1Sqft = Math.max(0, inputs.adu1Sqft || 0);
    const adu2Sqft = Math.max(0, inputs.adu2Sqft || 0);

    let mode, modeLabel, modeDetail, modeFlag, main, adu1, adu2;

    if (teardown) {
        mode = 'C';
        modeLabel = 'Teardown — demolish & rebuild';
        modeFlag = 'red';
        modeDetail = `Existing house (${inputs.existingHouseSqft.toLocaleString()} sqft) is marked teardown → demolish it, build a new main house, and add up to 2 new ADUs (lot permitting).`;
        main = { kind: 'new', label: 'New main house', sqft: newMainSqft || DEFAULTS.newMainSqft, cpsfKey: 'newMain', valueFactor: 1, buildMonths: 7, isNew: true };
        adu1 = { kind: 'detached', label: 'New detached ADU #1', sqft: adu1Sqft || DEFAULTS.adu1Sqft, cpsfKey: 'detachedAdu', valueFactor: 1, buildMonths: 5, isNew: true };
        adu2 = lotAllowsSecondAdu && adu2Sqft > 0 ? { kind: 'detached', label: 'New detached ADU #2', sqft: adu2Sqft, cpsfKey: 'detachedAdu', valueFactor: 1, buildMonths: 5, isNew: true } : null;
    } else if (!hasExisting) {
        mode = 'V';
        modeLabel = 'Vacant lot — build new main + ADUs';
        modeFlag = 'amber';
        modeDetail = `No existing house → build a new main house plus up to 2 new ADUs (lot permitting).`;
        main = { kind: 'new', label: 'New main house', sqft: newMainSqft || DEFAULTS.newMainSqft, cpsfKey: 'newMain', valueFactor: 1, buildMonths: 7, isNew: true };
        adu1 = { kind: 'detached', label: 'New detached ADU #1', sqft: adu1Sqft || DEFAULTS.adu1Sqft, cpsfKey: 'detachedAdu', valueFactor: 1, buildMonths: 5, isNew: true };
        adu2 = lotAllowsSecondAdu && adu2Sqft > 0 ? { kind: 'detached', label: 'New detached ADU #2', sqft: adu2Sqft, cpsfKey: 'detachedAdu', valueFactor: 1, buildMonths: 5, isNew: true } : null;
    } else if (existingIsAdu) {
        mode = 'B';
        modeLabel = 'Existing house becomes the ADU';
        modeFlag = 'green';
        modeDetail = `Existing house (${inputs.existingHouseSqft.toLocaleString()} sqft) is UNDER the ${maxAduSqft.toLocaleString()} sqft city max → repurpose it as ADU #1 and build a NEW main house${lotAllowsSecondAdu ? ' plus a second ADU' : ''}.`;
        main = { kind: 'new', label: 'New main house', sqft: newMainSqft || DEFAULTS.newMainSqft, cpsfKey: 'newMain', valueFactor: 1, buildMonths: 7, isNew: true };
        adu1 = { kind: 'repurposed', label: 'Existing house → ADU #1', sqft: inputs.existingHouseSqft, cpsfKey: null, valueFactor: 0.95, buildMonths: CONDITIONS[inputs.condition].buildMonths, isNew: false, renoCpsf: CONDITIONS[inputs.condition].renoCpsf };
        adu2 = lotAllowsSecondAdu && adu2Sqft > 0 ? { kind: 'detached', label: 'New detached ADU #2', sqft: adu2Sqft, cpsfKey: 'detachedAdu', valueFactor: 1, buildMonths: 5, isNew: true } : null;
    } else {
        mode = 'A';
        modeLabel = 'Existing house stays the main house';
        modeFlag = 'blue';
        modeDetail = `Existing house (${inputs.existingHouseSqft.toLocaleString()} sqft) is AT/ABOVE the ${maxAduSqft.toLocaleString()} sqft city max → keep it as the main house and add ADUs${lotAllowsSecondAdu ? ' (attached + detached)' : ''}.`;
        main = { kind: 'existing', label: 'Existing house (main)', sqft: inputs.existingHouseSqft, cpsfKey: null, valueFactor: CONDITIONS[inputs.condition].mainValueFactor, buildMonths: CONDITIONS[inputs.condition].buildMonths, isNew: false, renoCpsf: CONDITIONS[inputs.condition].renoCpsf };
        adu1 = { kind: 'attached', label: 'Attached ADU (addition)', sqft: adu1Sqft || DEFAULTS.adu1Sqft, cpsfKey: 'attachedAdu', valueFactor: 0.95, buildMonths: 5, isNew: true };
        adu2 = lotAllowsSecondAdu && adu2Sqft > 0 ? { kind: 'detached', label: 'New detached ADU #2', sqft: adu2Sqft, cpsfKey: 'detachedAdu', valueFactor: 1, buildMonths: 5, isNew: true } : null;
    }

    return {
        mode, modeLabel, modeDetail, modeFlag,
        maxAduSqft, rules, teardown, existingIsAdu, lotAllowsSecondAdu,
        main, adu1, adu2,
        units: [main, adu1, adu2].filter(Boolean),
    };
}

/* ── 2. Hard costs ───────────────────────────────────────── */
export function computeHardCosts(inputs, config, a) {
    const lines = [];
    const cpsf = {
        newMain: a.cpsfNewMain, detachedAdu: a.cpsfDetachedAdu,
        attachedAdu: a.cpsfAttachedAdu, garage: a.cpsfGarage,
    };
    const cond = CONDITIONS[inputs.condition] || CONDITIONS.light;

    for (const u of config.units) {
        if (u.kind === 'existing') {
            lines.push({ label: u.label, detail: `${u.sqft.toLocaleString()} sqft × $${cond.renoCpsf}/sqft (${cond.label})`, amount: u.sqft * cond.renoCpsf, group: 'reno' });
        } else if (u.kind === 'repurposed') {
            lines.push({ label: u.label, detail: `${u.sqft.toLocaleString()} sqft × $${cond.renoCpsf}/sqft (${cond.label} + ADU conversion)`, amount: u.sqft * cond.renoCpsf, group: 'reno' });
        } else {
            lines.push({ label: u.label, detail: `${u.sqft.toLocaleString()} sqft × $${cpsf[u.cpsfKey]}/sqft (new build)`, amount: u.sqft * cpsf[u.cpsfKey], group: 'new' });
        }
    }

    if (config.teardown) {
        lines.push({ label: 'Demolition', detail: 'Remove existing structure', amount: a.demoCost, group: 'demo' });
    }

    // Site work with deal-quality adjustments
    let siteWork = a.siteWorkBase;
    const adj = [];
    const accessAdj = { alley: -3000, corner: -1000, standard: 0, narrow: 5000 }[inputs.access] || 0;
    if (accessAdj !== 0) adj.push(`${({ alley: 'Alley access', corner: 'Corner lot', narrow: 'Narrow frontage' })[inputs.access]}: ${fmtMoney(accessAdj)}`);
    siteWork += accessAdj;
    const shapeAdj = { wide: 0, deepNarrow: 3000, irregular: 2000 }[inputs.lotShape] || 0;
    if (shapeAdj !== 0) adj.push(`Lot shape (${inputs.lotShape}): ${fmtMoney(shapeAdj)}`);
    siteWork += shapeAdj;
    const treeCost = inputs.treesToRemove * a.treeCostEach;
    if (treeCost > 0) adj.push(`${inputs.treesToRemove} tree(s) to remove × ${fmtMoney(a.treeCostEach)}`);
    siteWork += treeCost;
    siteWork = Math.max(0, siteWork);
    lines.push({ label: 'Site work', detail: adj.length ? `Base ${fmtMoney(a.siteWorkBase)} · ${adj.join(' · ')}` : `Base ${fmtMoney(a.siteWorkBase)}`, amount: siteWork, group: 'site' });

    const total = lines.reduce((s, l) => s + l.amount, 0);
    return { lines, total };
}

/* ── 3. Soft costs ───────────────────────────────────────── */
export function computeSoftCosts(inputs, hardTotal, a, closingCosts) {
    const lines = [];
    const permitsArchEng = hardTotal * a.softPct;
    lines.push({
        label: 'Permits, architect, engineering, impact fees & contingency',
        detail: `${fmtPct(a.softPct, 0)} of hard costs (20–25% typical)`,
        amount: permitsArchEng,
    });
    if (inputs.sideSewerNeeded) {
        lines.push({
            label: 'Side sewer replacement',
            detail: `Pre-1986 home (built ${inputs.yearBuilt}) — often required by the city`,
            amount: a.sideSewerCost,
        });
    }
    lines.push({
        label: 'Acquisition closing costs',
        detail: `${fmtPct(a.closingPct, 1)} of purchase price`,
        amount: closingCosts,
    });
    const total = lines.reduce((s, l) => s + l.amount, 0);
    return { lines, total };
}

/* ── 4. Timeline ─────────────────────────────────────────── */
export function computeTimeline(inputs, config) {
    const rules = resolveCityRules(inputs);
    let permitWeeks = (rules.permitWeeks[0] + rules.permitWeeks[1]) / 2; // midpoint of city range
    const notes = [`${permitWeeks} wks base (${rules.permitWeeks[0]}–${rules.permitWeeks[1]} city range)`];
    if (inputs.treesToRemove > 0) { permitWeeks += 2; notes.push('+2 wks tree removal'); }
    if (inputs.access === 'narrow') { permitWeeks += 2; notes.push('+2 wks narrow access'); }

    const unitMonths = config.units.map(u => ({ label: u.label, months: u.buildMonths }));
    const buildMonths = inputs.buildSequential
        ? unitMonths.reduce((s, u) => s + u.months, 0)
        : Math.max(0, ...unitMonths.map(u => u.months));
    const totalMonths = permitWeeks / 4.345 + buildMonths;
    return { permitWeeks, buildMonths, totalMonths, notes, unitMonths };
}

/* ── 5. Financing + carrying ─────────────────────────────── */
export function computeFinancing(inputs, hardTotal, softTotal) {
    const projectBase = inputs.purchasePrice + hardTotal + softTotal;
    const cashInvested = projectBase * inputs.downPct;
    const baseLoan = projectBase - cashInvested;
    return { projectBase, cashInvested, baseLoan };
}

export function computeCarrying(inputs, financing, months, a) {
    const avgDraw = financing.baseLoan * 0.55; // construction draws ramp ~0→100%; land is fully drawn from day 1
    const interest = avgDraw * inputs.constructionRate * months / 12;
    const taxesIns = inputs.purchasePrice * a.taxesInsPct * months / 12;
    const oppCost = financing.cashInvested * a.oppCostPct * months / 12;
    return {
        interest, taxesIns, oppCost,
        total: interest + taxesIns + oppCost,
    };
}

/* ── 6. Exit value (after-build, by zip comps) ───────────── */
export function computeExitValue(config, comps) {
    const lines = config.units.map(u => {
        const isMain = u.cpsfKey === 'newMain';
        const baseCpsf = isMain ? comps.newMainCpsf : comps.aduCpsf;
        let reason = '';
        if (!u.isNew && u.kind === 'existing') reason = `existing structure, ${fmtPct(u.valueFactor, 0)} of new-build comp`;
        else if (u.kind === 'repurposed') reason = `repurposed existing structure, ${fmtPct(u.valueFactor, 0)} of new-build comp`;
        else if (u.cpsfKey === 'attachedAdu') reason = `attached unit, ${fmtPct(u.valueFactor, 0)} of detached comp`;
        const cpsf = baseCpsf * u.valueFactor;
        const value = u.sqft * cpsf;
        return {
            label: u.label, sqft: u.sqft,
            detail: `${u.sqft.toLocaleString()} sqft × ${fmtMoney(cpsf)}/sqft${reason ? ` — ${reason}` : ''}`,
            cpsf, value,
        };
    });
    const total = lines.reduce((s, l) => s + l.value, 0);
    return { lines, total };
}

/* ── 7. Equity & cash-out ────────────────────────────────── */
export function computeEquity(inputs, totalCost, afterBuildValue, cashInvested, loanBalance) {
    const equity = afterBuildValue - totalCost;
    const equityPct = afterBuildValue > 0 ? equity / afterBuildValue : 0;
    const refiMaxLoan = afterBuildValue * inputs.refiLtv;
    const cashOut = Math.max(0, refiMaxLoan - loanBalance);
    const netCashBack = cashOut - cashInvested;
    const eligible = equityPct > inputs.cashOutThreshold;
    return { equity, equityPct, refiMaxLoan, cashOut, netCashBack, eligible, threshold: inputs.cashOutThreshold };
}

/* ── 8. Exit strategy recommendation ─────────────────────── */
function unitStrNoi(u, comps, isAdu, a) {
    const adr = comps.adr * (isAdu ? 0.85 : 1);
    return adr * comps.occupancy * 365 * (1 - a.strExpensePct);
}
function unitLtrNoi(u, comps, a) {
    return comps.rentPsf * u.sqft * 12 * (1 - a.ltrOpexPct);
}

export function computeExitStrategies(inputs, config, comps, totalCost, afterBuildValue, cashInvested, equityPct, a) {
    const unitNos = config.units.map(u => {
        const isAdu = u.cpsfKey !== 'newMain';
        return {
            label: u.label, sqft: u.sqft, isAdu,
            strNoi: unitStrNoi(u, comps, isAdu, a),
            ltrNoi: unitLtrNoi(u, comps, a),
        };
    });
    const strTotal = unitNos.reduce((s, u) => s + u.strNoi, 0);
    const ltrTotal = unitNos.reduce((s, u) => s + u.ltrNoi, 0);
    const profit = afterBuildValue - totalCost;
    // Hybrid STR pick: in Kirkland prefer an ADU — no ADU-specific STR restriction in
    // KZC 115.07 makes it the legal workaround for year-round STR. Else pick max NOI.
    const adus = unitNos.filter(u => u.isAdu);
    const bestStr = inputs.city === 'Kirkland' && adus.length
        ? [...adus].sort((x, y) => y.strNoi - x.strNoi)[0]
        : [...unitNos].sort((x, y) => y.strNoi - x.strNoi)[0] || null;
    const hybridNoi = bestStr
        ? bestStr.strNoi + unitNos.filter(u => u !== bestStr).reduce((s, u) => s + u.ltrNoi, 0)
        : 0;

    const paths = [
        { id: 'sell', name: 'Sell (flip)', desc: 'Sell all units — whole or condominiumized via unit-lot subdivision', annualNoi: 0, returnLabel: 'Net profit', returnVal: profit, coc: cashInvested > 0 ? profit / cashInvested : 0, kind: 'sell' },
        { id: 'str', name: 'STR (all units)', desc: 'Short-term rent every unit', annualNoi: strTotal, returnLabel: 'Annual NOI', returnVal: strTotal, coc: cashInvested > 0 ? strTotal / cashInvested : 0, kind: 'rent' },
        { id: 'hybrid', name: 'Hybrid — 1 STR + LTR', desc: bestStr ? `STR the ${bestStr.label.toLowerCase()} (${fmtMoney(Math.round(bestStr.strNoi))}/yr net), LTR the rest` : '', annualNoi: hybridNoi, returnLabel: 'Annual NOI', returnVal: hybridNoi, coc: cashInvested > 0 ? hybridNoi / cashInvested : 0, kind: 'rent' },
        { id: 'ltr', name: 'LTR (all units)', desc: 'Long-term rent every unit', annualNoi: ltrTotal, returnLabel: 'Annual NOI', returnVal: ltrTotal, coc: cashInvested > 0 ? ltrTotal / cashInvested : 0, kind: 'rent' },
    ];
    const ranked = [...paths].sort((x, y) => y.coc - x.coc);
    const doNotProceed = equityPct < 0;
    const recommended = doNotProceed ? 'none' : ranked[0].id;

    const insight = inputs.city === 'Kirkland'
        ? { title: 'Kirkland STR insight', body: 'Low STR supply in Kirkland + no ADU-specific rental restrictions in KZC 115.07 → run ONE unit as a STR (an ADU or the main house) as a legal workaround for year-round STR; rent the rest long-term. If equity clears the cash-out threshold, refi and pull cash out — velocity of money.' }
        : inputs.city === 'Bothell'
            ? { title: 'Bothell note', body: '2 ADUs/lot with unit-lot subdivision (BMC 15.07) gives you sellable units, but STR licensing is tighter than Kirkland — confirm short-term rental rules before planning a STR unit.' }
            : null;

    return { unitNos, paths, ranked, recommended, doNotProceed, insight };
}

/* ── Orchestrator ────────────────────────────────────────── */
export function runUnderwrite(rawInputs) {
    const inputs = { ...rawInputs };
    // Normalize
    inputs.purchasePrice = num(inputs.purchasePrice);
    inputs.lotSizeSqft = num(inputs.lotSizeSqft);
    inputs.existingHouseSqft = Math.max(0, num(inputs.existingHouseSqft));
    inputs.yearBuilt = num(inputs.yearBuilt, 1975);
    inputs.condition = inputs.condition || 'light';
    inputs.city = inputs.city || 'Kirkland';
    inputs.zip = (inputs.zip || '').toString().trim() || CITY_RULES[inputs.city]?.zipDefault || '98033';
    inputs.maxAduSqftOverride = Math.max(0, num(inputs.maxAduSqftOverride));
    inputs.newMainSqft = num(inputs.newMainSqft);
    inputs.adu1Sqft = num(inputs.adu1Sqft);
    inputs.adu2Sqft = num(inputs.adu2Sqft);
    inputs.lotAllowsSecondAdu = !!inputs.lotAllowsSecondAdu;
    inputs.buildSequential = !!inputs.buildSequential;
    inputs.access = inputs.access || 'standard';
    inputs.lotShape = inputs.lotShape || 'wide';
    inputs.treesToRemove = Math.max(0, num(inputs.treesToRemove));
    inputs.sideSewerNeeded = !!inputs.sideSewerNeeded;

    const a = {
        cpsfNewMain: num(inputs.cpsfNewMain, DEFAULTS.cpsfNewMain),
        cpsfDetachedAdu: num(inputs.cpsfDetachedAdu, DEFAULTS.cpsfDetachedAdu),
        cpsfAttachedAdu: num(inputs.cpsfAttachedAdu, DEFAULTS.cpsfAttachedAdu),
        cpsfGarage: num(inputs.cpsfGarage, DEFAULTS.cpsfGarage),
        softPct: num(inputs.softPct, DEFAULTS.softPct) / 100,
        siteWorkBase: num(inputs.siteWorkBase, DEFAULTS.siteWorkBase),
        treeCostEach: num(inputs.treeCostEach, DEFAULTS.treeCostEach),
        demoCost: num(inputs.demoCost, DEFAULTS.demoCost),
        sideSewerCost: num(inputs.sideSewerCost, DEFAULTS.sideSewerCost),
        taxesInsPct: num(inputs.taxesInsPct, DEFAULTS.taxesInsPct) / 100,
        oppCostPct: num(inputs.oppCostPct, DEFAULTS.oppCostPct) / 100,
        closingPct: num(inputs.closingPct, DEFAULTS.closingPct) / 100,
        strExpensePct: DEFAULTS.strExpensePct,
        ltrOpexPct: DEFAULTS.ltrOpexPct,
    };
    inputs.downPct = num(inputs.downPct, DEFAULTS.downPct) / 100;
    inputs.constructionRate = num(inputs.constructionRate, DEFAULTS.constructionRate) / 100;
    inputs.refiLtv = num(inputs.refiLtv, DEFAULTS.refiLtv) / 100;
    inputs.cashOutThreshold = num(inputs.cashOutThreshold, DEFAULTS.cashOutThreshold) / 100;

    const compsRaw = resolveComps(inputs);
    const comps = {
        newMainCpsf: num(inputs.compNewMainCpsf, compsRaw.newMainCpsf),
        aduCpsf: num(inputs.compAduCpsf, compsRaw.aduCpsf),
        rentPsf: num(inputs.compRentPsf, compsRaw.rentPsf),
        adr: num(inputs.compAdr, compsRaw.adr),
        occupancy: num(inputs.compOccupancy, compsRaw.occupancy),
    };

    const config = determineConfiguration(inputs);
    const hard = computeHardCosts(inputs, config, a);
    const closingCosts = inputs.purchasePrice * a.closingPct;
    const soft = computeSoftCosts(inputs, hard.total, a, closingCosts);
    const timeline = computeTimeline(inputs, config);
    const financing = computeFinancing(inputs, hard.total, soft.total);
    const carrying = computeCarrying(inputs, financing, timeline.totalMonths, a);
    const totalCost = inputs.purchasePrice + hard.total + soft.total + carrying.total;
    const loanBalance = totalCost - financing.cashInvested;
    const exitValue = computeExitValue(config, comps);
    const equity = computeEquity(inputs, totalCost, exitValue.total, financing.cashInvested, loanBalance);
    const exitStrategies = computeExitStrategies(inputs, config, comps, totalCost, exitValue.total, financing.cashInvested, equity.equityPct, a);

    return {
        inputs, a, comps, config, hard, soft, closingCosts, timeline,
        financing, carrying, totalCost, loanBalance,
        exitValue, equity, exitStrategies,
    };
}

/* Reference sample (used by tests + the page's "Load sample deal" button) */
export function sampleInputs() {
    return {
        purchasePrice: 800000, lotSizeSqft: 6000, existingHouseSqft: 1100, yearBuilt: 1975,
        condition: 'light', city: 'Kirkland', zip: '98033',
        maxAduSqftOverride: 0, newMainSqft: 1800, adu1Sqft: 800, adu2Sqft: 700,
        lotAllowsSecondAdu: false, buildSequential: false,
        access: 'standard', lotShape: 'wide', treesToRemove: 0,
        downPct: 20, constructionRate: 8.5, refiLtv: 75, cashOutThreshold: 20,
        sideSewerNeeded: true, sideSewerCost: 20000,
        cpsfNewMain: 350, cpsfDetachedAdu: 315, cpsfAttachedAdu: 285, cpsfGarage: 150,
        softPct: 22, siteWorkBase: 15000, treeCostEach: 2500, demoCost: 30000,
        taxesInsPct: 1.4, oppCostPct: 5, closingPct: 1.5,
    };
}
