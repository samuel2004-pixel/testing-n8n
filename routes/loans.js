const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, nowISO } = require("../utils/helpers");
const { logDeletion } = require("../utils/trash");

// GET all loans
router.get("/api/loans", async (req, res) => {
  try {
    const { status, clientId } = req.query;
    let sql = `SELECT l.*, c.name as client_name, c.phone as client_phone,
      COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) as paid
      FROM loans l JOIN Missionary c ON c.id = l.client_id WHERE 1=1`;
    const params = [];

    if (clientId) {
      sql += " AND l.client_id = ?";
      params.push(clientId);
    }
    sql += " ORDER BY l.due_date ASC";

    let loans = (await db.prepare(sql).all(...params)).map(r => ({ ...r, outstanding: r.amount - r.paid }));

    if (status === "overdue") {
      const today = new Date().toISOString().slice(0, 10);
      loans = loans.filter((l) => l.status !== "paid" && l.due_date < today);
    } else if (status === "pending") {
      loans = loans.filter((l) => l.status !== "paid");
    }

    res.json(loans);
  } catch (err) {
    console.error("❌ Error fetching loans:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET single loan
router.get("/api/loans/:id", async (req, res) => {
  try {
    const loan = await db.prepare(`
      SELECT l.*, c.name as client_name, c.phone as client_phone 
      FROM loans l JOIN Missionary c ON c.id = l.client_id 
      WHERE l.id = ?
    `).get(req.params.id);

    if (!loan) return res.status(404).json({ error: "not_found" });

    const payments = await db.prepare(`
      SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY date DESC, created_at DESC
    `).all(loan.id);

    const paidRow = await db.prepare("SELECT COALESCE(SUM(amount),0) as p FROM loan_payments WHERE loan_id = ?").get(loan.id);
    const paid = paidRow.p;

    res.json({ ...loan, paid, outstanding: loan.amount - paid, payments });
  } catch (err) {
    console.error("❌ Error fetching loan:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST create new loan
router.post("/api/loans", async (req, res) => {
  console.log("🔥 INCOMING LOAN DATA:", req.body); // <-- This will show us exactly what the frontend is sending

  const { clientId, amount, dateGiven, dueDate, description } = req.body;

  if (!clientId || !amount || !dateGiven || !dueDate) {
    console.error("❌ Missing loan fields!");
    return res.status(400).json({ error: "missing_fields" });
  }

  // 🔥 SAFETY CHECK: Verify client exists before inserting to prevent FOREIGN KEY crash
  const client = await db.prepare("SELECT id, name FROM Missionary WHERE id = ?").get(clientId);
  if (!client) {
    console.error("❌ FOREIGN KEY ERROR: MUT ID not found in database:", clientId);
    return res.status(400).json({
      error: "invalid_client",
      message: "The selected client does not exist. Please refresh the page and try again."
    });
  }

  const id = uid();
  const given = dateGiven || new Date().toISOString().slice(0, 10);
  const txId = uid();
  const ts = nowISO();

  try {
    const dbTransact = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO loans (id, client_id, amount, date_given, due_date, description, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(id, clientId, parseFloat(amount), given, dueDate, description || "", ts);

      await db.prepare(`
        INSERT INTO transactions (id, type, amount, category, client_id, description, date, loan_id, created_at)
        VALUES (?, 'expense', ?, 'Lend', ?, ?, ?, ?, ?)
      `).run(txId, parseFloat(amount), clientId, description || `Lent to ${client.name}`, given, id, ts);
    });

    await dbTransact();

    console.log("✅ Loan saved successfully for:", client.name);

    const paidRow = await db.prepare("SELECT COALESCE(SUM(amount),0) as p FROM loan_payments WHERE loan_id = ?").get(id);
    const paid = paidRow.p;
    res.json({ id, client_id: clientId, amount: parseFloat(amount), date_given: given, due_date: dueDate, description: description || "", status: "pending", paid, outstanding: parseFloat(amount) });
  } catch (err) {
    console.error("❌ DB ERROR creating loan:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Shared logic for recording a loan repayment, used by both the admin
// "record payment" route below and the client self-service portal.
async function applyPayment(loan, amt, date, note, source) {
  const paymentId = uid();
  const txId = uid();
  const ts = nowISO();
  const client = await db.prepare("SELECT * FROM Missionary WHERE id = ?").get(loan.client_id);

  const dbTransact = db.transaction(async () => {
    await db.prepare(`
      INSERT INTO loan_payments (id, loan_id, amount, date, note, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(paymentId, loan.id, amt, date, note || "", source || "admin", ts);

    await db.prepare(`
      INSERT INTO transactions (id, type, amount, category, client_id, description, date, loan_id, created_at)
      VALUES (?, 'income', ?, 'Loan Repayment', ?, ?, ?, ?, ?)
    `).run(txId, amt, loan.client_id, note || `Repayment from ${client.name}`, date, loan.id, ts);

    const totalPaidRow = await db.prepare("SELECT COALESCE(SUM(amount),0) as p FROM loan_payments WHERE loan_id = ?").get(loan.id);
    const totalPaid = totalPaidRow.p;
    const status = totalPaid >= loan.amount ? "paid" : (totalPaid > 0 ? "partially_paid" : "pending");
    await db.prepare("UPDATE loans SET status = ? WHERE id = ?").run(status, loan.id);

    await db.prepare(`
      UPDATE Missionary 
      SET total_paid = total_paid + ?, 
          remaining_amount = remaining_amount - ? 
      WHERE id = ?
    `).run(amt, amt, loan.client_id);
  });

  await dbTransact();
}

// POST record loan payment (Matches frontend: /api/loans/:id/payments)
router.post("/api/loans/:id/payments", async (req, res) => {
  console.log("🔥 INCOMING LOAN PAYMENT:", req.params.id, req.body);

  const loanId = req.params.id;
  const { amount, date, note } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }

  const loan = await db.prepare("SELECT * FROM loans WHERE id = ?").get(loanId);
  if (!loan) return res.status(404).json({ error: "not_found" });

  try {
    await applyPayment(loan, amt, date || new Date().toISOString().slice(0, 10), note, "admin");
    console.log("✅ Loan payment recorded successfully!");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error processing loan payment:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a loan entirely — removes the loan, its repayment history, and the
// transactions it created (the original "Lend" expense plus any "Loan
// Repayment" income entries), then undoes the total_paid/remaining_amount
// bump those repayments made on the client record. Balance figures shown
// elsewhere are derived from transactions directly, so deleting those rows
// is enough to make the loan disappear from balances everywhere else too.
router.delete("/api/loans/:id", async (req, res) => {
  const loanId = req.params.id;

  try {
    const loan = await db.prepare("SELECT * FROM loans WHERE id = ?").get(loanId);
    if (!loan) return res.status(404).json({ error: "not_found" });

    const paidRow = await db.prepare(
      "SELECT COALESCE(SUM(amount),0) as p FROM loan_payments WHERE loan_id = ?"
    ).get(loanId);
    const paid = paidRow.p;

    const client = await db.prepare("SELECT name FROM Missionary WHERE id = ?").get(loan.client_id);
    await logDeletion({
      entryType: "loan",
      entryId: loan.id,
      summary: `Loan to ${client ? client.name : "Unknown client"}${loan.description ? ": " + loan.description : ""}`,
      amount: loan.amount,
      entryDate: loan.date_given,
      data: { ...loan, paid },
    });

    const dbTransact = db.transaction(async () => {
      await db.prepare("DELETE FROM transactions WHERE loan_id = ?").run(loanId);
      await db.prepare("DELETE FROM loan_payments WHERE loan_id = ?").run(loanId);
      await db.prepare("DELETE FROM loans WHERE id = ?").run(loanId);

      if (paid > 0) {
        await db.prepare(`
          UPDATE Missionary
          SET total_paid = total_paid - ?,
              remaining_amount = remaining_amount + ?
          WHERE id = ?
        `).run(paid, paid, loan.client_id);
      }
    });

    await dbTransact();

    console.log("🗑️ Loan deleted:", loanId);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting loan:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.applyPayment = applyPayment;
