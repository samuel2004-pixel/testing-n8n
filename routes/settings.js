const express = require("express");
const router = express.Router();
const db = require("../db");
const { runDailyReminderSweep } = require("../scheduler");

router.get("/api/settings", async (req, res) => {
  const rows = await db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  rows.forEach((r) => (out[r.key] = r.value));
  res.json(out);
});

router.put("/api/settings", async (req, res) => {
  const { currency } = req.body;
  if (currency !== undefined) {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('currency', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(currency);
  }
  res.json({ ok: true });
});

// Run the overdue-reminder sweep right now (instead of waiting for the daily cron)
router.post("/api/reminders/run-now", async (req, res) => {
  const results = await runDailyReminderSweep();
  res.json({ ran: results.length, results });
});

router.get("/api/reminders/log", async (req, res) => {
  const rows = await db.prepare(`
    SELECT r.*, c.name as client_name FROM reminders_log r
    JOIN Missionary c ON c.id = r.client_id
    ORDER BY r.sent_at DESC LIMIT 100
  `).all();
  res.json(rows);
});

router.get("/api/backup", async (req, res) => {
  const Missionary = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary').all();
  const transactions = await db.prepare("SELECT * FROM transactions").all();
  const loans = await db.prepare("SELECT * FROM loans").all();
  const loan_payments = await db.prepare("SELECT * FROM loan_payments").all();
  res.json({ exportedAt: new Date().toISOString(), Missionary, transactions, loans, loan_payments });
});

router.get("/api/twilio-status", (req, res) => {
  const configured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
  res.json({ configured });
});

module.exports = router;
