const twilio = require("twilio");

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

/**
 * Send an SMS. Returns { ok: true, sid } or { ok: false, error }.
 * If Twilio isn't configured, returns { ok: false, error: 'not_configured' } without throwing,
 * so the rest of the app (and the reminder scheduler) keeps working in demo/offline mode.
 */
async function sendSms(toPhone, body) {
  const client = getClient();
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!client || !from) {
    return { ok: false, error: "not_configured" };
  }
  if (!toPhone) {
    return { ok: false, error: "no_phone" };
  }
  try {
    const msg = await client.messages.create({ to: toPhone, from, body });
    return { ok: true, sid: msg.sid };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { sendSms };
