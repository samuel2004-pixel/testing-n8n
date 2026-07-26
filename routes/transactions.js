const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, nowISO } = require("../utils/helpers");
const { logDeletion } = require("../utils/trash");

// GET all transactions
router.get("/api/transactions", async (req, res) => {
  const { clientId, type, q } = req.query;
  let sql = "SELECT t.*, m.name as client_name FROM transactions t LEFT JOIN Missionary m ON t.client_id = m.id WHERE 1=1";
  const params = [];
  if (clientId) { sql += " AND t.client_id = ?"; params.push(clientId); }
  if (type && type !== "all") { sql += " AND t.type = ?"; params.push(type); }
  if (q) { sql += " AND (t.description ILIKE ? OR t.category ILIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  sql += " ORDER BY t.date DESC, t.created_at DESC";

  try {
    res.json(await db.prepare(sql).all(...params));
  } catch (err) {
    console.error("❌ Error fetching transactions:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST new transaction
router.post("/api/transactions", async (req, res) => {
  console.log(" INCOMING TRANSACTION:", req.body);

  const { type, amount, category, clientId, description, date } = req.body;

  if (!type || !["income", "expense"].includes(type)) {
    return res.status(400).json({ error: "invalid_type" });
  }

  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }

  if (!date) {
    return res.status(400).json({ error: "date_required" });
  }

  // Safety check: Validate clientId exists before inserting
  if (clientId) {
    const client = await db.prepare("SELECT id FROM Missionary WHERE id = ?").get(clientId);
    if (!client) {
      console.error("❌ FOREIGN KEY ERROR: MUT ID not found:", clientId);
      return res.status(400).json({
        error: "invalid_client",
        message: "Selected client does not exist. Please refresh the page."
      });
    }
  }

  const id = uid();
  try {
    await db.prepare(`
      INSERT INTO transactions (id, type, amount, category, client_id, description, date, loan_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(id, type, amt, category || "", clientId || null, description || "", date, nowISO());

    console.log("✅ Transaction saved!");
    res.json(await db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
  } catch (err) {
    console.error("❌ DB ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE transaction
router.delete("/api/transactions/:id", async (req, res) => {
  const t = await db.prepare("SELECT * FROM transactions WHERE id = ?").get(req.params.id);
  if (!t) {
    return res.status(404).json({ error: "not_found" });
  }

  if (t.loan_id) {
    return res.status(400).json({
      error: "linked_to_loan",
      message: "This entry came from a loan — edit it from the Loans tab instead."
    });
  }

  try {
    await logDeletion({
      entryType: "transaction",
      entryId: t.id,
      summary: `${t.type === "income" ? "Income" : "Expense"} — ${t.category || "Uncategorized"}${t.description ? ": " + t.description : ""}`,
      amount: t.amount,
      entryDate: t.date,
      data: t,
    });
    await db.prepare("DELETE FROM entry_images WHERE entry_type = 'transaction' AND entry_id = ?").run(req.params.id);
    await db.prepare("DELETE FROM transactions WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting transaction:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// Third-Party Payments
// A dedicated, filterable view of expense entries paid out to someone who
// isn't a Missionary/client on file (e.g. a vendor, courier, or supplier).
// These are ordinary 'expense' transactions (category fixed to
// 'Third Party Payment', client_id always NULL) so they're already picked
// up by every income-minus-expense calculation elsewhere in the app —
// this just gives them their own view, form, and CSV export.
// ==========================================
const THIRD_PARTY_CATEGORY = "Third Party Payment";

router.get("/api/third-party-payments", async (req, res) => {
  try {
    const list = await db.prepare(`
      SELECT * FROM transactions
      WHERE type = 'expense' AND category = ?
      ORDER BY date DESC, created_at DESC
    `).all(THIRD_PARTY_CATEGORY);

    const totalPaidRow = await db.prepare(`
      SELECT COALESCE(SUM(amount),0) AS total FROM transactions
      WHERE type = 'expense' AND category = ?
    `).get(THIRD_PARTY_CATEGORY);

    const totalIncomeRow = await db.prepare(`
      SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type = 'income'
    `).get();

    const totalPaid = Number(totalPaidRow.total);
    const totalIncome = Number(totalIncomeRow.total);

    res.json({
      payments: list,
      totalPaid,
      totalIncome,
      netAfterThirdParty: totalIncome - totalPaid,
    });
  } catch (err) {
    console.error("❌ Error fetching third-party payments:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/third-party-payments", async (req, res) => {
  const { payee, amount, description, date } = req.body;

  if (!payee || !String(payee).trim()) {
    return res.status(400).json({ error: "payee_required" });
  }

  const amt = parseFloat(amount);
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }

  if (!date) {
    return res.status(400).json({ error: "date_required" });
  }

  const id = uid();
  try {
    await db.prepare(`
      INSERT INTO transactions (id, type, amount, category, client_id, description, date, payee, loan_id, created_at)
      VALUES (?, 'expense', ?, ?, NULL, ?, ?, ?, NULL, ?)
    `).run(id, amt, THIRD_PARTY_CATEGORY, description || "", date, String(payee).trim(), nowISO());

    res.json(await db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
  } catch (err) {
    console.error("❌ Error saving third-party payment:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/third-party-payments/:id", async (req, res) => {
  const t = await db.prepare(
    "SELECT * FROM transactions WHERE id = ? AND category = ?"
  ).get(req.params.id, THIRD_PARTY_CATEGORY);
  if (!t) return res.status(404).json({ error: "not_found" });

  try {
    await logDeletion({
      entryType: "third_party_payment",
      entryId: t.id,
      summary: `Paid to ${t.payee || "Unknown"}${t.description ? ": " + t.description : ""}`,
      amount: t.amount,
      entryDate: t.date,
      data: t,
    });
    await db.prepare("DELETE FROM transactions WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting third-party payment:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
