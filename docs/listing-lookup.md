# VomCalc — Listing Lookup (comps + revenue estimates)

The front door: someone pastes a **Zillow or Redfin link, or any address**, and gets real
revenue numbers in seconds. No account needed to see the numbers; the account is for the full
underwriting.

```
POST /api/lookup      { "query": "<zillow/redfin URL or address>", "bedrooms": 3 }
                      200  { address, estimate, comps, cached }
                      400  unusable input      422  link unreadable, asks for the address
                      429  rate limited        404  address outside covered markets
```

## Why a link works even though Zillow blocks scraping

Zillow and Redfin both carry the **address in the URL path**. We parse it out, so a shared link
resolves with no page fetch at all:

| Link shape | What we get |
|---|---|
| `redfin.com/WA/Kirkland/12000-NE-80th-St-98033/home/285135` | street, city, state, zip — all unambiguous |
| `zillow.com/homedetails/16508-104th-Ave-NE-Bothell-WA-98011/123_zpid/` | state + zip clean; street left to the geocoder |
| a typed address | used as-is |

The path is the primary route. A page fetch (metadata/JSON-LD) is a fallback for other sites,
and if a short link carries no address we ask for the address rather than guessing.

**This is what fixed Zillow in the app** — the import flow previously refused a Zillow URL
outright ("Zillow blocks automated imports"). It now resolves the property from the link.

## Which links underwrite automatically, and which need one field

| Link | Address | Asking price | Revenue + comps | Auto-scored? |
|---|---|---|---|---|
| **Redfin** | URL path | page import | yes | **yes** (verified: scored 6 / Poor Deal) |
| **Zillow** | URL path | Firecrawl render | yes | **yes** (verified: scored 1 / Poor Deal) |
| Trulia | URL path | Firecrawl render | yes | yes |
| **Crexi / LoopNet / CoStar** | URL path | **not trusted** | yes | no — visitor types the price |

Two honest limitations on the commercial sites:

1. **Their asking price can't be read reliably.** Asked for a LoopNet listing priced at
   $4,750,000, the LLM extraction returned $3,195,000. Inspecting the page explains it: the
   render contains only the tax assessment ($3,154,200 improvements + $316,800 land = $3,471,000)
   and no asking price at all — the model was quietly reading an *assessed value*. A confidently
   wrong price produces a confidently wrong score, so commercial hosts get no price scrape.
2. **They are commercial listings.** A 30-unit apartment building is not an STR deal, so the
   revenue model doesn't describe it. These links are accepted, and land on the underwriting page
   with revenue filled and the price field highlighted.

### The price guard

Every scraped price must survive a plausibility check against the revenue we estimated
independently: a gross yield outside **1.5%–35%** means the price is not used, and the visitor is
shown why instead. This is the backstop that stops a mis-read figure from silently driving a
score — the $3,195,000 assessment vs $43,913 revenue case fails it (1.4%) and is rejected.

## Data sources

| Source | Gives | Cost |
|---|---|---|
| **AirROI** (`api.airroi.com`, `X-API-KEY`) | revenue forecast + percentiles, ADR, occupancy, and up to 25 real operating listings with **trailing-12-month performance** | no per-call fee |
| **BnBCalc** (`atlas.bnbcalc.com`, `x-bnbcalc-api-key`) | buy analysis with quartile bands + comparables + a shareable report URL | **$0.20 per report** |

Verified live response paths (the docs are wrong about several of these):

```
AirROI   /calculator/estimate?address=&bedrooms=&baths=&guests=
         → revenue, average_daily_rate, occupancy (0–1), percentiles.{revenue,average_daily_rate,occupancy}.{avg,p25,p50,p75,p90}
         → comparable_listings[].listing_info.listing_name / .listing_type / .listing_id
                                 .property_details.{bedrooms,baths,guests}
                                 .performance_metrics.ttm_revenue / .ttm_avg_rate / .ttm_occupancy   ← TTM, not a plain "revenue"
                                 .ratings.rating_overall / .num_reviews
                                 .host_info.superhost
         (there is no listing URL field — build it from listing_id: airbnb.com/rooms/<id>)

BnBCalc  POST /v1/external/analysis/create/buy   body: bedrooms, bathrooms, accomodates,
                                                 purchasePriceUSD, and lat+lng OR fullAddress
         → data.quartiles.{"25th","50th","75th","90th"_percentile}.{revenue,average_daily_rate,occupancy_rate}
         → data.ratePerNightUSD, data.occupancyRatePercentage, data.comparables[], data.url
         (the documented data.revenue object does NOT exist; reports take 10–30s to build)
```

Two independent models on the same address land within roughly 10–15% of each other
(one Bothell test: AirROI $56.6K vs BnBCalc $49.6K) — which is why the UI shows a *range*
rather than a single authoritative number.

## Cost control (important — this is a public box)

1. **Cache** — one row per normalized address in `lookup_cache`. The same property costs the
   providers once, and a Redfin link and a Zillow link for the same house share a key.
2. **Rate limits** — 12/hour and 40/day per IP, enforced atomically by `bump_lookup_usage()`
   (a read-then-write race would let concurrent requests both slip past).
3. **BnBCalc is never called for an anonymous request.** It requires a signed-in account, is
   capped at 5/account/day, and stays **off entirely** unless `STR_ALLOW_PAID_LOOKUPS=true`.
   Turn it on deliberately — the public box cannot spend money by design.

## Environment

| Var | Purpose |
|---|---|
| `AIRROI_API_KEY` | revenue + comps (required — without it the endpoint returns 503) |
| `BNBCALC_API_KEY` | buy analysis (optional) |
| `FIRECRAWL_API_KEY` | renders Zillow/Trulia pages to read the asking price (Vercel only) |
| `STR_ALLOW_PAID_LOOKUPS` | `true` to permit the $0.20 BnBCalc reports |

Keys live in `~/.hermes/vomcalc_env` and are set in Vercel (production + development;
the CLI refuses non-interactive `preview` adds without a branch, so previews lack them).

## App wiring — two traps worth remembering

Setting the revenue fields from market data is order-sensitive, because the form keeps **one
authoritative figure and derives the other** (`_revenueSource`):

- `onAnnualRevenueChange()` → makes revenue authoritative, derives ADR
- `onADRChange()` → makes ADR authoritative, derives revenue
- `onOccupancyChange()` → re-derives ADR from revenue

Writing all three in the wrong order means they overwrite each other (observed: $127,746 in
became $145,434 out). Correct order is **occupancy → revenue → ADR (display only, no handler)**.
Also note the revenue input's id is `annualRevenueInput`, not `annualRevenue` — and
`setCurrencyVal()` returns silently on a missing element, so a wrong id looks like a no-op
rather than an error.

Deep link: `/app?address=<urlencoded>` prefills the field, pulls market data, then strips the
query string.

## Tests

```bash
node supabase/tests/lookup-parse.test.mjs    # 23 assertions: real Zillow/Redfin URL shapes,
                                             # ambiguous slugs, junk rejection, cache-key stability
node /tmp/lookup_local.mjs "<query>"         # run the real handler + real APIs locally
```

Both providers were verified against live APIs, including one real BnBCalc report to confirm
the paid path returns data (not just that its key authenticates).
