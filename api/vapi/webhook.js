/**
 * Vapi Webhook — /api/vapi/webhook.js
 * 
 * Handles 3 types of Vapi events:
 * 1. function-call → routes to check_availability, book_appointment, send_emergency_alert
 * 2. end-of-call-report → stores call data for dashboard
 * 3. status-update → logs call lifecycle events
 * 
 * Env vars needed:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *   CALCOM_API_KEY, CALCOM_EVENT_TYPE_ID
 *   OWNER_PHONE_NUMBER, OWNER_NAME, BUSINESS_NAME
 *   VAPI_SECRET (optional but recommended — set in Vapi dashboard + env vars)
 *   TIMEZONE (defaults to America/Chicago)
 */

const twilio = require('twilio');

// ── Init ──
let twilioClient;
try {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} catch (e) {
  console.error('Twilio init failed:', e.message);
}

// ── In-memory call store (Vercel serverless = ephemeral, but we persist to KV if available) ──
// For MVP: calls are stored in Vercel KV. If no KV, falls back to returning empty.
// Upgrade path: Supabase or PlanetScale for persistent storage.

async function storeCall(callData) {
  // Try Vercel KV first
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const key = `call:${callData.id || Date.now()}`;
      await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: JSON.stringify(callData), ex: 2592000 }) // 30 day TTL
      });
      // Add to recent calls list
      await fetch(`${process.env.KV_REST_API_URL}/lpush/recent_calls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: key })
      });
      // Trim list to 200 most recent
      await fetch(`${process.env.KV_REST_API_URL}/ltrim/recent_calls/0/199`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
      });
      return true;
    } catch (e) {
      console.error('KV store error:', e.message);
    }
  }
  // Fallback: just log it. Dashboard will show placeholder data.
  console.log('CALL_DATA:', JSON.stringify(callData));
  return false;
}

// ── SMS Helper ──
async function sendSMS(to, body) {
  if (!twilioClient) return false;
  let normalized = String(to).replace(/\D/g, '');
  if (normalized.length === 10) normalized = '1' + normalized;
  if (!normalized.startsWith('+')) normalized = '+' + normalized;
  try {
    const msg = await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: normalized
    });
    console.log(`SMS sent to ${normalized}: ${msg.sid}`);
    return true;
  } catch (e) {
    console.error(`SMS failed to ${normalized}:`, e.message);
    return false;
  }
}

// ── Cal.com Availability ──
// Cal.com v2 uses /v2/slots/available, but v1 is still supported for most plans.
// We try v2 first, fall back to v1.
async function getAvailability(preferredDate, urgency) {
  const now = new Date();
  const days = urgency === 'emergency' ? 2 : 7;
  const startTime = now.toISOString();
  const endTime = new Date(now.getTime() + days * 86400000).toISOString();

  // Try v2 endpoint first
  let data;
  try {
    const v2Res = await fetch(
      `https://api.cal.com/v2/slots/available?startTime=${startTime}&endTime=${endTime}&eventTypeId=${process.env.CALCOM_EVENT_TYPE_ID}`,
      { headers: { Authorization: `Bearer ${process.env.CALCOM_API_KEY}`, 'cal-api-version': '2024-08-13' } }
    );
    if (v2Res.ok) {
      data = await v2Res.json();
    }
  } catch (e) { /* fall through to v1 */ }

  // Fallback to v1
  if (!data || !data.data) {
    try {
      const v1Res = await fetch(
        `https://api.cal.com/v1/availability?apiKey=${process.env.CALCOM_API_KEY}&eventTypeId=${process.env.CALCOM_EVENT_TYPE_ID}&startTime=${startTime}&endTime=${endTime}`
      );
      data = await v1Res.json();
    } catch (e) {
      console.error('Cal.com availability error:', e.message);
      return { available: false, message: "I'm having trouble checking the calendar right now. Let me have " + process.env.OWNER_NAME + " call you back to schedule." };
    }
  }

  // Parse slots — handle both v1 and v2 response shapes
  const slotsObj = data?.data?.slots || data?.slots || {};
  if (!Object.keys(slotsObj).length) {
    return { available: false, message: "No openings this week. I'll have " + process.env.OWNER_NAME + " call you to find a time." };
  }

  const slots = Object.entries(slotsObj).flatMap(([_, times]) => {
    const arr = Array.isArray(times) ? times : [];
    return arr.map(s => {
      const dt = new Date(s.time || s);
      return {
        display: `${dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
        iso: (s.time || s),
      };
    });
  }).slice(0, 3);

  return { available: true, slots, message: `I've got: ${slots.map(s => s.display).join(', ')}. Which works best?` };
}

// ── Book Appointment ──
async function bookAppointment(params) {
  const tz = process.env.TIMEZONE || 'America/Chicago';
  const timeStr = new Date(params.appointment_time).toLocaleString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: tz
  });

  // Try v2 first
  let result;
  try {
    const v2Res = await fetch('https://api.cal.com/v2/bookings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CALCOM_API_KEY}`,
        'Content-Type': 'application/json',
        'cal-api-version': '2024-08-13'
      },
      body: JSON.stringify({
        eventTypeId: parseInt(process.env.CALCOM_EVENT_TYPE_ID),
        start: params.appointment_time,
        attendee: {
          name: params.caller_name,
          email: `${params.phone.replace(/\D/g, '')}@leads.callcovered.com`,
          phoneNumber: params.phone,
          timeZone: tz
        },
        metadata: {
          source: 'ai-answering-service',
          jobDescription: params.job_description,
          address: params.address || 'TBD',
          urgency: params.urgency || 'normal'
        }
      }),
    });
    if (v2Res.ok) result = await v2Res.json();
  } catch (e) { /* fall through */ }

  // Fallback to v1
  if (!result || (!result.data && !result.id)) {
    try {
      const v1Res = await fetch(`https://api.cal.com/v1/bookings?apiKey=${process.env.CALCOM_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventTypeId: parseInt(process.env.CALCOM_EVENT_TYPE_ID),
          start: params.appointment_time,
          responses: {
            name: params.caller_name,
            email: `${params.phone.replace(/\D/g, '')}@leads.callcovered.com`,
            phone: params.phone,
            notes: `Job: ${params.job_description}\nAddress: ${params.address || 'TBD'}\nUrgency: ${params.urgency || 'normal'}`,
          },
          metadata: { source: 'ai-answering-service' },
        }),
      });
      result = await v1Res.json();
    } catch (e) {
      console.error('Cal.com booking error:', e.message);
      return { success: false, message: "The booking system had a hiccup. I'll have " + process.env.OWNER_NAME + " call you to confirm." };
    }
  }

  const bookingId = result?.data?.id || result?.id;

  if (bookingId) {
    // Fire both SMS in parallel
    const [customerSent, ownerSent] = await Promise.all([
      sendSMS(params.phone,
        `Hi ${params.caller_name}! Your estimate with ${process.env.BUSINESS_NAME} is confirmed for ${timeStr}. Reply to this text if you need to reschedule.`
      ),
      sendSMS(process.env.OWNER_PHONE_NUMBER,
        `📋 NEW BOOKING\n${params.caller_name} — ${params.phone}\n${params.job_description}\n📍 ${params.address || 'N/A'}\n📅 ${timeStr}\n\nBooking #${bookingId}`
      ),
    ]);

    // Store booking event
    await storeCall({
      id: `booking-${bookingId}`,
      type: 'booking',
      caller_name: params.caller_name,
      phone: params.phone,
      job: params.job_description,
      address: params.address,
      time: params.appointment_time,
      sms_customer: customerSent,
      sms_owner: ownerSent,
      created_at: new Date().toISOString()
    });

    let msg = `Booked for ${timeStr}. Confirmation texts sent.`;
    if (!customerSent) msg = `Booked for ${timeStr}. I sent ${process.env.OWNER_NAME} the details — they'll confirm with you directly.`;
    return { success: true, message: msg };
  }

  return { success: false, message: "The booking didn't go through. I'll have " + process.env.OWNER_NAME + " call you back to schedule." };
}

// ── Main Handler ──
module.exports = async function handler(req, res) {
  // CORS for dashboard fetches
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ── Security: Verify Vapi secret to prevent unauthorized access ──
  if (process.env.VAPI_SECRET) {
    const incomingSecret = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'];
    if (incomingSecret !== process.env.VAPI_SECRET) {
      console.warn('Unauthorized webhook attempt from:', req.headers['x-forwarded-for'] || 'unknown');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

 try {
    const { message } = req.body;
    console.log('WEBHOOK_RAW:', JSON.stringify(Object.keys(req.body || {})));

    // ── Custom Tool calls from Vapi ──
    // Tool-specific Server URL receives payload differently than assistant Server URL
    // Check both: req.body.message.toolCallList AND req.body.toolCallList
    const toolCallList = message?.toolCallList || req.body?.toolCallList || 
                         (message?.type === 'tool-calls' && message?.toolCallList) || null;
    
    if (toolCallList && toolCallList.length > 0) {
      const toolCalls = message.toolCallList || [];
      const results = [];

      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        const params = typeof tc.function?.arguments === 'string' 
          ? JSON.parse(tc.function.arguments) 
          : tc.function?.arguments || {};
        let resultMsg = '';

        switch (fnName) {
          case 'check_availability':
            const avail = await getAvailability(params.preferred_date, params.urgency || 'flexible');
            resultMsg = avail.message;
            break;

          case 'book_appointment':
            if (!params.caller_name || !params.phone || !params.appointment_time) {
              resultMsg = "I need a few more details before booking. Could you confirm your name, number, and preferred time?";
            } else {
              const booking = await bookAppointment(params);
              resultMsg = booking.message;
            }
            break;

          case 'send_emergency_alert': {
            const alertSent = await sendSMS(process.env.OWNER_PHONE_NUMBER,
              `🚨 EMERGENCY CALL\n${params.caller_name || 'Caller'} — ${params.phone}\n${params.issue}\n📍 ${params.address || 'No address given'}\n\nCall back ASAP!`
            );
            await storeCall({
              id: `emergency-${Date.now()}`,
              type: 'emergency',
              caller_name: params.caller_name,
              phone: params.phone,
              issue: params.issue,
              address: params.address,
              alert_sent: alertSent,
              created_at: new Date().toISOString()
            });
            resultMsg = `I've sent an urgent alert to ${process.env.OWNER_NAME}. They'll call you right back.`;
            break;
          }

          default:
            resultMsg = `Unknown function: ${fnName}`;
        }

        results.push({ toolCallId: tc.id, result: resultMsg });
      }

      return res.json({ results });
    }

    // ── Legacy function-call format (fallback) ──
    if (message?.type === 'function-call') {
      const fn = message.functionCall;
      if (!fn?.name) return res.status(400).json({ error: 'Missing function name' });

      let result;
      switch (fn.name) {
        case 'check_availability':
          result = await getAvailability(fn.parameters?.preferred_date, fn.parameters?.urgency || 'flexible');
          break;

        case 'book_appointment':
          if (!fn.parameters?.caller_name || !fn.parameters?.phone || !fn.parameters?.appointment_time) {
            result = { success: false, message: "I need a few more details before booking. Could you confirm your name, number, and preferred time?" };
          } else {
            result = await bookAppointment(fn.parameters);
          }
          break;

        case 'send_emergency_alert': {
          const alertSent = await sendSMS(process.env.OWNER_PHONE_NUMBER,
            `🚨 EMERGENCY CALL\n${fn.parameters?.caller_name || 'Caller'} — ${fn.parameters?.phone}\n${fn.parameters?.issue}\n📍 ${fn.parameters?.address || 'No address given'}\n\nCall back ASAP!`
          );
          await storeCall({
            id: `emergency-${Date.now()}`,
            type: 'emergency',
            caller_name: fn.parameters?.caller_name,
            phone: fn.parameters?.phone,
            issue: fn.parameters?.issue,
            address: fn.parameters?.address,
            alert_sent: alertSent,
            created_at: new Date().toISOString()
          });
          result = { success: true, message: `I've sent an urgent alert to ${process.env.OWNER_NAME}. They'll call you right back.` };
          break;
        }

        default:
          result = { error: `Unknown function: ${fn.name}` };
      }

      return res.json({ result });
    }

    // ── End of call report — store for dashboard ──
    if (message?.type === 'end-of-call-report') {
      const report = message;
      
      // Extract caller name from transcript if available
      const transcript = report.transcript || '';
      const summary = report.summary || '';
      
      // Detect if a booking was made during this call
      const wasBooked = summary.toLowerCase().includes('booked') || 
                        summary.toLowerCase().includes('confirmed') || 
                        summary.toLowerCase().includes('scheduled');
      
      // Detect emergency calls
      const wasEmergency = summary.toLowerCase().includes('emergency') || 
                           summary.toLowerCase().includes('urgent');

      const callRecord = {
        id: report.call?.id || `call-${Date.now()}`,
        type: 'call',
        // Fields matching Dashboard.tsx CallLog interface
        customerName: report.call?.customer?.name || 'Unknown Caller',
        phoneNumber: report.call?.customer?.number || 'unknown',
        status: wasEmergency ? 'Emergency' : wasBooked ? 'Booked' : 'Completed',
        jobType: 'Inbound Call',
        estimateBooked: wasBooked,
        // Raw data
        duration: report.durationSeconds || 0,
        summary: summary,
        transcript: transcript,
        recording_url: report.recordingUrl || '',
        ended_reason: report.endedReason || '',
        cost: report.cost || 0,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        created_at: report.call?.createdAt || new Date().toISOString()
      };
      await storeCall(callRecord);
      return res.json({ received: true });
    }

    // ── Status updates (call started, ringing, etc.) ──
    if (message?.type === 'status-update') {
      console.log('Call status:', message.status);
      return res.json({ ok: true });
    }

    // Catch-all
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
