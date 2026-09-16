/**
 * STR market data — comps and revenue estimates for an address.
 *
 * Two sources, both already in use in DealOS (keys reused from there):
 *   AirROI  — revenue forecast + real operating comps. Cheap, fast, no per-call fee.
 *   BnBCalc — buy analysis with quartile bands and comparables. **$0.20 per report**
 *             (see COST note below), so it is never called on a cold public request.
 *
 * Key lesson baked in here: a listing URL contains the address in its PATH. Parsing that
 * means a Zillow or Redfin link resolves even when the page itself is bot-blocked — no
 * scraping required, and no dependency on Zillow's PerimeterX mood.
 */
import { sb } from './access.js';

const AIRROI_BASE = 'https://api.airroi.com';
const BNBCALC_BASE = 'https://atlas.bnbcalc.com';

/** BnBCalc bills $0.20 per successfully created report — see STR_ALLOW_PAID_LOOKUPS. */
export function paidLookupsAllowed() {
  return String(process.env.STR_ALLOW_PAID_LOOKUPS || '').toLowerCase() === 'true';
}
export function airroiReady() { return Boolean(process.env.AIRROI_API_KEY); }
export function bnbcalcReady() { return Boolean(process.env.BNBCALC_API_KEY); }

// ─────────────────────────────────────────────────────────────────────────────
// URL → address
// ─────────────────────────────────────────────────────────────────────────────

const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO ' +
  'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC').split(' '));

const STREET_SUFFIXES = ('st street ave avenue blvd boulevard rd road dr drive ln lane way ct court pl place ' +
  'ter terrace cir circle hwy highway pkwy parkway trl trail loop pass alley wy wynd sq square pt point ' +
  'n nw ne s sw se e w').split(' ');

/** Turn "12000-NE-80th-St-98033" into { street, zip }. */
function splitStreetAndZip(segment) {
  const zipMatch = segment.match(/(\d{5})(?:-\d{4})?$/);
  const zip = zipMatch ? zipMatch[1] : null;
  let street = zipMatch ? segment.slice(0, zipMatch.index) : segment;
  street = street.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return { street, zip };
}

function titleCaseAddress(text) {
  return text.split(' ').map((word) => {
    if (!word) return word;
    // Compass directions and state codes stay uppercase: NE, NW, SE, SW, WA.
    if (/^[A-Z]{2,3}$/.test(word)) return word;
    // Anything already carrying an uppercase letter (or starting with a digit, like 104th)
    // is left alone — only all-lowercase words get capitalized.
    if (/[A-Z]/.test(word)) return word;
    if (/^\d/.test(word)) return word;
    return word[0].toUpperCase() + word.slice(1);
  }).join(' ');
}

/**
 * Pull an address out of a listing URL. Returns { address, city, state, zip, source, confident }.
 * Handles the shapes Zillow and Redfin actually use, plus generic /address/<slug> layouts.
 */
export function parseListingUrl(input) {
  let url;
  try { url = new URL(input.trim()); } catch { return null; }
  const host = url.hostname.replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (!parts.length) return null;

  // ── Redfin: /<STATE>/<City>/<street-and-zip>/home/<id> ────────────────────
  // The path is structured, so street/city/state/zip are all unambiguous.
  if (/redfin\.com$/.test(host)) {
    const homeIdx = parts.findIndex((p) => p === 'home' || p === 'apartment');
    const head = homeIdx > 0 ? parts.slice(0, homeIdx) : parts;
    if (head.length >= 3) {
      const state = head[0].toUpperCase();
      const city = head[1].replace(/-/g, ' ');
      const { street, zip } = splitStreetAndZip(head[2]);
      if (US_STATES.has(state) && street) {
        return {
          address: `${titleCaseAddress(street)}, ${titleCaseAddress(city)}, ${state}${zip ? ' ' + zip : ''}`,
          street, city, state, zip, source: 'redfin-url', confident: true,
        };
      }
    }
  }

  // ── Zillow: /homedetails/12000-NE-80th-St-Kirkland-WA-98033/123_zpid/ ──────
  // Address, city, state and zip are all in ONE dash-joined slug, so the street/city
  // boundary is ambiguous. We don't need to resolve it: passing the whole thing to the
  // estimator (which geocodes) works, and state+zip come out cleanly for display.
  const slugPart = parts.find((p) => /\d{5}(?:-\d{4})?$/.test(p)) || '';
  if (/(zillow|trulia)\.com$/.test(host) && slugPart) {
    const { zip } = splitStreetAndZip(slugPart);
    const tokens = slugPart.split(/[-_]+/).filter(Boolean);
    // walk back from the end: zip, then 2-letter state
    const tail = tokens.slice();
    if (zip) tail.pop();
    const state = (tail[tail.length - 1] || '').toUpperCase();
    if (US_STATES.has(state) && tail.length >= 3) {
      tail.pop(); // drop state
      const flat = tail.join(' ');
      // Trim a trailing unit marker ("Unit 2") so the geocoder sees the building.
      const cleaned = flat.replace(/\s+(unit|apt|apartment|#)\s*\w+$/i, '').trim();
      return {
        address: `${titleCaseAddress(cleaned)}, ${state}${zip ? ' ' + zip : ''}`,
        street: null, city: null, state, zip, source: 'zillow-url', confident: false,
      };
    }
  }

  // ── Generic /address/<slug>/ layouts (crexi, loopnet, realtor, etc.) ──────
  const addrIdx = parts.findIndex((p) => /^(address|homedetails|property)$/.test(p));
  const generic = addrIdx >= 0 ? parts[addrIdx + 1] : parts.find((p) => /\d/.test(p) && /-/.test(p));
  if (generic) {
    const { street, zip } = splitStreetAndZip(generic);
    const tokens = street.split(' ').filter(Boolean);
    const state = (tokens[tokens.length - 1] || '').toUpperCase();
    if (US_STATES.has(state) && tokens.length >= 4) {
      return {
        address: `${titleCaseAddress(tokens.slice(0, -1).join(' '))}, ${state}${zip ? ' ' + zip : ''}`,
        street: null, city: null, state, zip, source: `${host}-url`, confident: false,
      };
    }
    if (street) {
      return { address: titleCaseAddress(street), street, city: null, state: null, zip, source: `${host}-url`, confident: false };
    }
  }

  return null;
}

/**
 * Accepts whatever the visitor typed: a listing URL, or a plain address.
 * Returns a normalized { address, source, confident } or null when it's unusable.
 */
export function normalizeQuery(raw) {
  const input = String(raw || '').trim();
  if (input.length < 5 || input.length > 500) return null;

  if (/^https?:\/\//i.test(input) || /^(www\.)?(zillow|redfin|redf\.in|trulia|realtor|crexi|loopnet)\./i.test(input)) {
    const parsed = parseListingUrl(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (parsed) return parsed;
    return { address: null, source: 'url-unparsed', confident: false, rawUrl: input };
  }

  // Plain address: needs at least a number and some letters to be worth a paid lookup.
  if (!/\d/.test(input) || !/[a-z]{2,}/i.test(input)) return null;
  return { address: input.replace(/\s+/g, ' '), source: 'typed-address', confident: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Last-resort fallback: fetch the page and look for an address in its metadata.
// Only reached when the URL itself carries no parseable address. Zillow and Redfin
// frequently block datacenter IPs, so this is a bonus path, never the primary one.
// ─────────────────────────────────────────────────────────────────────────────

const ADDRESS_RE = /\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Cir|Circle|Hwy|Highway|Pkwy|Parkway|Trl|Trail|Loop)\b[^,<]{0,40},?\s*[A-Z][A-Za-z .'-]*,?\s*[A-Z]{2}\s*\d{5}/;

export async function fetchPageAddress(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400000);
    for (const re of [
      /"streetAddress"\s*:\s*"([^"]+)"/i,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    ]) {
      const m = html.match(re);
      if (!m) continue;
      const candidate = m[1].replace(/&#39;|&amp;|&quot;/g, "'").replace(/\s*\|\s*.*$/, '').trim();
      const hit = candidate.match(ADDRESS_RE) || (/\d/.test(candidate) && /,\s*[A-Z]{2}/.test(candidate) ? [candidate] : null);
      if (hit) return { address: hit[0].replace(/\s+/g, ' ').trim(), source: 'page-metadata', confident: false };
    }
    return null;
  } catch { return null; }
}

/** Stable cache key for an address so repeat lookups are free. */
export function addressKey(address) {
  return String(address || '')
    .toLowerCase()
    .replace(/\b(street|avenue|boulevard|drive|lane|court|place|terrace|circle|highway|parkway|trail|loop)\b/g,
      (m) => ({ street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl',
                terrace: 'ter', circle: 'cir', highway: 'hwy', parkway: 'pkwy', trail: 'trl', loop: 'lp' }[m]))
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// ─────────────────────────────────────────────────────────────────────────────
// AirROI — revenue forecast + real operating comps
// ─────────────────────────────────────────────────────────────────────────────

export async function airroiEstimate({ address, bedrooms, baths, guests }) {
  if (!airroiReady() || !address) return null;
  const beds = Number(bedrooms) > 0 ? Number(bedrooms) : 3;
  const q = new URLSearchParams({
    address,
    bedrooms: String(beds),
    baths: String(baths || Math.ceil(beds * 0.75)),
    guests: String(guests || beds * 2 + 2),
  });
  try {
    const res = await fetch(`${AIRROI_BASE}/calculator/estimate?${q}`, {
      headers: { 'X-API-KEY': process.env.AIRROI_API_KEY, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Squeeze AirROI's response into the shape the UI renders. */
export function summarizeAirROI(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw.percentiles?.revenue || {};
  const comps = Array.isArray(raw.comparable_listings) ? raw.comparable_listings : [];
  const revenue = Math.round(Number(raw.revenue) || 0);
  if (!revenue) return null;
  return {
    source: 'airroi',
    annualRevenue: revenue,
    adr: Math.round(Number(raw.average_daily_rate) || 0),
    occupancy: Math.round((Number(raw.occupancy) || 0) * 1000) / 10,   // API returns 0-1
    revenueRange: {
      p25: Math.round(Number(p.p25) || 0),
      p50: Math.round(Number(p.p50) || revenue),
      p75: Math.round(Number(p.p75) || 0),
      p90: Math.round(Number(p.p90) || 0),
    },
    compsAnalyzed: comps.length,
    markets: {
      adr: Math.round(Number(raw.percentiles?.average_daily_rate?.avg) || 0),
      occupancy: Math.round((Number(raw.percentiles?.occupancy?.avg) || 0) * 1000) / 10,
    },
    location: raw.location || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BnBCalc — buy analysis ($0.20/report; only ever called behind an email or a paid account)
// ─────────────────────────────────────────────────────────────────────────────

export async function bnbcalcBuy({ address, lat, lng, bedrooms, bathrooms, accomodates, purchasePriceUSD }) {
  if (!bnbcalcReady() || !paidLookupsAllowed()) return null;
  const beds = Number(bedrooms) > 0 ? Number(bedrooms) : 3;
  const body = {
    bedrooms: beds,
    bathrooms: bathrooms || Math.ceil(beds * 0.75),
    accomodates: accomodates || beds * 2 + 2,
    purchasePriceUSD: Number(purchasePriceUSD) || 750000,
  };
  if (lat && lng) { body.lat = lat; body.lng = lng; }
  else if (address) body.fullAddress = address;   // field is fullAddress, NOT address — the API 400s otherwise
  else return null;

  try {
    const res = await fetch(`${BNBCALC_BASE}/v1/external/analysis/create/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bnbcalc-api-key': process.env.BNBCALC_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),   // reports take ~10-30s to build
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** BnBCalc's live shape: quartiles.<p>_percentile.{average_daily_rate,occupancy_rate,revenue}. */
export function summarizeBnBCalc(raw) {
  const d = raw?.data;
  if (!raw?.success || !d) return null;
  const q50 = d.quartiles?.['50th_percentile'] || {};
  const q = (k) => {
    const v = d.quartiles?.[k] || {};
    return { revenue: Math.round(Number(v.revenue) || 0), adr: Math.round(Number(v.average_daily_rate) || 0) };
  };
  const revenue = Math.round(Number(q50.revenue) || (Number(d.monthlyRevenueUSD) || 0) * 12);
  if (!revenue) return null;
  const comps = Array.isArray(d.comparables) ? d.comparables : [];
  return {
    source: 'bnbcalc',
    annualRevenue: revenue,
    adr: Math.round(Number(d.ratePerNightUSD) || Number(q50.average_daily_rate) || 0),
    occupancy: Math.round((Number(d.occupancyRatePercentage ?? q50.occupancy_rate) || 0) * 10) / 10,
    revenueRange: { p25: q('25th_percentile').revenue, p50: revenue, p75: q('75th_percentile').revenue, p90: q('90th_percentile').revenue },
    compsAnalyzed: comps.length,
    reportUrl: d.url || null,
    confidence: comps.length >= 10 ? 'strong' : comps.length >= 3 ? 'moderate' : 'thin',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache — repeat lookups for the same address cost nothing
// ─────────────────────────────────────────────────────────────────────────────

export async function readCache(key, maxAgeHours = 24 * 30) {
  try {
    const r = await sb(`/rest/v1/lookup_cache?address_key=eq.${encodeURIComponent(key)}&select=payload,created_at`);
    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (!row) return null;
    const age = (Date.now() - new Date(row.created_at).getTime()) / 3600000;
    return age <= maxAgeHours ? row.payload : null;
  } catch { return null; }
}

export async function writeCache(key, query, payload) {
  try {
    await sb('/rest/v1/lookup_cache', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: { address_key: key, query: String(query).slice(0, 300), payload, created_at: new Date().toISOString() },
    });
  } catch { /* caching must never fail a lookup */ }
}
