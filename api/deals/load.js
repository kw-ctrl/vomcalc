/**
 * GET /api/deals/load?id=<reportId>
 * Returns full deal data (inputs + outputs) for reload.
 */
export const config = { maxDuration: 10 };

// Account-backend config. Single source of truth: the SUPABASE_URL env var.
// Falls back to the historical project ref so behaviour is unchanged if unset.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rxkeeidytafjogiohvgi.supabase.co';

// Cheap liveness probe so an unreachable backend returns a clean 503 JSON
// instead of an unhandled fetch throw (which surfaces as FUNCTION_INVOCATION_FAILED).
async function backendReachable() {
  if (!SUPABASE_URL) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/health`, { signal: AbortSignal.timeout(4000) });
    return r.status < 500;
  } catch { return false; }
}
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;

  if (!(await backendReachable())) {
    return res.status(503).json({ error: 'Account backend unavailable' });
  }
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/reports?id=eq.${id}&select=*`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const data = await r.json();
    if (!r.ok || !data?.length) return res.status(404).json({ error: 'Deal not found' });
    const row = data[0];
    return res.status(200).json({
      id: row.id,
      name: row.title,
      inputs: row.input_snapshot,
      outputs: row.result_snapshot,
      address: row.property_address,
      propertyType: row.property_type,
      status: row.result_snapshot?.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
