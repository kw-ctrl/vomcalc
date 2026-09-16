/**
 * POST /api/lookup — {"query": "<zillow/redfin URL or address>", "bedrooms"?: n}
 *
 * The front door of the funnel: someone pastes a listing link or an address and gets real
 * revenue numbers back, sourced from actual operating data — not a guess from the list price.
 *
 * Cost control, in order of defence:
 *   1. The address comes out of the URL PATH where possible, so no scraping is needed.
 *   2. Every result is cached per normalized address — the same address never bills twice.
 *   3. Per-IP limits (hourly + daily) stop a loop from hammering the providers.
 *   4. BnBCalc ($0.20/report) is NEVER called for an anonymous request. It requires a
 *      signed-in account, is separately capped per day, and is off unless
 *      STR_ALLOW_PAID_LOOKUPS=true is explicitly set.
 */
import { sb, bearer, getUser } from './_shared/access.js';
import {
  normalizeQuery, addressKey, parseListingUrl, fetchPageAddress,
  airroiEstimate, summarizeAirROI, bnbcalcBuy, summarizeBnBCalc,
  readCache, writeCache, airroiReady, bnbcalcReady, paidLookupsAllowed,
  fetchListingPrice, priceIsPlausible,
} from './_shared/str-data.js';

const PER_IP_PER_HOUR = 25;    // NEW addresses only — cache hits are never limited
const PER_IP_PER_DAY = 150;   // a real person comparing 15 listings is never blocked
const PER_ACCOUNT_PAID_PER_DAY = 5;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || '').split(',')[0]).trim()
    || req.headers['x-real-ip'] || 'unknown';
}

async function underLimit(bucket, limit) {
  const r = await sb('/rest/v1/rpc/bump_lookup_usage', { method: 'POST', body: { p_bucket: bucket } });
  const count = typeof r.data === 'number' ? r.data : Number(r.data) || 0;
  return { allowed: count <= limit, count };
}

/**
 * Turn AirROI's comparable operate listings into something worth showing.
 * These are REAL Airbnb listings with their trailing-twelve-month performance, not
 * estimates — which is what makes the comps block useful rather than decorative.
 * Field paths verified against a live response (Sep 2026).
 */
function buildComps(list, limit = 8) {
  if (!Array.isArray(list) || !list.length) return { sample: [], stats: null };
  const rows = list.map((c) => {
    const pm = c?.performance_metrics || {};
    const li = c?.listing_info || {};
    const pd = c?.property_details || {};
    const rt = c?.ratings || {};
    const round = (v) => (v == null ? null : Math.round(Number(v)));
    return {
      name: li.listing_name || null,
      type: li.listing_type || null,
      bedrooms: pd.bedrooms ?? null,
      baths: pd.baths ?? null,
      guests: pd.guests ?? null,
      adr: round(pm.ttm_avg_rate),
      revenue: round(pm.ttm_revenue),
      occupancy: pm.ttm_occupancy != null ? Math.round(pm.ttm_occupancy * 1000) / 10 : null,
      rating: rt.rating_overall ?? null,
      reviews: rt.num_reviews ?? null,
      superhost: Boolean(c?.host_info?.superhost),
      city: c?.location_info?.locality || null,
      url: li.listing_id ? `https://www.airbnb.com/rooms/${li.listing_id}` : null,
    };
  }).filter((c) => c.revenue != null);

  if (!rows.length) return { sample: [], stats: null };

  const withRev = rows.filter((r) => r.revenue > 0);
  const revs = withRev.map((r) => r.revenue).sort((a, b) => a - b);
  const adrs = rows.map((r) => r.adr).filter((v) => v > 0).sort((a, b) => a - b);
  const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null);

  return {
    sample: rows.sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, limit),
    stats: {
      count: rows.length,
      medianRevenue: median(revs),
      topRevenue: revs.length ? revs[revs.length - 1] : null,
      averageAdr: avg(adrs),
      medianAdr: median(adrs),
      averageRating: rows.filter((r) => r.rating).length
        ? Math.round((rows.reduce((s, r) => s + (r.rating || 0), 0) / rows.filter((r) => r.rating).length) * 100) / 100
        : null,
      superhostShare: rows.length ? Math.round((rows.filter((r) => r.superhost).length / rows.length) * 100) : null,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
  const { query, bedrooms } = body;

  const parsed = normalizeQuery(query);
  if (!parsed) {
    return res.status(400).json({ error: "That doesn't look like a listing link or an address. Try a Zillow or Redfin URL, or something like '12000 NE 80th St, Kirkland, WA 98033'." });
  }

  if (!airroiReady()) {
    return res.status(503).json({ error: 'Revenue data is not configured yet.' });
  }

  // ── resolve the address ────────────────────────────────────────────────────
  let target = parsed;
  if (!target.address && target.rawUrl) {
    const fromPage = await fetchPageAddress(target.rawUrl);
    if (fromPage) target = { ...fromPage, rawUrl: target.rawUrl };
  }
  if (!target.address) {
    return res.status(422).json({
      error: "I couldn't read an address from that link. Paste the property address instead and it'll work.",
      needsAddress: true,
    });
  }

  // ── cache ──────────────────────────────────────────────────────────────────
  // Checked BEFORE any rate limiting on purpose: serving a cached address costs nothing, so
  // it should never consume a visitor's quota. This also means the landing page's warming
  // lookup makes the app's follow-up call free, and an office or mobile network full of
  // people (all sharing one IP) never blocks itself on repeats.
  const key = addressKey(target.address);
  const cached = await readCache(key);
  if (cached) {
    return res.status(200).json({ ...cached, cached: true, address: cached.address || target.address });
  }

  // ── rate limit — only now, because only now can this cost anything ─────────
  const ip = clientIp(req);
  const day = new Date().toISOString().slice(0, 10);
  const hourBucket = `lookup:h:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const dayBucket = `lookup:d:${ip}:${day}`;
  const hourly = await underLimit(hourBucket, PER_IP_PER_HOUR);
  if (!hourly.allowed) return res.status(429).json({ error: 'Too many new addresses at once — give it a minute, or look up an address we have already priced.' });
  const daily = await underLimit(dayBucket, PER_IP_PER_DAY);
  if (!daily.allowed) return res.status(429).json({ error: 'Daily limit reached for this connection.' });

  // ── paid tier (signed-in only, capped, and off unless explicitly enabled) ──
  let userId = null;
  try {
    const user = await getUser(bearer(req));
    userId = user?.id || null;
  } catch { userId = null; }
  let paid = null;
  if (userId && bnbcalcReady() && paidLookupsAllowed()) {
    const paidBucket = `paid:u:${userId}:${day}`;
    const allowed = await underLimit(paidBucket, PER_ACCOUNT_PAID_PER_DAY);
    if (allowed.allowed) {
      const raw = await bnbcalcBuy({ address: target.address, bedrooms });
      paid = summarizeBnBCalc(raw);
    }
  }

  // ── asking price (only for link types whose pages block plain fetching) ────
  // Zillow/Crexi/LoopNet can't be fetched directly, and without a price there is nothing to
  // underwrite — so those links get rendered through Firecrawl. StreetAddress/Redfin links
  // skip this: their own import already returns the price for free.
  let listing = null;
  const sourceUrl = parsed.rawUrl || (parsed.source.endsWith('-url') ? query : null);
  if (sourceUrl) {
    const fetched = await fetchListingPrice(sourceUrl, target.address);
    if (fetched && !fetched.mismatch) listing = fetched;
    else if (fetched && fetched.mismatch) {
      listing = { unavailable: true, reason: 'the page served a different property', addressOnPage: fetched.addressOnPage };
    }
  }

  // ── free tier: real operating comps + revenue forecast ────────────────────
  const airroiRaw = await airroiEstimate({ address: target.address, bedrooms });
  const primary = summarizeAirROI(airroiRaw) || paid;

  // A scraped price must survive contact with the revenue we independently estimated —
  // otherwise it is a mis-read and must not silently drive the score.
  if (listing && listing.price && primary?.annualRevenue && !priceIsPlausible(listing.price, primary.annualRevenue)) {
    listing = {
      unavailable: true,
      reason: 'the price read from the page did not line up with the market revenue',
      scrapedPrice: listing.price,
    };
  }

  if (!primary) {
    return res.status(404).json({
      error: "No revenue data came back for that address — it may be outside the markets we cover. Double-check the address, or try a nearby one.",
      address: target.address,
    });
  }

  const payload = {
    address: target.address,
    addressKey: key,
    resolvedFrom: parsed.source,
    addressConfidence: parsed.confident ? 'high' : 'medium',
    estimate: paid || primary,
    ...(paid ? { crossCheck: primary } : {}),
    comps: buildComps(airroiRaw?.comparable_listings),
    ...(listing ? { listing } : {}),
    generatedAt: new Date().toISOString(),
  };

  await writeCache(key, query, payload);

  return res.status(200).json({ ...payload, cached: false });
}
