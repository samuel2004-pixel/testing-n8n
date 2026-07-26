const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

function uid() {
  return uuidv4();
}

function makeToken() {
  return crypto.randomBytes(20).toString("hex");
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

// Normalize a phone number to E.164-ish format for Twilio.
// If it already starts with '+', leave it. Otherwise, prefix with the
// configured default country code (defaults to India, +91).
function normalizePhone(raw) {
  if (!raw) return "";
  let p = String(raw).trim().replace(/[\s\-()]/g, "");
  if (p.startsWith("+")) return p;
  const cc = process.env.DEFAULT_COUNTRY_CODE || "+91";
  // strip leading zeros
  p = p.replace(/^0+/, "");
  return cc + p;
}

module.exports = { uid, makeToken, todayISO, nowISO, normalizePhone };
