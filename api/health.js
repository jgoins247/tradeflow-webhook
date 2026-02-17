/**
 * GET /api/health — Verifies all services are connected
 * 
 * Returns status of: Twilio, Cal.com, Vercel KV
 * Hit this after deploy to make sure everything's wired up.
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const status = {
    service: 'ai-answering-service',
    timestamp: new Date().toISOString(),
    checks: {}
  };

  // Check env vars are present
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'CALCOM_API_KEY', 'CALCOM_EVENT_TYPE_ID', 'OWNER_PHONE_NUMBER', 'OWNER_NAME', 'BUSINESS_NAME'];
  const missing = required.filter(k => !process.env[k]);
  status.checks.env_vars = missing.length === 0
    ? { ok: true, message: 'All required env vars present' }
    : { ok: false, message: `Missing: ${missing.join(', ')}` };

  // Test Twilio connection
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    status.checks.twilio = { ok: true, message: `Connected — ${account.friendlyName}` };
  } catch (e) {
    status.checks.twilio = { ok: false, message: e.message };
  }

  // Test Cal.com connection
  try {
    const calRes = await fetch(
      `https://api.cal.com/v2/event-types/${process.env.CALCOM_EVENT_TYPE_ID}`,
      { headers: { Authorization: `Bearer ${process.env.CALCOM_API_KEY}`, 'cal-api-version': '2024-08-13' } }
    );
    if (calRes.ok) {
      const calData = await calRes.json();
      status.checks.calcom = { ok: true, message: `Connected — Event: ${calData?.data?.title || 'found'}` };
    } else {
      // Try v1 fallback
      const v1Res = await fetch(`https://api.cal.com/v1/event-types/${process.env.CALCOM_EVENT_TYPE_ID}?apiKey=${process.env.CALCOM_API_KEY}`);
      if (v1Res.ok) {
        status.checks.calcom = { ok: true, message: 'Connected via v1 API' };
      } else {
        status.checks.calcom = { ok: false, message: `HTTP ${calRes.status} — check API key and event type ID` };
      }
    }
  } catch (e) {
    status.checks.calcom = { ok: false, message: e.message };
  }

  // Check Vercel KV
  if (process.env.KV_REST_API_URL) {
    try {
      const kvRes = await fetch(`${process.env.KV_REST_API_URL}/ping`, {
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
      });
      status.checks.kv = { ok: kvRes.ok, message: kvRes.ok ? 'Connected' : 'Failed to connect' };
    } catch (e) {
      status.checks.kv = { ok: false, message: e.message };
    }
  } else {
    status.checks.kv = { ok: false, message: 'Not configured (optional — dashboard will show demo data)' };
  }

  const allOk = Object.values(status.checks).every(c => c.ok);
  status.overall = allOk ? 'READY' : 'ISSUES_FOUND';

  res.status(allOk ? 200 : 503).json(status);
};
