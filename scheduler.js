const cron = require("node-cron");
const db = require("./db");
const { sendSms } = require("./utils/sms");
const { uid, nowISO } = require("./utils/helpers");

async function buildMessage(loan, client) {
  const currencyRow = await db.prepare("SELECT value FROM settings WHERE key = 'currency'").get();
  const currency = currencyRow?.value || "₹";
  const paidRow = await db.prepare("SELECT COALESCE(SUM(amount),0) as p FROM loan_payments WHERE loan_id = ?").get(loan.id);
  const paid = paidRow.p;
  const outstanding = loan.amount - paid;
  const base = process.env.BASE_URL || "";
  const link = base ? `${base}/portal.html?token=${client.portal_token}` : "";
  let msg = `Hi ${client.name}, a reminder: ${currency}${outstanding.toFixed(2)} was due on ${loan.due_date} and is still pending.`;
  if (link) msg += ` View & pay: ${link}`;
  return msg;
}

// Sends (or re-sends, if force=true) a reminder for a single loan. Used by both
// the daily automatic job and the "send reminder now" button in the admin UI.
async function sendReminderForLoan(loanId, opts = {}) {
  const loan = await db.prepare("SELECT * FROM loans WHERE id = ?").get(loanId);
  if (!loan) return { ok: false, error: "loan_not_found" };
  const client = await db.prepare("SELECT * FROM Missionary WHERE id = ?").get(loan.client_id);
  if (!client) return { ok: false, error: "client_not_found" };
  if (loan.status === "paid") return { ok: false, error: "already_paid" };

  if (!opts.force) {
    // Avoid sending more than one automatic reminder per loan per day.
    const today = new Date().toISOString().slice(0, 10);
    const already = await db.prepare(
      "SELECT id FROM reminders_log WHERE loan_id = ? AND sent_at LIKE ?"
    ).get(loanId, `${today}%`);
    if (already) return { ok: false, error: "already_sent_today" };
  }

  const message = await buildMessage(loan, client);
  const result = await sendSms(client.phone, message);

  await db.prepare(`
    INSERT INTO reminders_log (id, loan_id, client_id, sent_at, message, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uid(), loan.id, client.id, nowISO(), message, result.ok ? "sent" : "failed", result.ok ? null : result.error);

  return result;
}

// Finds every loan that is overdue and not fully paid, and sends a reminder for each.
async function runDailyReminderSweep() {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = await db.prepare(`
    SELECT id FROM loans WHERE status != 'paid' AND due_date < ?
  `).all(today);

  const results = [];
  for (const { id } of overdue) {
    results.push(await sendReminderForLoan(id, { force: false }));
  }
  return results;
}

function startScheduler() {
  const schedule = process.env.REMINDER_CRON || "0 9 * * *"; // default: 9:00 AM server time, daily
  cron.schedule(schedule, () => {
    runDailyReminderSweep().catch((err) => console.error("Reminder sweep failed:", err));
  });
  console.log(`Reminder scheduler started (cron: "${schedule}").`);
}

module.exports = { startScheduler, runDailyReminderSweep, sendReminderForLoan };
