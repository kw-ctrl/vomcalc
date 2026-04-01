/**
 * POST /api/deals/save
 * Saves a deal analysis to Supabase.
 * Uses the existing `reports` table, with variant/status/notes in result_snapshot.
 */
export const config = { maxDuration: 15 };

const SUPABASE_URL = 'https://rxkeeidytafjogiohvgi.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${token}` }
    });
    const d = await r.json();
    return d?.id || null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = await getUserId(token);

  const {
    reportId,     // update existing report
    variantOf,    // save as variant of this report ID
    variantName,
    name,
    inputs,
    outputs,
    notes,
    status,
  } = req.body || {};

  if (!inputs || !outputs) return res.status(400).json({ error: 'inputs and outputs required' });

  const resultSnapshot = {
    ...outputs,
    savedAt: new Date().toISOString(),
    status: status || 'analyzing',
    notes: notes || null,
    variantOf: variantOf || null,
    variantName: variantName || null,
    isBaseCase: !variantOf,
  };

  const row = {
    user_id: userId,
    title: name || inputs.propertyAddress || 'Untitled Deal',
    property_address: inputs.propertyAddress || null,
    property_type: inputs.propertyType || null,
    listed_price: inputs.listedPrice || null,
    velocity_score: outputs.totalScore || null,
    moic: outputs.moic || null,
    irr: outputs.irr || null,
    input_snapshot: inputs,
    result_snapshot: resultSnapshot,
    updated_at: new Date().toISOString(),
  };

  let url = `${SUPABASE_URL}/rest/v1/reports`;
  let method = 'POST';
  if (reportId) {
    url += `?id=eq.${reportId}`;
    method = 'PATCH';
  }

  try {
    const r = await fetch(url, {
      method,
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.message || 'Save failed' });
    const saved = Array.isArray(data) ? data[0] : data;
    return res.status(200).json({ ok: true, id: saved?.id, report: saved });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
