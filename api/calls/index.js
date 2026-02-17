/**
 * GET /api/calls — Returns recent call data for the dashboard
 * 
 * Reads from Vercel KV if available, otherwise returns demo data.
 * Query params: ?limit=20 (default 50)
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const limit = Math.min(parseInt(req.query?.limit || '50'), 200);

  // Try Vercel KV
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      // Get recent call keys
      const listRes = await fetch(`${process.env.KV_REST_API_URL}/lrange/recent_calls/0/${limit - 1}`, {
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
      });
      const listData = await listRes.json();
      const keys = listData?.result || [];

      if (keys.length === 0) {
        return res.json({ calls: [], source: 'kv', count: 0 });
      }

      // Fetch all call records
      const calls = [];
      for (const key of keys) {
        try {
          const callRes = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
            headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
          });
          const callData = await callRes.json();
          if (callData?.result) {
            calls.push(JSON.parse(callData.result));
          }
        } catch (e) { /* skip bad records */ }
      }

      return res.json({
        calls: calls.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
        source: 'kv',
        count: calls.length
      });
    } catch (e) {
      console.error('KV fetch error:', e.message);
    }
  }

  // Fallback: demo data so dashboard always shows something
  return res.json({
    calls: [
      { id: 'demo-1', type: 'booking', caller_name: 'Sarah M.', phone: '+12815550142', job: 'Kitchen faucet leak, dripping under sink', time: new Date(Date.now() + 86400000 * 3).toISOString(), duration: 154, created_at: new Date().toISOString() },
      { id: 'demo-2', type: 'booking', caller_name: 'James R.', phone: '+18325550198', job: 'Water heater not producing hot water', time: new Date(Date.now() + 86400000 * 4).toISOString(), duration: 192, created_at: new Date(Date.now() - 3600000).toISOString() },
      { id: 'demo-3', type: 'call', caller_name: 'Unknown', phone: '+19365550077', job: 'Pricing question — toilet replacement', duration: 105, created_at: new Date(Date.now() - 7200000).toISOString() },
      { id: 'demo-4', type: 'emergency', caller_name: 'Maria G.', phone: '+12815550234', issue: 'Basement flooding, water coming through wall', alert_sent: true, duration: 118, created_at: new Date(Date.now() - 50400000).toISOString() },
      { id: 'demo-5', type: 'booking', caller_name: 'David K.', phone: '+18325550311', job: 'Garbage disposal making grinding noise', time: new Date(Date.now() + 86400000 * 5).toISOString(), duration: 141, created_at: new Date(Date.now() - 57600000).toISOString() },
    ],
    source: 'demo',
    count: 5
  });
};
