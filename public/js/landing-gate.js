/**
 * Landing-page copy that stays true in BOTH pricing states.
 *
 * Every element marked with data-copy-free / data-copy-gated carries both versions of the
 * sentence. While the paid gate is off the page reads exactly as it always has; when the gate
 * is switched on it swaps to the code/trial/priced wording automatically — so the copy can
 * never contradict what the product actually does, and flipping the gate needs no page edit.
 *
 * If the request fails we leave the copy as authored on the page (the free wording), which is
 * the safe direction: never promise less than the visitor actually gets.
 */
const ENDPOINT = '/api/auth/state';

function applyGateCopy(gated) {
  const nodes = document.querySelectorAll('[data-copy-free][data-copy-gated]');
  for (const el of nodes) {
    const next = gated ? el.dataset.copyGated : el.dataset.copyFree;
    if (next && el.textContent.trim() !== next.trim()) el.textContent = next;
  }
}

async function init() {
  try {
    const res = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    applyGateCopy(Boolean(data?.gateEnabled));
  } catch {
    /* offline or blocked — the authored (free) copy stays, which is the safe default */
  }
}

init();
