/**
 * POST /api/deals/setup — creates the deals table if it doesn't exist.
 * Call once, protected by MIGRATION_SECRET env var.
 */
import pg from 'pg';
const { Pool } = pg;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { secret } = req.body || {};
  if (secret !== process.env.MIGRATION_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const sql = `
    CREATE TABLE IF NOT EXISTS public.deals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      name TEXT,
      address TEXT,
      property_type TEXT,
      status TEXT NOT NULL DEFAULT 'analyzing',
      velocity_score INTEGER,
      listed_price NUMERIC,
      equity_multiple NUMERIC,
      irr NUMERIC,
      coc NUMERIC,
      moic NUMERIC,
      total_equity NUMERIC,
      annual_cash_flow NUMERIC,
      notes TEXT,
      tags TEXT[] DEFAULT '{}',
      variant_of UUID REFERENCES public.deals(id) ON DELETE SET NULL,
      variant_name TEXT,
      is_base_case BOOLEAN DEFAULT TRUE,
      inputs JSONB,
      outputs JSONB,
      deal_os_id TEXT
    );
    CREATE INDEX IF NOT EXISTS deals_user_id_idx ON public.deals(user_id);
    CREATE INDEX IF NOT EXISTS deals_variant_of_idx ON public.deals(variant_of);
  `;

  try {
    await pool.query(sql);
    await pool.end();
    return res.status(200).json({ ok: true, message: 'deals table created/verified' });
  } catch (err) {
    await pool.end();
    return res.status(500).json({ error: err.message });
  }
}
