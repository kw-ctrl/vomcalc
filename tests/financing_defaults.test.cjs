/**
 * VOMCalc financing-default regression test.
 * Proves: a fresh deal opens on Conventional (P&I), the loan-type select sets rate/IO/term,
 * the down payment drives the loan, and the setup is remembered across reloads.
 *
 * Run:  cd public && python3 -m http.server 8899 &      # serve the app
 *       NODE_PATH=<a node_modules containing playwright> node tests/financing_defaults.test.cjs
 * (playwright + chromium are already on this Mac; the package is not a dependency of this repo.)
 * Exits non-zero on any failed assertion. Override the target with VOM_URL.
 */
const { chromium } = require('playwright');

const URL = process.env.VOM_URL || 'http://127.0.0.1:8899/app.html';
const out = [];
const log = (s) => { out.push(s); console.log(s); };

async function readTranche(page) {
  await page.waitForSelector('#debtTranchesContainer select', { timeout: 15000 });
  return page.evaluate(() => {
    const sel = document.querySelector('#debtTranchesContainer select');
    const card = sel.closest('div[style*="border-radius:8px"]');
    const io = card.querySelector('input[type=checkbox]');
    const rows = [...card.querySelectorAll('span')].map(s => s.textContent.trim());
    return {
      label: sel.value,
      ioChecked: io ? io.checked : null,
      paymentType: card.textContent.includes('(IO)') ? 'IO' : card.textContent.includes('(P&I)') ? 'P&I' : '?',
      rateLine: (rows.find(t => t.includes('%')) || ''),
      termLabel: card.textContent.includes('Balloon / Payoff Term') ? 'balloon' : card.textContent.includes('Amortization Term') ? 'amortization' : '?',
      summaryRate: document.getElementById('dsSummaryRate')?.textContent,
      summaryDS: document.getElementById('dsSummaryDS')?.textContent,
      summaryLTV: document.getElementById('dsSummaryLTV')?.textContent,
      json: JSON.parse(document.getElementById('debtTranchesJSON')?.value || '[]'),
      downPayment: document.getElementById('downPayment')?.value,
      trancheRate: (JSON.parse(document.getElementById('debtTranchesJSON')?.value || '[]')[0] || {}).rate,
      trancheLtv: (JSON.parse(document.getElementById('debtTranchesJSON')?.value || '[]')[0] || {}).ltv,
    };
  });
}

(async () => {
  const browser = await chromium.launch();
  const results = {};

  // ── 1. Fresh browser: what does a new deal open on? ──────────────────────
  const fresh = await browser.newContext();
  const p1 = await fresh.newPage();
  await p1.goto(URL, { waitUntil: 'domcontentloaded' });
  await p1.evaluate(() => localStorage.clear());
  await p1.reload({ waitUntil: 'domcontentloaded' });
  await p1.waitForTimeout(1200);
  results.fresh = await readTranche(p1);
  log('FRESH DEFAULT: ' + JSON.stringify({ label: results.fresh.label, payment: results.fresh.paymentType, rate: results.fresh.summaryRate, term: results.fresh.termLabel }));

  // With a price, the debt service should be a conventional P&I payment, not 12% IO.
  await p1.fill('#listedPrice', '429000');
  await p1.dispatchEvent('#listedPrice', 'input');
  await p1.waitForTimeout(800);
  results.priced = await readTranche(p1);
  log('DEFAULT @ $429k: LTV=' + results.priced.summaryLTV + ' rate=' + results.priced.summaryRate + ' DS=' + results.priced.summaryDS);

  // ── 2. Loan-type select sets rate + IO + term together ───────────────────
  await p1.selectOption('#debtTranchesContainer select', 'Bridge Loan');
  await p1.waitForTimeout(600);
  results.bridge = await readTranche(p1);
  log('PICKED Bridge Loan: rate=' + results.bridge.summaryRate + ' payment=' + results.bridge.paymentType + ' DS=' + results.bridge.summaryDS + ' term=' + results.bridge.termLabel);

  await p1.selectOption('#debtTranchesContainer select', 'DSCR Loan');
  await p1.waitForTimeout(600);
  results.dscr = await readTranche(p1);
  log('PICKED DSCR Loan: rate=' + results.dscr.summaryRate + ' payment=' + results.dscr.paymentType + ' term=' + results.dscr.termLabel);

  // ── 3. Remembered across a reload ────────────────────────────────────────
  await p1.selectOption('#debtTranchesContainer select', 'Conventional');
  await p1.waitForTimeout(400);
  await p1.evaluate(() => window.updateTrancheField(0, 'rate', 8.25));
  await p1.waitForTimeout(400);
  const before = await readTranche(p1);
  await p1.reload({ waitUntil: 'domcontentloaded' });
  await p1.waitForTimeout(1200);
  results.reloaded = await readTranche(p1);
  log('SET Conventional @8.25% -> reload: label=' + results.reloaded.label + ' rate=' + results.reloaded.trancheRate + ' ltv=' + results.reloaded.trancheLtv + ' payment=' + results.reloaded.paymentType);

  const remembered = results.reloaded.label === 'Conventional'
    && Number(results.reloaded.trancheRate) === 8.25
    && results.reloaded.paymentType === 'P&I';

  // ── 4. A different browser (a member's first visit) still gets Conventional
  const member = await browser.newContext();
  const p2 = await member.newPage();
  await p2.goto(URL, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1200);
  results.memberFirstVisit = await readTranche(p2);
  log('MEMBER FIRST VISIT: label=' + results.memberFirstVisit.label + ' rate=' + results.memberFirstVisit.summaryRate + ' payment=' + results.memberFirstVisit.paymentType);

  // ── 5. A SAVED deal reopens on the financing it was saved with ───────────
  const dealCtx = await browser.newContext();
  const p3 = await dealCtx.newPage();
  await p3.goto(URL, { waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(1000);
  await p3.evaluate(() => {
    localStorage.setItem('vom_local_deals_v1', JSON.stringify([{
      id: 'local_regression',
      title: 'Saved Conventional Deal',
      input_snapshot: {
        propertyType: 'str', listedPrice: 429000, downPayment: 25,
        debtTranches: [{ label: 'Conventional', ltv: 75, rate: 8.0, interestOnly: false, termYears: 30, amount: 321750 }],
      },
      result_snapshot: {},
    }]));
  });
  await p3.reload({ waitUntil: 'domcontentloaded' });
  await p3.waitForTimeout(1200);
  await p3.evaluate(() => window.loadDeal('local_regression'));
  await p3.waitForTimeout(1500);
  results.savedDeal = await readTranche(p3);
  log('LOADED SAVED DEAL (Conventional 75% @8%): label=' + results.savedDeal.label + ' rate=' + results.savedDeal.trancheRate + ' ltv=' + results.savedDeal.trancheLtv + ' payment=' + results.savedDeal.paymentType);

  // ── 6. Down payment drives the loan amount (it did not) ──────────────────
  const dpCtx = await browser.newContext();
  const p4 = await dpCtx.newPage();
  await p4.goto(URL, { waitUntil: 'domcontentloaded' });
  await p4.evaluate(() => localStorage.clear());
  await p4.reload({ waitUntil: 'domcontentloaded' });
  await p4.waitForTimeout(1000);
  await p4.fill('#listedPrice', '429000');
  await p4.dispatchEvent('#listedPrice', 'input');
  await p4.waitForTimeout(700);
  results.dpBefore = await readTranche(p4);
  await p4.evaluate(() => {
    const s = document.querySelector('[data-input="downPayment"]');
    s.value = 25; s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p4.waitForTimeout(800);
  results.dpAfter = await readTranche(p4);
  log('DOWN PAYMENT 20%->25%: LTV ' + results.dpBefore.trancheLtv + ' -> ' + results.dpAfter.trancheLtv + ', DS ' + results.dpBefore.summaryDS + ' -> ' + results.dpAfter.summaryDS);
  await p4.reload({ waitUntil: 'domcontentloaded' });
  await p4.waitForTimeout(1200);
  results.dpReload = await readTranche(p4);
  log('AFTER RELOAD: down payment=' + results.dpReload.downPayment + ' LTV=' + results.dpReload.trancheLtv);

  // ── Assertions ───────────────────────────────────────────────────────────
  const assert = [];
  const ok = (name, cond, detail) => { assert.push({ name, pass: !!cond, detail }); };
  ok('fresh deal opens Conventional', results.fresh.label === 'Conventional', results.fresh.label);
  ok('fresh deal is P&I, not interest-only', results.fresh.paymentType === 'P&I' && results.fresh.ioChecked === false, results.fresh.paymentType);
  ok('fresh deal amortises (30-yr), not a balloon', results.fresh.termLabel === 'amortization', results.fresh.termLabel);
  ok('fresh deal is not 12%', !String(results.fresh.summaryRate).startsWith('12'), results.fresh.summaryRate);
  ok('picking Bridge makes it IO', results.bridge.paymentType === 'IO' && results.bridge.ioChecked === true, results.bridge.paymentType);
  ok('picking Bridge raises the rate', parseFloat(results.bridge.summaryRate) > 10, results.bridge.summaryRate);
  ok('picking DSCR sets its own rate', String(results.dscr.summaryRate).startsWith('7.75'), results.dscr.summaryRate);
  ok('loan-type select drives the payment type', results.bridge.paymentType !== results.dscr.paymentType, `${results.bridge.paymentType} vs ${results.dscr.paymentType}`);
  ok('rate is remembered across reload', remembered, `${results.reloaded.label} @ ${results.reloaded.summaryRate}`);
  ok('a member first visit gets Conventional', results.memberFirstVisit.label === 'Conventional' && results.memberFirstVisit.paymentType === 'P&I', `${results.memberFirstVisit.label}/${results.memberFirstVisit.paymentType}`);
  ok('saved deal keeps its own financing (not the default)', results.savedDeal.label === 'Conventional' && Number(results.savedDeal.trancheRate) === 8 && Number(results.savedDeal.trancheLtv) === 75, `${results.savedDeal.label} @${results.savedDeal.trancheRate}% ${results.savedDeal.trancheLtv}%LTV`);
  ok('conventional DS is far below a 12% IO bridge', parseFloat(String(results.priced.summaryDS).replace(/[^0-9.]/g, '')) < 2600, results.priced.summaryDS);
  ok('down payment moves the loan LTV', Number(results.dpAfter.trancheLtv) === 75, `${results.dpBefore.trancheLtv}% -> ${results.dpAfter.trancheLtv}%`);
  ok('down payment moves the debt service', results.dpAfter.summaryDS !== results.dpBefore.summaryDS, `${results.dpBefore.summaryDS} -> ${results.dpAfter.summaryDS}`);
  ok('down payment is remembered across reload', Number(results.dpReload.downPayment) === 25 && Number(results.dpReload.trancheLtv) === 75, `dp=${results.dpReload.downPayment} ltv=${results.dpReload.trancheLtv}`);

  log('\n--- assertions ---');
  assert.forEach(a => log((a.pass ? 'PASS' : 'FAIL') + '  ' + a.name + '  [' + a.detail + ']'));
  const failed = assert.filter(a => !a.pass);
  log(failed.length === 0 ? 'ALL PASS (' + assert.length + ')' : failed.length + ' FAILED');

  require('fs').writeFileSync(process.env.OUT || '/tmp/vomcalc_financing_result.json', JSON.stringify({ results, assert }, null, 2));
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR', e); process.exit(2); });
