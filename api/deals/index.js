/**
 * /api/deals — Save, list, update, delete deals.
 * Uses the existing `reports` table as the deals store.
 * Extra fields (equity_multiple, coc, status, variant_of, variant_name) live in result_snapshot.
 */
const SB_URL = 'https://rxkeeidytafjogiohvgi.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4a2VlaWR5dGFmam9naW9odmdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDkxNjYsImV4cCI6MjA4ODQ4NTE2Nn0.QdZCFdzuCOTcxPYnWP_gM-1rC1sjgmRc92xg8tkxmAc';

function sbKey(svc) { return svc ? process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY : SB_ANON; }

async function ensurePublicUser(userId, email) {
  if (!userId) return;
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const now = new Date().toISOString();
    await fetch(`${SB_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        apikey: svcKey, Authorization: `Bearer ${svcKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: userId, email: email || null, updated_at: now, last_login_at: now }),
    });
  } catch { /* non-fatal */ }
}

async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: svcKey, Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return d?.id ? { id: d.id, email: d.email } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization || '';
  const userJwt = authHeader.replace('Bearer ', '');

  // LIST deals
  if (req.method === 'GET') {
    const key = sbKey(false);
    const r = await fetch(
      `${SB_URL}/rest/v1/reports?order=created_at.desc&select=id,title,property_address,property_type,listed_price,velocity_score,moic,irr,result_snapshot,created_at,updated_at`,
      { headers: { apikey: key, Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' } }
    );
    const data = await r.json();
    // Flatten result_snapshot extras into each record
    const deals = Array.isArray(data) ? data.map(d => ({
      ...d,
      ...(d.result_snapshot || {}),
      name: d.title || d.property_address,
    })) : data;
    return res.status(r.status).json(deals);
  }

  // SAVE deal
  if (req.method === 'POST') {
    const body = req.body || {};
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!key) return res.status(500).json({ error: 'Server misconfigured' });

    // Ensure user exists in public.users to satisfy FK constraint
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const authUser = await getUserFromToken(token);
    const resolvedUserId = authUser?.id || body.user_id || null;
    await ensurePublicUser(resolvedUserId, authUser?.email);

    const report = {
      user_id: resolvedUserId,
      title: body.name || body.address || 'Untitled Deal',
      property_address: body.address || '',
      property_type: body.property_type || 'str',
      listed_price: body.listed_price || 0,
      velocity_score: body.velocity_score || 0,
      moic: body.moic || 0,
      irr: body.irr || 0,
      input_snapshot: body.inputs || {},
      result_snapshot: {
        // Core metrics
        moic: body.moic,
        irr: body.irr,
        coc: body.coc,
        equity_multiple: body.equity_multiple,
        total_equity: body.total_equity,
        annual_cash_flow: body.annual_cash_flow,
        totalScore: body.velocity_score,
        propertyType: body.property_type,
        // Deal tracking
        status: body.status || 'analyzing',
        notes: body.notes || '',
        tags: body.tags || [],
        // Variant
        variant_of: body.variant_of || null,
        variant_name: body.variant_name || null,
        is_base_case: body.is_base_case ?? true,
        // Outputs snapshot
        ...(body.outputs || {}),
        savedAt: new Date().toISOString(),
      },
    };

    // If updating existing deal
    if (body.id) {
      const r = await fetch(`${SB_URL}/rest/v1/reports?id=eq.${body.id}`, {
        method: 'PATCH',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ ...report, updated_at: new Date().toISOString() }),
      });
      return res.status(r.ok ? 200 : 400).json(await r.json());
    }

    const r = await fetch(`${SB_URL}/rest/v1/reports`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(report),
    });
    const data = await r.json();
    return res.status(r.ok ? 201 : 400).json(data);
  }

  // UPDATE (status/notes only)
  if (req.method === 'PATCH') {
    const { id, status, notes, name } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    // Get current snapshot, merge update
    const curr = await fetch(`${SB_URL}/rest/v1/reports?id=eq.${id}&select=result_snapshot,title`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }).then(r => r.json()).then(d => d[0] || {});

    const updatedSnapshot = { ...(curr.result_snapshot || {}), status, notes };
    const r = await fetch(`${SB_URL}/rest/v1/reports?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ title: name || curr.title, result_snapshot: updatedSnapshot, updated_at: new Date().toISOString() }),
    });
    return res.status(r.ok ? 200 : 400).json(await r.json());
  }

  // DELETE
  if (req.method === 'DELETE') {
    const id = req.query.id || req.body?.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(`${SB_URL}/rest/v1/reports?id=eq.${id}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return res.status(r.ok ? 204 : 400).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
