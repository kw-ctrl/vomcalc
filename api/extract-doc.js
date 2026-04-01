/**
 * Vercel serverless function: POST /api/extract-doc
 * Accepts a document (PDF text or raw text) and uses Claude to extract property details.
 */
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI extraction not configured. Contact admin.' });

  const { text, filename } = req.body || {};
  if (!text || text.length < 50) return res.status(400).json({ error: 'No document text provided.' });

  const prompt = `You are a real estate underwriting assistant. Extract property details from this listing or document and return ONLY a JSON object with these exact fields (use null for any field not found):

{
  "address": "full property address as a string",
  "propertyType": "STR" or "Boutique Hotel" or "LTR" or "Commercial",
  "listedPrice": number (listing/asking price in dollars),
  "bedrooms": number,
  "bathrooms": number,
  "squareFeet": number (interior living area in sq ft),
  "yearBuilt": number or null,
  "lotSize": number or null (acres),
  "numberOfUnits": number or null,
  "adr": number or null (Average Daily Rate for STR, dollars per night),
  "occupancyRate": number or null (as percentage 0-100),
  "annualRevenue": number or null (gross annual rental income),
  "annualExpenses": number or null,
  "operatingExpenses": number or null (monthly operating expenses),
  "propertyTax": number or null (annual property taxes),
  "hoaFees": number or null (monthly HOA),
  "noi": number or null (Net Operating Income annual),
  "capRate": number or null (as percentage),
  "renovationBudget": number or null,
  "downPaymentPct": number or null (as percentage, e.g. 20 for 20%),
  "interestRate": number or null (as percentage),
  "notes": "any other relevant details in 1-2 sentences"
}

Look carefully for: beds/bd, baths/ba, sq ft/sqft/square feet, price/asking/list price, beds, baths.

Document:
${text.slice(0, 8000)}

Return ONLY the JSON object, no explanation.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
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

    const data = await response.json();
    const raw = data?.content?.[0]?.text?.trim() || '';

    let parsed;
    try {
      // Strip markdown code fences if present
      const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      return res.status(200).json({ error: 'Could not parse property details. Try a cleaner document.' });
    }

    return res.status(200).json({ ok: true, data: parsed });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Extraction failed.' });
  }
}
