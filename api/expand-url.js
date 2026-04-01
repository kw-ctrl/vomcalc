/**
 * Vercel serverless: GET /api/expand-url?url=...
 * Follows a short URL redirect and returns the final destination.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL' });

  try {
    const r = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return res.status(200).json({ url: r.url });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
