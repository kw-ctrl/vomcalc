/**
 * GET /api/deals/list
 * Returns all saved deals for the authenticated user.
 */
export const config = { maxDuration: 10 };

const SUPABASE_URL = 'https://rxkeeidytafjogiohvgi.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(200).json({ deals: [] });

  let userId = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${token}` }
    });
    const d = await r.json();
    userId = d?.id || null;
  } catch { userId = null; }

  if (!userId) return res.status(200).json({ deals: [] });

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/reports?user_id=eq.${userId}&order=updated_at.desc&select=id,title,property_address,property_type,listed_price,velocity_score,moic,irr,result_snapshot,created_at,updated_at`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to load deals' });
    // Normalize — pull coc/equity_multiple/status/variant info from result_snapshot
    const deals = (data || []).map(d => ({
      id: d.id,
      name: d.title,
      address: d.property_address,
      propertyType: d.property_type,
      listedPrice: d.listed_price,
      velocityScore: d.velocity_score,
      moic: d.moic,
      irr: d.irr,
      coc: d.result_snapshot?.coc,
      equityMultiple: d.result_snapshot?.equityMultiple,
      totalEquity: d.result_snapshot?.totalEquity,
      annualCashFlow: d.result_snapshot?.annualCashFlow,
      status: d.result_snapshot?.status || 'analyzing',
      notes: d.result_snapshot?.notes,
      variantOf: d.result_snapshot?.variantOf,
      variantName: d.result_snapshot?.variantName,
      isBaseCase: d.result_snapshot?.isBaseCase !== false,
      savedAt: d.result_snapshot?.savedAt || d.updated_at,
      createdAt: d.created_at,
    }));
    return res.status(200).json({ deals });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
