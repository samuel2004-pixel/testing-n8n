const express = require("express");
const axios = require("axios");
const router = express.Router();
const db = require("../db");
const { applyPayment } = require("./loans");
const { normalizePhone } = require("../utils/helpers");
 
// ---------------------------------------------------------------------
// Impact/MUT medical-assistance form -> Google Form integration
// ---------------------------------------------------------------------
// Clients fill this out from their personal portal. We save it to our own
// database first, then mirror it into the linked Google Form so it shows
// up in the existing Google Sheet workflow. The Google Form submission is
// best-effort only: it never redirects the client anywhere, and if it
// fails we just log it — the request still succeeds as long as our own
// database save worked.
const GOOGLE_FORM_ACTION_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSfHcwOLtVZXcfU3gr04LDKvqSW5BpTKXHdLeSC08Jb4EKuBiQ/formResponse";
 
// Maps our own field names to the Google Form's entry IDs.
const GOOGLE_FORM_ENTRY_MAP = {
  name: "entry.1253983652",
  fatherHusbandName: "entry.1601109641",
  age: "entry.1774233183",
  gender: "entry.660793933",
  maritalStatus: "entry.529936337",
  occupation: "entry.1917813948",
  dob: "entry.1453818161",
  mutId: "entry.344728882",
  hospitalNumber: "entry.451713082",
  currentAddress: "entry.575700889",
  aadhaarAddress: "entry.277823321",
  aadhaarNumber: "entry.767881970",
  appointmentDate: "entry.1966240218",
  personalContact: "entry.3045543",
  personalEmail: "entry.814214125",
  officeContact: "entry.725810940",
  illnessNature: "entry.1051978865",
};
 
// POSTs the mapped fields to the Google Form's /formResponse endpoint.
// Throws on failure so the caller can decide how to handle/log it — this
// function itself never touches the response the client eventually gets.
async function submitToGoogleForm(fields) {
  const params = new URLSearchParams();
  for (const [key, entryId] of Object.entries(GOOGLE_FORM_ENTRY_MAP)) {
    const value = fields[key];
    params.append(entryId, value === undefined || value === null ? "" : String(value));
  }
  await axios.post(GOOGLE_FORM_ACTION_URL, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}
 
async function findClientByToken(token) {
  return db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE portal_token = ?').get(token);
}
 
async function loanWithOutstanding(loan) {
  const paidRow = await db.prepare("SELECT COALESCE(SUM(amount),0) as p FROM loan_payments WHERE loan_id = ?").get(loan.id);
  const paid = paidRow.p;
  return { ...loan, paid, outstanding: loan.amount - paid };
}
 
router.get("/api/portal/:token", async (req, res) => {
  const client = await findClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: "invalid_link" });
 
  const rawLoans = await db.prepare("SELECT * FROM loans WHERE client_id = ? ORDER BY due_date").all(client.id);
  const loans = await Promise.all(rawLoans.map(loanWithOutstanding));
  const balanceRow = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS received,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS spent
    FROM transactions WHERE client_id = ?
  `).get(client.id);
 
  const currencyRow = await db.prepare("SELECT value FROM settings WHERE key = 'currency'").get();
  const currency = currencyRow?.value || "₹";
 
  res.json({
    member_id: client.member_id,
    name: client.name,
    company: client.company,
    phone: client.phone,
    email: client.email,
    YWAM: client.YWAM,
    photo: client.photo,
    currency,
    balance: balanceRow.received - balanceRow.spent,
    received: balanceRow.received,
    spent: balanceRow.spent,
    loans,
  });
});
 
// Client edits/fills their own profile details through their portal link.
// Deliberately does NOT allow editing the internal "notes" field — that's
// for the lender's own private notes about the client.
router.put("/api/portal/:token/profile", async (req, res) => {
  const client = await findClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: "invalid_link" });
 
  const { name, phone, email, company, YWAM, photo } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });
 
  await db.prepare(`
    UPDATE Missionary SET name=?, phone=?, email=?, company=?, YWAM=?, photo=?
    WHERE id=?
  `).run(
    String(name).trim(),
    phone !== undefined ? normalizePhone(phone) : client.phone,
    email !== undefined ? email : client.email,
    company !== undefined ? company : client.company,
    YWAM !== undefined ? YWAM : client.YWAM,
    photo !== undefined ? photo : client.photo,
    client.id
  );
 
  const updated = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(client.id);
  res.json({
    ok: true,
    member_id: updated.member_id,
    name: updated.name,
    company: updated.company,
    phone: updated.phone,
    email: updated.email,
    YWAM: updated.YWAM,
    photo: updated.photo,
  });
});
 
router.post("/api/portal/:token/pay", async (req, res) => {
  const client = await findClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: "invalid_link" });
 
  const { loanId, amount, note } = req.body;
  const loan = await db.prepare("SELECT * FROM loans WHERE id = ? AND client_id = ?").get(loanId, client.id);
  if (!loan) return res.status(400).json({ error: "invalid_loan" });
 
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "invalid_amount" });
  if (loan.status === "paid") return res.status(400).json({ error: "already_paid" });
 
  const today = new Date().toISOString().slice(0, 10);
  await applyPayment(loan, amt, today, note || "Paid via client portal", "portal");
 
  const updatedLoan = await db.prepare("SELECT * FROM loans WHERE id = ?").get(loan.id);
  res.json({ ok: true, loan: await loanWithOutstanding(updatedLoan) });
});
// Yearly Contribution Report for Client Portal
router.get("/api/portal/:token/yearly-contributions", async (req, res) => {
 
  const client = await findClientByToken(req.params.token);
 
  if (!client) {
    return res.status(404).json({ error: "invalid_link" });
  }
 
  const year = parseInt(req.query.year) || new Date().getFullYear();
 
  const rows = await db.prepare(`
    SELECT
      CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
      SUM(amount) AS total
    FROM transactions
    WHERE
      client_id = ?
      AND type = 'income'
      AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
    GROUP BY month
    ORDER BY month
  `).all(client.id, String(year));
 
  // Same-month expense netting as the admin Yearly Contribution report — an
  // expense recorded for this client cancels out that month's income by
  // the same amount, on both sides (admin and this portal).
  const expenseRows = await db.prepare(`
    SELECT
      CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
      SUM(amount) AS total
    FROM transactions
    WHERE
      client_id = ?
      AND type = 'expense'
      AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
    GROUP BY month
    ORDER BY month
  `).all(client.id, String(year));
 
  const monthly = {};
  const expenseByMonth = {};
 
  for (let i = 1; i <= 12; i++) {
    monthly[i] = 0;
    expenseByMonth[i] = 0;
  }
 
  rows.forEach(r => {
    monthly[r.month] = Number(r.total);
  });
  expenseRows.forEach(r => {
    expenseByMonth[r.month] = Number(r.total);
  });
 
  for (let i = 1; i <= 12; i++) {
    monthly[i] = monthly[i] - expenseByMonth[i];
  }
 
  const totalPaid = Object.values(monthly)
    .reduce((a, b) => a + Number(b), 0);
 
  const yearlyTarget = 1200;
  const pending = Math.max(0, yearlyTarget - totalPaid);
 
  res.json({
    year,
    member_id: client.member_id,
    name: client.name,
    monthly,
    totalPaid,
    yearlyTarget,
    pending,
    status:
      totalPaid >= yearlyTarget
        ? "Completed"
        : totalPaid > 0
        ? "Partial"
        : "Not Started"
  });
 
});
// Client submits the Impact/MUT medical-assistance form from their portal.
// Forwards it straight to the linked Google Form — nothing is saved in our
// own database. Never redirects the client. If the Google Form submission
// fails, the error is only logged; the response still reports success.
router.post("/api/portal/:token/mut-form", async (req, res) => {
  const client = await findClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: "invalid_link" });
 
  const {
    name,
    fatherHusbandName,
    age,
    gender,
    maritalStatus,
    occupation,
    dob,
    mutId,
    hospitalNumber,
    currentAddress,
    aadhaarAddress,
    aadhaarNumber,
    appointmentDate,
    personalContact,
    personalEmail,
    officeContact,
    illnessNature,
  } = req.body;
 
  const fields = {
    name: name || client.name || "",
    fatherHusbandName: fatherHusbandName || "",
    age: age || "",
    gender: gender || "",
    maritalStatus: maritalStatus || "",
    occupation: occupation || "",
    dob: dob || "",
    mutId: mutId || client.member_id || "",
    hospitalNumber: hospitalNumber || "",
    currentAddress: currentAddress || "",
    aadhaarAddress: aadhaarAddress || "",
    aadhaarNumber: aadhaarNumber || "",
    appointmentDate: appointmentDate || "",
    personalContact: personalContact || client.phone || "",
    personalEmail: personalEmail || client.email || "",
    officeContact: officeContact || "",
    illnessNature: illnessNature || "",
  };
 
  let googleFormStatus = "ok";
  try {
    await submitToGoogleForm(fields);
  } catch (err) {
    googleFormStatus = "failed";
    console.error("Google Form submission failed:", err.message);
  }
 
  res.json({ ok: true, googleFormStatus });
});
 
module.exports = router;