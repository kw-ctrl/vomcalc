/**
 * Rendering — all DOM manipulation and display logic
 */

import { formatCurrency, formatPercent } from './utils.js';
import { getScoreColor, getScoreRating } from './scoring.js';
import { calculateAnnualCashFlows, calculateMOIC, calculateProForma } from './calculations.js';
import { buildInputsAtPrice } from './scenarios.js';

export function renderResults(r, gatherInputs) {
    document.querySelectorAll('.result-section.is-empty').forEach(s => s.classList.remove('is-empty'));

    renderScoreSection(r);
    // renderDealVerdict(r); // removed
    renderRevenueCashFlowSummary(r);
    renderDealFlags(r);
    renderCapitalRaiseSummary(r);
    renderBuyBoxSection(r, gatherInputs);
    // renderScenariosSection(r); // removed per product decision
    renderCashFlowTable(r);
    renderAttributionSection(r);
    renderSensitivityTable(r, gatherInputs);
    renderCapitalRecommendations(r);
    renderLeversSection(r);
}

function renderScoreSection(r) {
    const maxDash = 2 * Math.PI * 42;
    const filled = (r.totalScore / 100) * maxDash;
    const arc = document.getElementById('scoreArc');
    arc.style.strokeDasharray = `${filled} ${maxDash}`;
    arc.style.stroke = getScoreColor(r.totalScore);
    document.getElementById('scoreText').textContent = r.totalScore;

    const rating = getScoreRating(r.totalScore);
    const ratingEl = document.getElementById('scoreRating');
    ratingEl.textContent = rating.text;
    ratingEl.className = `text-center text-sm font-semibold mt-1 ${rating.cls}`;

    setBar('catEquity', r.equityScore, 40);
    setBar('catSpeed', r.speedScore, 25);
    setBar('catTax', r.taxScore, 15);
    setBar('catStability', r.stabilityScore, 20);

    // Show methodology section
    const methSection = document.getElementById('methodologySection');
    if (methSection) methSection.style.display = 'block';

    // Populate methodology detail fields
    _populateMethodology(r);

    // Inline metric display on bars
    const moicEl = document.getElementById('catEquityMoicDisplay');
    if (moicEl && r.equityMultiple != null) {
        moicEl.textContent = `${r.equityMultiple.toFixed(2)}x exit · ${r.moic?.toFixed(2) ?? '--'}x total`;
    }

    const irrEl = document.getElementById('catSpeedIrrDisplay');
    if (irrEl && r.irr) irrEl.textContent = (r.irr * 100).toFixed(1) + '% IRR';

    const taxEl = document.getElementById('catTaxDisplay');
    if (taxEl) {
        const yr1 = r.year1TaxBenefits || 0;
        const total = r.totalTaxBenefits || 0;
        taxEl.textContent = formatCurrency(yr1) + ' yr1 · ' + formatCurrency(total) + ' total';
    }

    const cocEl = document.getElementById('catCocDisplay');
    if (cocEl && r.stabilityResult) {
        const coc = r.stabilityResult.coc || 0;
        cocEl.textContent = coc.toFixed(1) + '% CoC';
    }

    // DSCR display
    const dscrEl = document.getElementById('dscrDisplay');
    if (dscrEl) {
        dscrEl.textContent = `DSCR: ${r.dscr.toFixed(2)}x`;
        dscrEl.className = 'dscr-display' + (r.dscrFlag ? ' dscr-danger' : '');
        dscrEl.style.display = 'inline-block';
    }

    // LTV display
    const ltvEl = document.getElementById('ltvDisplay');
    if (ltvEl) {
        ltvEl.textContent = `LTV at Exit: ${(r.stabilizedLTV * 100).toFixed(0)}%`;
        ltvEl.className = 'dscr-display' + (r.underLeveragedFlag ? ' ltv-warning' : '');
        ltvEl.style.display = 'inline-block';
    }
}

function renderDealVerdict(r) {
    const card = document.getElementById('dealVerdictCard');
    const oneLinerEl = document.getElementById('dealVerdictOneLiner');
    const bodyEl = document.getElementById('dealVerdictBody');
    if (!card || !oneLinerEl || !bodyEl) return;

    const score = r.totalScore || 0;
    const moic = r.moic || 0;
    const irr = r.irr || 0;
    const coc = r.coc || 0;
    const hold = r.inputs?.holdPeriod || 5;
    const price = r.inputs?.listedPrice || 0;
    const equity = r.totalEquity || r.inputs?.downPayment || 0;
    const em = r.equityMultiple || 0;
    const annualCF = r.annualCashFlow || 0;
    const monthlyCF = annualCF / 12;
    const propertyType = (r.inputs?.propertyType || 'str').toLowerCase();
    const isSTR = propertyType === 'str';

    // ── One-liner: multiplier + speed rating ────────────────────────────────
    let speedTag = '';
    if (em >= 3.5) speedTag = "🔥 That's elite — barely happens.";
    else if (em >= 2.8) speedTag = "🚀 That's fast. Really fast.";
    else if (em >= 2.0) speedTag = "💪 Solid. Money working.";
    else if (em >= 1.5) speedTag = "📈 It works. Not sexy, but it works.";
    else if (em >= 1.2) speedTag = "😐 That's… slow. You can do better.";
    else speedTag = "🚨 You're barely breaking even on capital. Renegotiate.";

    const emDisplay = em > 0 ? `${em.toFixed(1)}×` : 'your money';
    const oneLiner = em > 0
        ? `This deal will turn every dollar you invest into ${emDisplay} in ${hold} years. ${speedTag}`
        : `Running the numbers on this one… ${speedTag}`;
    oneLinerEl.textContent = oneLiner;

    // ── Body: plain-English explanation ─────────────────────────────────────
    const parts = [];

    // Lead — deal quality (thresholds match scoring bands: 85/68/48)
    if (score >= 85) {
        parts.push(`Strong deal across the board. The score isn't luck — the cash flow, the equity build, and the tax math all line up.`);
    } else if (score >= 68) {
        parts.push(`Solid deal with real upside. Not perfect, but the fundamentals work and there's room to optimize once you're in.`);
    } else if (score >= 48) {
        parts.push(`This one has potential but it's not running away from you. The numbers are fine — not great, not bad.`);
    } else if (score >= 30) {
        parts.push(`Proceed with caution. The deal has weak spots that could turn into real problems if anything doesn't go to plan.`);
    } else {
        parts.push(`Honestly? The numbers don't work right now. This isn't a deal — it's a liability until the price comes down or the income goes up.`);
    }

    // Cash flow sentence
    if (monthlyCF > 2000) {
        parts.push(`You're looking at ~$${Math.round(monthlyCF / 100) * 100}/month in your pocket after every expense — that's real cash flow.`);
    } else if (monthlyCF > 500) {
        parts.push(`Monthly cash flow is modest (~$${Math.round(monthlyCF / 100) * 100}/mo) but positive. It won't make you rich but it won't drain you either.`);
    } else if (monthlyCF > 0) {
        parts.push(`Cash flow is thin — barely over break-even after expenses. One soft month and you're covering the gap out of pocket.`);
    } else {
        parts.push(`This thing is cash flow negative. You're feeding it every month, betting on appreciation to bail you out. That's a gamble.`);
    }

    // IRR / return quality
    if (irr >= 25) {
        parts.push(`A ${irr.toFixed(0)}% IRR puts this in the top tier of real estate returns. Your capital is working hard.`);
    } else if (irr >= 18) {
        parts.push(`${irr.toFixed(0)}% IRR is solid — well above what most passive investments could touch.`);
    } else if (irr >= 12) {
        parts.push(`${irr.toFixed(0)}% IRR is decent. Not life-changing, but respectable for a stabilized asset.`);
    } else if (irr > 0) {
        parts.push(`At ${irr.toFixed(0)}% IRR, you'd need to ask yourself if the headache of owning real estate is worth it versus just parking money in index funds.`);
    }

    // STR-specific angle
    if (isSTR && coc >= 20) {
        parts.push(`The STR income is doing the heavy lifting here. Keep occupancy up and this outperforms most conventional rentals by miles.`);
    } else if (isSTR && coc < 10) {
        parts.push(`For an STR, a sub-10% cash-on-cash is a yellow flag. Either the revenue assumption needs work or the price needs to come down.`);
    }

    // CoC context
    if (coc >= 25) {
        parts.push(`${coc.toFixed(0)}% cash-on-cash is exceptional — your equity invested is generating outsized yield.`);
    }

    // Bottom line
    if (score >= 68) {
        parts.push(`Bottom line: run it.`);
    } else if (score >= 48) {
        parts.push(`Bottom line: worth a deeper look — negotiate on price before you commit.`);
    } else {
        parts.push(`Bottom line: pass unless you can change the entry price or revenue story significantly.`);
    }

    bodyEl.textContent = parts.join(' ');

    // Show card
    card.style.display = 'block';
}

function renderRevenueCashFlowSummary(r) {
    const container = document.getElementById('revenueCashFlowSummary');
    if (!container) return;
    container.style.display = 'block';
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setClass = (id, cls) => { const el = document.getElementById(id); if (el) el.className = cls; };

    setText('summaryAnnualRev', formatCurrency(r.totalRevenue));
    const revPerKey = r.numKeys > 0 ? r.totalRevenue / r.numKeys : 0;
    document.getElementById('summaryRevPerKey').textContent =
        r.numKeys > 1 ? `${formatCurrency(revPerKey)} / key` : '';

    document.getElementById('summaryADR').textContent = '$' + Math.round(r.adr);

    // Show ADR in sidebar near occupancy slider
    const sidebarADR = document.getElementById('sidebarADRValue');
    const sidebarADRDisplay = document.getElementById('sidebarADRDisplay');
    if (sidebarADR) sidebarADR.textContent = '$' + Math.round(r.adr);
    if (sidebarADRDisplay) sidebarADRDisplay.style.display = 'block';

    document.getElementById('summaryAnnualExp').textContent = formatCurrency(r.annualOpex);

    // Total MOIC (all CFs + exit) — the headline return number
    const moicSumEl = document.getElementById('summaryMOIC');
    if (moicSumEl) moicSumEl.textContent = r.moic ? r.moic.toFixed(2) + 'x' : '--';

    // Exit equity multiple sub-label (property-only, drives score)
    const exitMultiEl = document.getElementById('summaryEquityExitMultiple');
    if (exitMultiEl && r.equityMultiple) {
        exitMultiEl.textContent = `${r.equityMultiple.toFixed(2)}x exit equity`;
    }

    const irrSumEl = document.getElementById('summaryIRR');
    if (irrSumEl) irrSumEl.textContent = r.irr ? (r.irr * 100).toFixed(1) + '%' : '--';

    // Total capital with breakdown tooltip
    const capEl = document.getElementById('summaryTotalCapital');
    if (capEl) {
        capEl.textContent = r.totalEquity ? formatCurrency(r.totalEquity) : '--';
        // Build breakdown as title attribute
        const parts = [];
        if (r.downPayment) parts.push(`Down: ${formatCurrency(r.downPayment)}`);
        if (r.closingCosts) parts.push(`Closing: ${formatCurrency(r.closingCosts)}`);
        if (r.renovationBudget) parts.push(`Reno: ${formatCurrency(r.renovationBudget)}`);
        if (r.furnishingBudget) parts.push(`Furnish: ${formatCurrency(r.furnishingBudget)}`);
        if (r.contingencyAmount) parts.push(`Contingency: ${formatCurrency(r.contingencyAmount)}`);
        if (parts.length) capEl.title = parts.join(' · ');
    }

    // Monthly CF sub-label
    const monthlySub = document.getElementById('summaryMonthlyCFSub');
    if (monthlySub) {
        const mo = r.annualCashFlow / 12;
        monthlySub.textContent = formatCurrency(mo) + '/mo';
    }

    // NOI (excludes tax benefits and debt service)
    const noiEl = document.getElementById('summaryNOI');
    if (noiEl) {
        noiEl.textContent = formatCurrency(r.noi);
        noiEl.className = 'font-bold text-lg ' + (r.noi < 0 ? 'text-red-400' : 'text-white');
    }
    const noiNote = document.getElementById('summaryNOINote');
    if (noiNote) noiNote.textContent = 'Excl. tax benefits & debt';

    // Show per-stay cost annual estimate
    const perStayAnnual = document.getElementById('perStayCostAnnual');
    if (perStayAnnual && r.inputs && r.inputs.annualVariableCosts > 0) {
        perStayAnnual.textContent = `≈ ${formatCurrency(r.inputs.annualVariableCosts)}/yr variable costs`;
        perStayAnnual.style.display = 'block';
    } else if (perStayAnnual) {
        perStayAnnual.style.display = 'none';
    }

    const monthlyCF = r.annualCashFlow / 12;
    const monthlyCFEl = document.getElementById('summaryMonthlyCF');
    if (monthlyCFEl) {
        monthlyCFEl.textContent = formatCurrency(monthlyCF);
        monthlyCFEl.className = 'font-bold text-lg ' + (monthlyCF < 0 ? 'text-red-400' : 'text-white');
    }

    const annualCFEl = document.getElementById('summaryAnnualCF');
    if (annualCFEl) {
        annualCFEl.textContent = formatCurrency(r.annualCashFlow);
        annualCFEl.className = 'font-bold text-lg ' + (r.annualCashFlow < 0 ? 'text-red-400' : 'text-white');
    }

    const coc = r.totalEquity > 0 ? (r.annualCashFlow / r.totalEquity) * 100 : 0;
    const cocEl = document.getElementById('summaryCOC');
    if (cocEl) {
        cocEl.textContent = formatPercent(coc);
        cocEl.className = 'font-bold text-lg ' + (coc < 0 ? 'text-red-400' : 'text-white');
    }

    document.getElementById('summaryExpRatio').textContent = formatPercent(r.expenseRatio * 100);
    document.getElementById('summaryExpRatioNote').textContent = 'excl. debt service';
}

function renderDealFlags(r) {
    const container = document.getElementById('dealFlags');
    if (!container) return;

    const flags = [];

    // Compute unified ADR increase target: use the stricter of DSCR 1.25x or break-even
    const dscrTargetNOI = r.annualDebtService * 1.25;
    const dscrNOIGap = dscrTargetNOI - r.noi;
    const dscrADRIncrease = r.numKeys > 0 && r.occupancyRate > 0
        ? Math.ceil(dscrNOIGap / (r.occupancyRate * 365 * r.numKeys))
        : 0;

    if (r.noi < 0) {
        const deficit = r.annualOpex - r.totalRevenue;
        // Use DSCR target if also flagged (it's the stricter requirement)
        const adrNeeded = r.dscrFlag ? dscrADRIncrease : (r.numKeys > 0 && r.occupancyRate > 0
            ? Math.ceil(deficit / (r.occupancyRate * 365 * r.numKeys))
            : 0);
        flags.push(`<div class="warning-banner warning-red">
            <span class="warning-icon">&#9888;</span>
            <div><strong>Operating Expenses Exceed Revenue</strong> — Expenses (${formatCurrency(r.annualOpex)}) exceed revenue (${formatCurrency(r.totalRevenue)}) by ${formatCurrency(deficit)}/yr. Increase ADR by $${adrNeeded} or reduce monthly expenses by ${formatCurrency(deficit / 12)}/mo to break even.</div>
        </div>`);
    } else if (r.annualCashFlow < 0) {
        const shortfall = Math.abs(r.annualCashFlow);
        const monthlyShortfall = shortfall / 12;
        // Use DSCR target if also flagged (it's the stricter requirement)
        const adrIncrease = r.dscrFlag ? dscrADRIncrease : (r.numKeys > 0 && r.occupancyRate > 0
            ? Math.ceil(shortfall / (r.occupancyRate * 365 * r.numKeys))
            : 0);
        flags.push(`<div class="warning-banner warning-red">
            <span class="warning-icon">&#9888;</span>
            <div><strong>Negative Cash Flow (${formatCurrency(r.annualCashFlow)}/yr)</strong> — NOI of ${formatCurrency(r.noi)} doesn't cover debt service of ${formatCurrency(r.annualDebtService)}. Increase ADR by $${adrIncrease}, reduce expenses by ${formatCurrency(monthlyShortfall)}/mo, or increase down payment to reduce debt load.</div>
        </div>`);
    }

    if (r.dscrFlag) {
        // Only show separate DSCR flag if there's no cash flow flag already showing the same ADR target
        const alreadyCovered = r.noi < 0 || r.annualCashFlow < 0;
        const monthlyExpReduction = dscrNOIGap / 12;
        if (!alreadyCovered) {
            flags.push(`<div class="warning-banner warning-red">
                <span class="warning-icon">&#9888;</span>
                <div><strong>Low DSCR (${r.dscr.toFixed(2)}x)</strong> — Debt coverage below the 1.25x safe threshold. Reduce expenses by ${formatCurrency(monthlyExpReduction)}/mo or increase ADR by $${dscrADRIncrease} to reach 1.25x.</div>
            </div>`);
        } else {
            flags.push(`<div class="warning-banner warning-red">
                <span class="warning-icon">&#9888;</span>
                <div><strong>Low DSCR (${r.dscr.toFixed(2)}x)</strong> — Debt coverage below the 1.25x safe threshold. Target ADR increase above addresses this.</div>
            </div>`);
        }
    }

    // Break-even analysis when cash flow is negative
    if (r.annualCashFlow < 0 && r.numKeys > 0 && r.occupancyRate > 0) {
        const breakEvenRevenue = r.annualOpex + r.annualDebtService;
        const breakEvenADR = Math.ceil(breakEvenRevenue / (r.occupancyRate * 365 * r.numKeys));
        const breakEvenOcc = r.adr > 0 ? (breakEvenRevenue / (r.adr * 365 * r.numKeys)) : 0;
        const breakEvenOccPct = Math.min(100, Math.round(breakEvenOcc * 100));
        flags.push(`<div class="warning-banner warning-amber">
            <span class="warning-icon">&#9881;</span>
            <div><strong>Break-Even Analysis</strong> — Break-even revenue: ${formatCurrency(breakEvenRevenue)}/yr. At current occupancy (${Math.round(r.occupancyRate * 100)}%), break-even ADR is $${breakEvenADR}/night. At current ADR ($${Math.round(r.adr)}), break-even occupancy is ${breakEvenOccPct}%.</div>
        </div>`);
    }

    if (r.negEquityFlag) {
        flags.push(`<div class="warning-banner warning-red">
            <span class="warning-icon">&#9888;</span>
            <div><strong>Negative Refi Equity</strong> — A refinance at 65% LTV yields ${formatCurrency(r.netRefiProceeds)} — you won't recover your equity. Increase property value through higher NOI or reduce total capital invested.</div>
        </div>`);
    }

    if (r.ancillaryPct > 0.40) {
        const cfWithout = r.annualCashFlow - r.ancillaryRevenue;
        const adrToReplace = r.numKeys > 0 && r.occupancyRate > 0
            ? Math.ceil(r.ancillaryRevenue / (r.occupancyRate * 365 * r.numKeys))
            : 0;
        flags.push(`<div class="warning-banner warning-amber">
            <span class="warning-icon">&#9888;</span>
            <div><strong>High Ancillary Dependency (${(r.ancillaryPct * 100).toFixed(0)}%)</strong> — ${formatCurrency(r.ancillaryRevenue)}/yr from ancillary sources. Without it, cash flow drops to ${formatCurrency(cfWithout)}/yr. Strengthen room revenue by increasing ADR by $${adrToReplace} to offset.</div>
        </div>`);
    }

    if (r.underLeveragedFlag) {
        const refiCashOut = r.trappedEquity;
        flags.push(`<div class="warning-banner warning-amber">
            <span class="warning-icon">&#128274;</span>
            <div><strong>Capital Trapped (LTV ${(r.stabilizedLTV * 100).toFixed(0)}%)</strong> — ${formatCurrency(r.trappedEquity)} in equity is locked up at exit. Consider refinancing to pull out ~${formatCurrency(refiCashOut)} or accelerate your exit timeline to redeploy capital.</div>
        </div>`);
    }

    if (r.workingCapital && r.workingCapital.flag) {
        flags.push(`<div class="warning-banner warning-amber">
            <span class="warning-icon">&#128176;</span>
            <div><strong>Working Capital Gap</strong> — Renovation creates ${r.workingCapital.monthsOfDeficit} months of cash deficit totaling ${formatCurrency(r.workingCapital.cushionNeeded)}. Budget this amount as additional reserves before closing.</div>
        </div>`);
    }

    container.innerHTML = flags.join('');
    container.style.display = flags.length > 0 ? 'block' : 'none';
}

function setBar(prefix, score, max) {
    document.getElementById(`${prefix}Label`).textContent = `${Math.round(score)} / ${max}`;
    document.getElementById(`${prefix}Bar`).style.width = `${(score / max) * 100}%`;
}

function renderCapitalRaiseSummary(r) {
    const section = document.getElementById('section-capitalraise');
    const grid = document.getElementById('capitalRaiseGrid');
    const totalEl = document.getElementById('capitalRaiseTotal');
    if (!section || !grid) return;

    const items = [
        { label: 'Down Payment', value: r.downPayment },
        { label: 'Closing Costs', value: r.closingCosts },
        { label: 'Renovation', value: r.renovationBudget },
    ];

    if (r.contingencyAmount > 0) {
        items.push({ label: 'Contingency', value: r.contingencyAmount });
    }
    if (r.furnishingBudget > 0) {
        items.push({ label: 'Furnishing', value: r.furnishingBudget });
    }
    if (r.workingCapital && r.workingCapital.cushionNeeded > 0) {
        items.push({ label: 'Working Capital Reserve', value: r.workingCapital.cushionNeeded });
    }

    grid.innerHTML = items.map(item => `
        <div>
            <p class="text-xs text-gray-500">${item.label}</p>
            <p class="font-bold text-white text-lg">${formatCurrency(item.value)}</p>
        </div>
    `).join('');

    const total = items.reduce((sum, item) => sum + item.value, 0);
    totalEl.textContent = formatCurrency(total);

    // Show exit value for hotels
    if (r.propertyType === 'hotel' && r.stabilizedValue > 0) {
        const existingExit = document.getElementById('capitalRaiseExitNote');
        const exitHTML = `<p id="capitalRaiseExitNote" class="text-xs text-gray-500 mt-2 text-center">Projected Exit Value (NOI / Cap Rate): <span class="text-white font-semibold">${formatCurrency(r.stabilizedValue)}</span></p>`;
        if (existingExit) {
            existingExit.outerHTML = exitHTML;
        } else {
            totalEl.insertAdjacentHTML('afterend', exitHTML);
        }
    }
}

function renderBuyBoxSection(r, gatherInputs) {
    const { buyBox, listedMOIC } = r;
    if (!buyBox || !buyBox.primary) return;
    const primary = buyBox.primary;

    // Context: if all solved prices are above listing, the deal is underpriced
    const allAboveListed = primary.ideal > primary.listed && primary.max > primary.listed;
    let contextText = `Target MOIC: ${primary.targetMOIC.toFixed(1)}x | MOIC at listing: ${listedMOIC.toFixed(2)}x`;
    if (allAboveListed) {
        contextText += ` — Deal exceeds all MOIC thresholds at asking price. Strong buy as-is.`;
    } else if (listedMOIC < 1.0) {
        contextText += ` — Deal loses money at asking price.`;
    } else if (listedMOIC < primary.targetMOIC) {
        contextText += ` — Below target. Max price to hit ${primary.targetMOIC.toFixed(1)}x: ${formatCurrency(primary.max)}.`;
    }
    document.getElementById('buyboxContext').textContent = contextText;

    const refiCtx = document.getElementById('buyboxRefiContext');
    if (refiCtx) {
        refiCtx.textContent = `Current rate: ${buyBox.currentRate}% | Refi scenario: ${buyBox.refi.rate}%`;
    }

    const rungs = [
        { label: 'Stretch Price', primary: primary.stretch, refi: buyBox.refi.stretch, cls: 'rung-stretch' },
        { label: 'Max Price', primary: primary.max, refi: buyBox.refi.max, cls: 'rung-max' },
        { label: 'Ideal Price', primary: primary.ideal, refi: buyBox.refi.ideal, cls: 'rung-ideal' },
        { label: 'Listed Price', primary: primary.listed, refi: primary.listed, cls: 'rung-listed' },
    ];

    const container = document.getElementById('priceLadder');
    // Show buy box explainer
    const explainer = document.getElementById('buyboxExplainer');
    if (explainer) explainer.style.display = 'block';

    container.innerHTML = rungs.map(rung => {
        const testInputs = buildInputsAtPrice(gatherInputs(), rung.primary);
        const flows = calculateAnnualCashFlows(testInputs);
        const moic = calculateMOIC(flows, testInputs.totalEquity);
        const isListedRow = rung.cls === 'rung-listed';
        const aboveListed = !isListedRow && rung.primary > primary.listed;
        // If this solved price is above listing, show a "below asking" note
        const priceDisplay = aboveListed
            ? `${formatCurrency(rung.primary)} <span style="color:#10b981;font-size:0.7em">✓ below asking</span>`
            : formatCurrency(rung.primary);
        const refiNote = rung.refi && rung.refi !== rung.primary && Math.abs(rung.refi - rung.primary) > 1000
            ? `<span class="price-rung-refi">${formatCurrency(rung.refi)} @ refi</span>`
            : '';
        const cf = testInputs.annualCashFlow;
        const cfText = cf < 0 ? `<span style="color:#f87171">${formatCurrency(cf)}/yr</span>` : `${formatCurrency(cf)}/yr`;
        return `
            <div class="price-rung ${rung.cls}">
                <span class="price-rung-label">${rung.label}</span>
                <span class="price-rung-value">${priceDisplay}</span>
                <span class="price-rung-moic">${moic.toFixed(2)}x MOIC · ${cfText}</span>
                ${refiNote}
            </div>`;
    }).join('');
}

function renderScenariosSection(r) {
    const c = r.scenarios.conservative;
    const o = r.scenarios.optimized;
    const s = r.scenarios.stressed;

    const subtitle = document.getElementById('scenarioSubtitle');
    if (subtitle) {
        subtitle.textContent = `Current Expense Ratio: ${(r.expenseRatio * 100).toFixed(1)}% (excl. debt service)`;
    }

    // Scenario explainers
    const consvExp = document.getElementById('consv-explainer');
    if (consvExp) consvExp.textContent = c.explainer || 'Your inputs as entered';
    const optExp = document.getElementById('opt-explainer');
    if (optExp) optExp.textContent = o.explainer || '';
    const stressedExp = document.getElementById('stressed-explainer');
    if (stressedExp) stressedExp.textContent = s.explainer || '';

    document.getElementById('consv-moic').textContent = c.moic.toFixed(2) + 'x';
    document.getElementById('consv-irr').textContent = formatPercent(c.irr * 100);
    document.getElementById('consv-cf').textContent = formatCurrency(c.annualCF);
    document.getElementById('consv-value').textContent = formatCurrency(c.stabilizedValue);

    document.getElementById('opt-moic').textContent = o.moic.toFixed(2) + 'x';
    document.getElementById('opt-irr').textContent = formatPercent(o.irr * 100);
    document.getElementById('opt-cf').textContent = formatCurrency(o.annualCF);
    document.getElementById('opt-value').textContent = formatCurrency(o.stabilizedValue);

    document.getElementById('stressed-moic').textContent = s.moic.toFixed(2) + 'x';
    document.getElementById('stressed-irr').textContent = formatPercent(s.irr * 100);
    document.getElementById('stressed-cf').textContent = formatCurrency(s.annualCF);
    document.getElementById('stressed-value').textContent = formatCurrency(s.stabilizedValue);
}

function renderCashFlowTable(r) {
    const thead = document.getElementById('cashFlowTableHead');
    const tbody = document.getElementById('cashFlowTableBody');
    if (!tbody) return;

    const proForma = calculateProForma({ ...r.inputs, allTaxBenefits: r.allTaxBenefits });

    // Update header for pro-forma layout
    if (thead) {
        thead.innerHTML = `<tr class="text-gray-500 text-xs border-b border-surface-border">
            <th class="text-left py-2 pr-4">Year</th>
            <th class="text-right py-2 px-3">Cash Flow</th>
            <th class="text-right py-2 px-3">Tax Benefits</th>
            <th class="text-right py-2 px-3">Equity Growth</th>
            <th class="text-right py-2 px-3">Debt Paydown</th>
            <th class="text-right py-2 px-3 font-semibold">Total Return</th>
        </tr>`;
    }

    let cumulativeReturn = 0;
    const rows = proForma.map(row => {
        cumulativeReturn += row.totalReturn;
        const cfClass = row.cashFlow < 0 ? 'text-red-400' : 'text-white';
        const totalClass = row.totalReturn < 0 ? 'text-red-400' : 'text-white';

        return `<tr class="border-b border-surface-border">
            <td class="py-2 pr-4 text-gray-400">Year ${row.year}</td>
            <td class="py-2 px-3 text-right ${cfClass}">${formatCurrency(row.cashFlow)}</td>
            <td class="py-2 px-3 text-right text-green-400">${formatCurrency(row.taxBenefit)}</td>
            <td class="py-2 px-3 text-right text-blue-400">${formatCurrency(row.equityGrowth)}</td>
            <td class="py-2 px-3 text-right text-purple-400">${formatCurrency(row.principalPaydown)}</td>
            <td class="py-2 px-3 text-right ${totalClass} font-semibold">${formatCurrency(row.totalReturn)}</td>
        </tr>`;
    });

    // Add totals row
    const totals = proForma.reduce((acc, row) => ({
        cashFlow: acc.cashFlow + row.cashFlow,
        taxBenefit: acc.taxBenefit + row.taxBenefit,
        equityGrowth: acc.equityGrowth + row.equityGrowth,
        principalPaydown: acc.principalPaydown + row.principalPaydown,
        totalReturn: acc.totalReturn + row.totalReturn
    }), { cashFlow: 0, taxBenefit: 0, equityGrowth: 0, principalPaydown: 0, totalReturn: 0 });

    const totalCfClass = totals.cashFlow < 0 ? 'text-red-400' : 'text-white';
    rows.push(`<tr class="border-t-2 border-surface-border font-semibold">
        <td class="py-2 pr-4 text-white">Total</td>
        <td class="py-2 px-3 text-right ${totalCfClass}">${formatCurrency(totals.cashFlow)}</td>
        <td class="py-2 px-3 text-right text-green-400">${formatCurrency(totals.taxBenefit)}</td>
        <td class="py-2 px-3 text-right text-blue-400">${formatCurrency(totals.equityGrowth)}</td>
        <td class="py-2 px-3 text-right text-purple-400">${formatCurrency(totals.principalPaydown)}</td>
        <td class="py-2 px-3 text-right text-white">${formatCurrency(totals.totalReturn)}</td>
    </tr>`);

    tbody.innerHTML = rows.join('');
}

function renderAttributionSection(r) {
    const a = r.attribution;
    document.getElementById('attrPeriodLabel').textContent = `(${r.holdPeriod}-Year)`;

    const absTotal = Math.abs(a.cashFlow) + Math.abs(a.equity) + Math.abs(a.taxBenefits) + Math.abs(a.debtPaydown);
    const cfPct = absTotal > 0 ? (Math.abs(a.cashFlow) / absTotal) * 100 : 25;
    const eqPct = absTotal > 0 ? (Math.abs(a.equity) / absTotal) * 100 : 25;
    const txPct = absTotal > 0 ? (Math.abs(a.taxBenefits) / absTotal) * 100 : 25;
    const dpPct = absTotal > 0 ? (Math.abs(a.debtPaydown) / absTotal) * 100 : 25;

    // Horizontal bars use width
    document.getElementById('attrEquityBar').style.width = eqPct + '%';
    document.getElementById('attrCashFlowBar').style.width = cfPct + '%';
    document.getElementById('attrTaxBar').style.width = txPct + '%';
    document.getElementById('attrDebtBar').style.width = dpPct + '%';

    document.getElementById('attrEquityVal').textContent = formatCurrency(a.equity);
    document.getElementById('attrCashFlowVal').textContent = formatCurrency(a.cashFlow);
    document.getElementById('attrTaxVal').textContent = formatCurrency(a.taxBenefits);
    document.getElementById('attrDebtVal').textContent = formatCurrency(a.debtPaydown);

    document.getElementById('attrEquityPct').textContent = eqPct.toFixed(0) + '%';
    document.getElementById('attrCashFlowPct').textContent = cfPct.toFixed(0) + '%';
    document.getElementById('attrTaxPct').textContent = txPct.toFixed(0) + '%';
    document.getElementById('attrDebtPct').textContent = dpPct.toFixed(0) + '%';

    // Total MOIC summary
    const totalMoic = document.getElementById('attrTotalMoic');
    if (totalMoic && r.moic !== undefined) {
        totalMoic.textContent = r.moic.toFixed(2) + 'x on ' + formatCurrency(r.totalEquity) + ' invested';
    }

    // Depreciation exhaustion note
    const depNote = document.getElementById('depExhaustionNote');
    if (depNote && r.depExhaustion) {
        const d = r.depExhaustion;
        depNote.textContent = `~${(d.pctConsumed * 100).toFixed(0)}% of depreciation consumed by Year ${r.holdPeriod}` +
            (d.exhaustionYear <= r.holdPeriod ? ` (90% exhausted at Year ${d.exhaustionYear})` : '');
        depNote.style.display = 'block';
    }
}

function renderCapitalRecommendations(r) {
    const section = document.getElementById('section-recommendations');
    const list = document.getElementById('recommendationsList');
    if (!section || !list) return;

    const coc = r.totalEquity > 0 ? (r.annualCashFlow / r.totalEquity) * 100 : 0;
    const downPct = Math.round(r.inputs.downPct * 100);
    const recommendations = [];

    section.style.display = 'block';
    section.classList.remove('is-empty');

    // Dynamic input-specific callouts: identify what's hurting/helping
    const hurting = [];
    const helping = [];

    if (downPct >= 30) hurting.push(`Your ${downPct}% down payment ties up ${formatCurrency(r.inputs.downPayment)} — that's more cash upfront, which slows your return on equity.`);
    if (r.inputs.interestRate >= 9) hurting.push(`Your ${r.inputs.interestRate}% interest rate adds ${formatCurrency(r.annualDebtService)}/yr in debt costs. That's eating into cash flow.`);
    if (r.expenseRatio > 0.65) hurting.push(`Your expense ratio is ${Math.round(r.expenseRatio * 100)}% — every dollar over 60% reduces your cash flow.`);
    if (r.annualCashFlow < 0) hurting.push(`You're losing ${formatCurrency(Math.abs(r.annualCashFlow / 12))}/mo in cash flow. The deal needs to produce more revenue or carry less debt.`);

    if (r.moic >= 2.0) helping.push(`Your equity multiple is ${r.moic.toFixed(2)}x — you're making money on this deal over the hold period.`);
    if (coc >= 8) helping.push(`${coc.toFixed(1)}% cash-on-cash means strong ongoing cash yield.`);
    if (r.inputs.arv > r.listedPrice * 1.2) helping.push(`The spread between price and after-repair value creates built-in equity.`);

    if (hurting.length > 0) {
        recommendations.push({
            icon: '&#9888;',
            title: "What's Hurting This Deal",
            detail: hurting.join(' ')
        });
    }
    if (helping.length > 0) {
        recommendations.push({
            icon: '&#9989;',
            title: "What's Working",
            detail: helping.join(' ')
        });
    }

    // Actionable recommendations in plain language
    if (downPct >= 30 && r.annualCashFlow >= 0) {
        const lowerDP = Math.max(15, downPct - 10);
        const freed = formatCurrency(r.inputs.downPayment - r.listedPrice * lowerDP / 100);
        recommendations.push({
            icon: '&#128178;',
            title: 'Put Less Cash Down',
            detail: `You could drop from ${downPct}% to ${lowerDP}% down and free up ${freed}. As long as the deal still cash flows, using less of your own money means a higher return on what you put in. Consider 10-20% down if the numbers work.`
        });
    } else if (r.annualCashFlow < 0) {
        const targetDP = Math.min(50, downPct + 10);
        recommendations.push({
            icon: '&#128178;',
            title: 'Increase Down Payment or Renegotiate Rate',
            detail: `You're cash flow negative. Putting ${targetDP}% down instead of ${downPct}% reduces your monthly mortgage. Or try to get the rate below ${(r.inputs.interestRate - 1.5).toFixed(1)}%. Both paths get you closer to breaking even each month.`
        });
    }

    if (r.inputs.interestRate >= 9 && r.propertyType === 'hotel' && !r.refiPlanned) {
        const savings = formatCurrency((r.inputs.interestRate - 6.5) / 100 * r.inputs.loanAmount / 12);
        recommendations.push({
            icon: '&#128200;',
            title: 'Plan to Refinance',
            detail: `You're at ${r.inputs.interestRate}% right now. After 12-18 months of stable income, you could refi to ~6.5% and save roughly ${savings}/mo. That also lets you pull out some of your initial cash.`
        });
    }

    if (r.expenseRatio > 0.65) {
        const targetMonthly = Math.round(r.totalRevenue * 0.60 / 12);
        const currentMonthly = Math.round(r.annualOpex / 12);
        const gap = formatCurrency(currentMonthly - targetMonthly);
        recommendations.push({
            icon: '&#9986;',
            title: 'Cut Monthly Expenses',
            detail: `You're spending ${formatCurrency(currentMonthly)}/mo on operations. Getting that down to ${formatCurrency(targetMonthly)}/mo (a 60% expense ratio) saves ${gap}/mo. Look at management fees, insurance, and whether you can automate anything.`
        });
    }

    if (r.renovationBudget > r.listedPrice * 0.30) {
        recommendations.push({
            icon: '&#128295;',
            title: 'Phase Your Renovation',
            detail: `You're spending ${formatCurrency(r.renovationBudget)} on renovation — that's ${Math.round(r.renovationBudget / r.listedPrice * 100)}% of the purchase price. Start with the stuff that drives revenue (cosmetic updates, amenities) and save the bigger projects for later. This gets you earning sooner.`
        });
    }

    if (coc < 0 && r.moic > 1.5) {
        const reserves = formatCurrency(Math.abs(r.annualCashFlow / 12) * r.holdPeriod);
        recommendations.push({
            icon: '&#128161;',
            title: "You'll Need Reserves",
            detail: `This deal loses money monthly but makes it back when you sell (${r.moic.toFixed(2)}x total return). Budget about ${reserves} in reserves to cover the monthly shortfall until exit. A refi could also flip this to positive cash flow.`
        });
    }

    if (r.moic >= 2.0 && coc >= 5) {
        recommendations.push({
            icon: '&#127775;',
            title: 'This Is a Strong Deal',
            detail: `${r.moic.toFixed(2)}x return on your money and ${coc.toFixed(1)}% annual cash yield. Consider negotiating the price down to make it even better, or plan a 1031 exchange at exit to keep compounding tax-free.`
        });
    }

    if (recommendations.length === 0) {
        section.style.display = 'none';
        return;
    }

    list.innerHTML = recommendations.map(rec => `
        <div class="flex items-start gap-3 p-3 rounded-lg bg-surface-light border border-surface-border">
            <span class="text-lg flex-shrink-0">${rec.icon}</span>
            <div>
                <p class="font-semibold text-white text-sm">${rec.title}</p>
                <p class="text-xs text-gray-400 mt-0.5">${rec.detail}</p>
            </div>
        </div>
    `).join('');
}

function renderSensitivityTable(r, gatherInputs) {
    const head = document.getElementById('sensitivityHead');
    const body = document.getElementById('sensitivityBody');
    if (!head || !body) return;

    const baseInputs = gatherInputs();
    const baseADR = r.adr;
    const baseOcc = r.occupancyRate;

    // ADR levels: -20%, -10%, current, +10%, +20%
    const adrMultipliers = [0.80, 0.90, 1.00, 1.10, 1.20];
    const adrLevels = adrMultipliers.map(m => Math.round(baseADR * m));

    // Occupancy levels: -15pp, -5pp, current, +10pp
    const occDeltas = [-0.15, -0.05, 0, 0.10];
    const occLevels = occDeltas.map(d => Math.min(0.95, Math.max(0.20, baseOcc + d)));

    // Header row
    head.innerHTML = `<tr>
        <th class="text-left">ADR \\ Occ</th>
        ${occLevels.map(occ => `<th>${Math.round(occ * 100)}%</th>`).join('')}
    </tr>`;

    // Body rows
    body.innerHTML = adrLevels.map((adr, ai) => {
        const cells = occLevels.map((occ, oi) => {
            const testInputs = { ...baseInputs };
            testInputs.adr = adr;
            testInputs.occupancyRate = occ;
            testInputs.annualRevenue = adr * occ * 365 * testInputs.numKeys;
            testInputs.totalRevenue = testInputs.annualRevenue + (testInputs.ancillaryRevenue || 0);
            testInputs.noi = testInputs.totalRevenue - testInputs.annualOpex;
            testInputs.annualCashFlow = testInputs.noi - testInputs.annualDebtService;

            const flows = calculateAnnualCashFlows(testInputs);
            const moic = calculateMOIC(flows, testInputs.totalEquity);

            let cls = moic >= 2.5 ? 'sens-good' : moic >= 1.5 ? 'sens-ok' : 'sens-bad';
            const isCurrent = adrMultipliers[ai] === 1.00 && occDeltas[oi] === 0;
            if (isCurrent) cls += ' sens-current';

            return `<td class="${cls}">${moic.toFixed(2)}x</td>`;
        }).join('');

        const isCurrentADR = adrMultipliers[ai] === 1.00;
        const rowLabel = isCurrentADR ? `<strong>$${adr}</strong>` : `$${adr}`;
        return `<tr><td class="text-left text-gray-400">${rowLabel}</td>${cells}</tr>`;
    }).join('');

    setupSensitivitySliders(r, gatherInputs);
}

function setupSensitivitySliders(r, gatherInputs) {
    const simADR = document.getElementById('simADR');
    const simOcc = document.getElementById('simOcc');
    if (!simADR || !simOcc) return;

    const baseADR = r.adr;
    const baseOcc = r.occupancyRate;

    function updateSim() {
        const adrDelta = parseInt(simADR.value);
        const occDelta = parseInt(simOcc.value);

        document.getElementById('simADRValue').textContent = (adrDelta >= 0 ? '+' : '') + adrDelta + '%';
        document.getElementById('simOccValue').textContent = (occDelta >= 0 ? '+' : '') + occDelta + 'pp';

        const newADR = Math.round(baseADR * (1 + adrDelta / 100));
        const newOcc = Math.min(0.95, Math.max(0.20, baseOcc + occDelta / 100));

        document.getElementById('simADRHint').textContent = `$${baseADR} → $${newADR}/night`;
        document.getElementById('simOccHint').textContent = `${Math.round(baseOcc * 100)}% → ${Math.round(newOcc * 100)}%`;

        const testInputs = { ...gatherInputs() };
        testInputs.adr = newADR;
        testInputs.occupancyRate = newOcc;
        testInputs.annualRevenue = newADR * newOcc * 365 * testInputs.numKeys;
        testInputs.totalRevenue = testInputs.annualRevenue + (testInputs.ancillaryRevenue || 0);
        testInputs.noi = testInputs.totalRevenue - testInputs.annualOpex;
        testInputs.annualCashFlow = testInputs.noi - testInputs.annualDebtService;

        const flows = calculateAnnualCashFlows(testInputs);
        const moic = calculateMOIC(flows, testInputs.totalEquity);

        const moicEl = document.getElementById('simMOIC');
        moicEl.textContent = moic.toFixed(2) + 'x MOIC';
        moicEl.className = 'font-bold text-2xl ' + (moic >= 2.5 ? 'text-green-400' : moic >= 1.5 ? 'text-amber-400' : 'text-red-400');

        const cfEl = document.getElementById('simCashFlow');
        cfEl.textContent = `Cash Flow: ${formatCurrency(testInputs.annualCashFlow)}/yr`;
        cfEl.className = 'text-xs mt-1 ' + (testInputs.annualCashFlow < 0 ? 'text-red-400' : 'text-gray-500');
    }

    simADR.addEventListener('input', updateSim);
    simOcc.addEventListener('input', updateSim);

    // Reset sliders on new analysis
    simADR.value = 0;
    simOcc.value = 0;
    updateSim();
}

function renderLeversSection(r) {
    const container = document.getElementById('leverCards');
    if (!container) return;
    const levers = r.levers || [];
    if (levers.length === 0) {
        container.innerHTML = '<p style="color:#6b7280;font-size:13px;text-align:center;padding:12px">Run the analysis to see improvement suggestions.</p>';
        return;
    }
    container.innerHTML = levers.map((lever, i) => `
        <div class="lever-card">
            <div class="lever-card-name">#${i + 1} ${lever.name}</div>
            <div class="lever-card-insight">${lever.insight}</div>
            <span class="lever-card-impact">+${lever.deltaMOIC.toFixed(2)}x MOIC | +${(lever.deltaIRR * 100).toFixed(1)}% IRR</span>
            <div class="lever-card-direction">${lever.direction}</div>
        </div>
    `).join('');
}

function _populateMethodology(r) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const coc = r.stabilityResult?.coc ?? (r.totalEquity > 0 ? (r.annualCashFlow / r.totalEquity) * 100 : 0);

    set('meth_equity_score', Math.round(r.equityScore) + '/40');
    const arvAtExit = r.stabilizedValue || 0;
    const eq = r.equityMultiple ?? 0;
    const el = document.getElementById('meth_equity_detail');
    if (el) el.textContent = `Equity multiple: ${eq.toFixed(2)}x — ARV at exit ~${formatCurrency(arvAtExit)} minus loan balance ÷ ${formatCurrency(r.totalEquity)} invested.`;

    set('meth_speed_score', Math.round(r.speedScore) + '/25');

    set('meth_tax_score', Math.round(r.taxScore) + '/15');
    // Build per-year tax breakdown
    const taxBreakdown = document.getElementById('meth_tax_breakdown');
    if (taxBreakdown && r.allTaxBenefits) {
        const rows = r.allTaxBenefits.map((yr, i) => {
            const carryNote = yr.carryforward > 0 ? ` · ${formatCurrency(yr.carryforward)} →yr${i+2}` : '';
            return `Yr${i+1}: ${formatCurrency(yr.depTaken)} dep taken → ${formatCurrency(yr.taxSavings)} saved${carryNote}`;
        });
        taxBreakdown.innerHTML = rows.join('<br>');
    }

    set('meth_cf_score', Math.round(r.stabilityScore) + '/20');
    const cfEl = document.getElementById('meth_cf_detail');
    if (cfEl) cfEl.textContent = `CoC: ${coc.toFixed(1)}% — ${formatCurrency(r.annualCashFlow)} annual cash flow ÷ ${formatCurrency(r.totalEquity)} equity. DSCR: ${r.dscr?.toFixed(2)}x.`;

    // Penalties
    const friction = r.friction ?? 0;
    const metricPenalty = r.metricPenalty ?? 0;
    set('meth_penalty_score', '-' + Math.round(friction + metricPenalty));
    const penaltyEl = document.getElementById('meth_penalty_detail');
    if (penaltyEl) {
        const parts = [];
        if (r.inputs?.interestRate >= 10) parts.push('High rate (−1.5)');
        if (r.inputs?.renovationBudget > r.inputs?.listedPrice * 0.2) parts.push('High reno (−1.5)');
        if (r.annualCashFlow < 0) parts.push('Neg. cash flow (−2)');
        if (coc < 15) parts.push(`CoC ${coc.toFixed(1)}% < 15% (−${((15 - coc) * 0.5).toFixed(1)})`);
        const irrPct = (r.irr || 0) * 100;
        if (irrPct < 18) parts.push(`IRR ${irrPct.toFixed(1)}% < 18% (−${((18 - irrPct) * 0.5).toFixed(1)})`);
        penaltyEl.textContent = parts.length ? parts.join(' · ') : 'No penalties applied.';
    }
}
