/**
 * Vercel serverless: POST /api/listings/import
 * Fetches a real estate listing URL and extracts property data via Claude.
 */
export const config = { maxDuration: 30 };

// Try to regex-extract the most likely listed price from page text
function regexExtractPrice(text) {
  // Look for patterns like "List Price: $1,200,000" or "$1,200,000" near "price" or "listed"
  const patterns = [
    /(?:list(?:ed)?\s*price|asking\s*price|sale\s*price)[^\d$]*\$?([\d,]+)/i,
    /\$([\d,]+)\s*(?:list|asking|sale)/i,
    // First large $ amount on page that looks like a home price (100k–50M)
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''));
      if (n >= 50000 && n <= 50000000) return n;
    }
  }
  // Fallback: find all $ amounts, return the first one in home-price range
  const allPrices = [...text.matchAll(/\$([\d,]+)/g)]
    .map(m => parseInt(m[1].replace(/,/g, '')))
    .filter(n => n >= 50000 && n <= 50000000);
  return allPrices.length > 0 ? allPrices[0] : null;
}

function regexExtractSqft(text) {
  const m = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|square\s*feet)/i);
  if (m) { const n = parseInt(m[1].replace(/,/g,'')); if (n > 200 && n < 100000) return n; }
  return null;
}

function regexExtractBeds(text) {
  const m = text.match(/(\d+)\s*(?:bed(?:room)?s?|bd)/i);
  if (m) { const n = parseInt(m[1]); if (n > 0 && n <= 20) return n; }
  return null;
}

function regexExtractBaths(text) {
  const m = text.match(/([\d.]+)\s*(?:bath(?:room)?s?|ba)/i);
  if (m) { const n = parseFloat(m[1]); if (n > 0 && n <= 20) return n; }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Listing import not configured.' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'No URL provided.' });

  // Fetch the listing page
  let rawHtml = '';
  let pageText = '';
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
    });
    rawHtml = await r.text();
    // Detect anti-bot blocks (PerimeterX, Cloudflare, etc.)
    if (
      rawHtml.includes('px-captcha') ||
      rawHtml.includes('PerimeterX') ||
      rawHtml.includes('_pxAppId') ||
      rawHtml.includes('Access to this page has been denied') ||
      rawHtml.includes('cf-mitigated') ||
      (r.status === 403)
    ) {
      const isZillow = url.includes('zillow.com');
      return res.status(200).json({
        ok: false,
        blocked: true,
        source: isZillow ? 'zillow' : 'unknown',
        error: isZillow
          ? 'Zillow blocks automated imports. Try the same property on Redfin — search the address at redfin.com and paste that URL instead.'
          : 'This site blocks automated access. Try the document upload or enter details manually.',
      });
    }
    // Strip tags, scripts, styles
    pageText = rawHtml
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s{3,}/g, '\n')
      .slice(0, 10000);
  } catch (err) {
    return res.status(400).json({ error: `Could not fetch listing: ${err.message}` });
  }

  // Pre-extract with regex (fast, reliable for structured pages)
  const regexPrice = regexExtractPrice(pageText);
  const regexSqft = regexExtractSqft(pageText);
  const regexBeds = regexExtractBeds(pageText);
  const regexBaths = regexExtractBaths(pageText);

  const prompt = `Extract property details from this real estate listing page. Return ONLY valid JSON:

{
  "address": "full street address with city, state, zip",
  "propertyType": "STR",
  "listedPrice": number (the ASKING/LIST price in dollars, not Zestimate/estimate),
  "bedrooms": number,
  "bathrooms": number,
  "squareFeet": number,
  "yearBuilt": number or null,
  "lotSize": number or null (acres),
  "hoaFees": number or null (monthly),
  "propertyTax": number or null (annual),
  "description": "1-sentence summary"
}

IMPORTANT: listedPrice must be the listed/asking price, NOT an estimated value.

Listing page:
${pageText.slice(0, 8000)}`;

  try {
    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiResp.json();
    const raw = aiData?.content?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed = {};
    try { parsed = JSON.parse(clean); } catch { parsed = {}; }

    // Merge: regex wins for price/sqft/beds/baths if Claude missed them
    const price = parsed.listedPrice || regexPrice;
    const sqft  = parsed.squareFeet || regexSqft;
    const beds  = parsed.bedrooms   || regexBeds;
    const baths = parsed.bathrooms  || regexBaths;

    return res.status(200).json({
      ok: true,
      address:     parsed.address || null,
      propertyType: parsed.propertyType || 'STR',
      price:        price,
      listedPrice:  price,
      squareFeet:   sqft,
      bedrooms:     beds,
      bathrooms:    baths,
      yearBuilt:    parsed.yearBuilt || null,
      lotSize:      parsed.lotSize || null,
      hoaFees:      parsed.hoaFees || null,
      propertyTax:  parsed.propertyTax || null,
      description:  parsed.description || null,
    });
  } catch (err) {
    // If AI fails, return regex results only
    return res.status(200).json({
      ok: true,
      price: regexPrice,
      listedPrice: regexPrice,
      squareFeet: regexSqft,
      bedrooms: regexBeds,
      bathrooms: regexBaths,
      warnings: ['AI extraction failed; partial data from page scan.'],
    });
  }
}
