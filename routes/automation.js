const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, nowISO } = require("../utils/helpers");
 
// ---------------------------------------------------------------------
// Shared-secret auth for external automation tools (e.g. n8n).
// These tools can't hold an admin browser session/cookie, so instead of
// requireAuth (session-based) these routes check a static API key sent as
// the `x-api-key` header. Set AUTOMATION_API_KEY in your environment
// (Railway → Variables) to a long random string, and put that same value
// in the n8n HTTP Request node's header.
// ---------------------------------------------------------------------
function requireApiKey(req, res, next) {
  const configured = process.env.AUTOMATION_API_KEY;
  if (!configured) {
    return res.status(500).json({
      error: "server_not_configured",
      message: "Set AUTOMATION_API_KEY in the environment to use the automation endpoints.",
    });
  }
  const provided = req.get("x-api-key");
  if (!provided || provided !== configured) {
    return res.status(401).json({ error: "invalid_api_key" });
  }
  next();
}
 
function getStatus(netSaved, yearlyTarget) {
  if (netSaved >= yearlyTarget) return "Paid";
  if (netSaved > 0) return "Partial";
  return "Pending";
}
 
// GET /api/automation/unpaid-contributions?year=2026
//
// Returns every member who has NOT yet reached the yearly contribution
// target (default ₹1200, same figure used everywhere else in the app),
// with:
//   - email    : as stored, used for automated email reminders via n8n
//   - pending  : how much is still owed this year
//   - message  : a ready-to-send reminder message
// Members with no email on file are skipped (nothing to send to).
router.get("/api/automation/unpaid-contributions", requireApiKey, async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const yearlyTarget = 1200;
 
    const members = await db.prepare(`
     SELECT id, member_id, name, phone, email, YWAM AS "YWAM", portal_token
FROM Missionary
      ORDER BY LOWER(name)
    `).all();
 
    const incomeRows = await db.prepare(`
      SELECT client_id, SUM(amount) AS total
      FROM transactions
      WHERE type = 'income'
        AND client_id IS NOT NULL
        AND (category IS NULL OR category != 'Registration Fee')
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id
    `).all(String(year));
 
    const expenseRows = await db.prepare(`
      SELECT client_id, SUM(amount) AS total
      FROM transactions
      WHERE type = 'expense'
        AND client_id IS NOT NULL
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id
    `).all(String(year));
 
    const incomeByClient = {};
    incomeRows.forEach((r) => { incomeByClient[r.client_id] = Number(r.total); });
    const expenseByClient = {};
    expenseRows.forEach((r) => { expenseByClient[r.client_id] = Number(r.total); });
 
    const base = (process.env.BASE_URL || "").replace(/\/$/, "");
    const currencyRow = await db.prepare("SELECT value FROM settings WHERE key='currency'").get();
    const currency = currencyRow?.value || "₹";
 
    const unpaid = members
      .map((m) => {
        const income = incomeByClient[m.id] || 0;
        const expense = expenseByClient[m.id] || 0;
        const netSaved = income - expense;
        const pending = Math.max(0, yearlyTarget - netSaved);
        const status = getStatus(netSaved, yearlyTarget);
        const portalLink = base && m.portal_token ? `${base}/portal.html?token=${m.portal_token}` : "";
 
        const message =
          `Dear Missionary ${m.name}, this is a reminder from YWAM TAMIL NADU MUT MEDICAL MEMBERSHIP for your ${year} yearly contribution of ` +
          `${currency}${yearlyTarget} is not yet complete. You've paid ${currency}${netSaved.toFixed(2)} so far ` +
          `and ${currency}${pending.toFixed(2)} is still pending.` +
          (portalLink ? ` View & pay here: ${portalLink}` : "");
 
        return {
          id: m.id,
          member_id: m.member_id,
          name: m.name,
          email: m.email || "",
          YWAM: m.YWAM || "",
          year,
          yearlyTarget,
          netSaved,
          pending,
          status,
          portal_link: portalLink,
          message,
        };
      })
      .filter((m) => m.status !== "Paid" && m.email);
 
    res.json({ year, yearlyTarget, count: unpaid.length, members: unpaid });
  } catch (error) {
    console.error("Error generating unpaid-contributions list:", error);
    res.status(500).json({ error: "failed_to_generate_list" });
  }
});
 
// POST /api/automation/log-reminder
// Optional — call this from n8n right after an email is sent (or fails),
// so it shows up in the same reminders log the SMS scheduler uses.
// Body: { client_id, message, status: 'sent'|'failed', error? }
router.post("/api/automation/log-reminder", requireApiKey, async (req, res) => {
  const { client_id, message, status, error } = req.body || {};
  if (!client_id) return res.status(400).json({ error: "client_id_required" });
 
  await db.prepare(`
    INSERT INTO reminders_log (id, loan_id, client_id, sent_at, message, status, error)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
  `).run(uid(), client_id, nowISO(), message || "", status || "sent", error || null);
 
  res.json({ ok: true });
});
 
module.exports = router;