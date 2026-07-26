const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, makeToken, nowISO, normalizePhone } = require("../utils/helpers");
const { logDeletion } = require("../utils/trash");

// ✅ UPDATED: Now includes yearly contributions in the balance calculation
async function clientBalance(clientId) {
  // Temporarily removed the yearly_contributions query to prevent crashes
  const row = await db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS received,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS spent
    FROM transactions WHERE client_id = ?
  `).get(clientId);
  
  return { 
    received: row.received, 
    spent: row.spent, 
    balance: row.received - row.spent 
  };
}

router.get("/api/Missionary", async (req, res) => {
  const Missionary = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary ORDER BY LOWER(name)').all();

  // One aggregate query for everyone instead of one query per member —
  // the old Promise.all(...map(clientBalance)) fired N simultaneous
  // connection checkouts, which could exceed Render's connection limit
  // as the member list grew and made the page intermittently fail to load.
  const balanceRows = await db.prepare(`
    SELECT client_id,
      COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS received,
      COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS spent
    FROM transactions
    WHERE client_id IS NOT NULL
    GROUP BY client_id
  `).all();

  const byClient = {};
  balanceRows.forEach((r) => { byClient[r.client_id] = r; });

  const withBalances = Missionary.map((c) => {
    const b = byClient[c.id] || { received: 0, spent: 0 };
    const received = Number(b.received);
    const spent = Number(b.spent);
    return { ...c, received, spent, balance: received - spent };
  });

  res.json(withBalances);
});

router.get("/api/Missionary/next-id", async (req, res) => {
  res.json({ member_id: await db.generateMemberId() });
});

router.get("/api/Missionary/:id", async (req, res) => {
  const c = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  const loans = await db.prepare("SELECT * FROM loans WHERE client_id = ? ORDER BY due_date").all(c.id);
  const transactions = await db.prepare("SELECT * FROM transactions WHERE client_id = ? ORDER BY date DESC, created_at DESC").all(c.id);
  res.json({ ...c, ...(await clientBalance(c.id)), loans, transactions });
});

router.post("/api/Missionary", async (req, res) => {
  const { name, phone, company, email, YWAM, notes, photo } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name_required" });

  let memberId = (req.body.member_id || "").toString().trim();
  if (!memberId) memberId = await db.generateMemberId();

  const id = uid();
  const token = makeToken();
  try {
    await db.prepare(`
      INSERT INTO Missionary (id, member_id, name, phone, company, email, YWAM, notes, photo, portal_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, memberId, name.trim(), normalizePhone(phone), company || "", email || "", YWAM || "", notes || "", photo || null, token, nowISO());
  } catch (err) {
    if (String(err.message).includes("duplicate key") || String(err.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "duplicate_client_id", message: `MUT ID "${memberId}" is already in use — pick a different one.` });
    }
    throw err;
  }

  res.json(await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(id));
});

router.put("/api/Missionary/:id", async (req, res) => {
  const c = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });
  const { name, phone, company, email, YWAM, notes, photo } = req.body;

  let memberId = c.member_id;
  if (req.body.member_id !== undefined) {
    const trimmed = String(req.body.member_id).trim();
    if (trimmed) memberId = trimmed; // ignore blank submissions instead of wiping the ID
  }

  try {
    await db.prepare(`
      UPDATE Missionary SET member_id=?, name=?, phone=?, company=?, email=?, YWAM=?, notes=?, photo=?
      WHERE id=?
    `).run(
      memberId,
      name ?? c.name,
      phone !== undefined ? normalizePhone(phone) : c.phone,
      company ?? c.company,
      email ?? c.email,
      YWAM ?? c.YWAM,
      notes ?? c.notes,
      photo !== undefined ? photo : c.photo,
      req.params.id
    );
  } catch (err) {
    if (String(err.message).includes("duplicate key") || String(err.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "duplicate_client_id", message: `MUT ID "${memberId}" is already in use — pick a different one.` });
    }
    throw err;
  }

  res.json(await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(req.params.id));
});

router.delete("/api/Missionary/:id", async (req, res) => {
  const client = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: "not_found" });

  await logDeletion({
    entryType: "client",
    entryId: client.id,
    summary: `${client.name}${client.member_id ? " (" + client.member_id + ")" : ""}`,
    amount: client.remaining_amount,
    entryDate: null,
    data: client,
  });

  // Wrapped in a transaction: these 4 deletes must all happen together or
  // not at all. Without this, a dropped connection or error partway through
  // could leave orphaned transactions/loans pointing at a deleted member,
  // or a member whose loans/transactions never got cleaned up.
  const deleteClient = db.transaction(async () => {
    await db.prepare("DELETE FROM loan_payments WHERE loan_id IN (SELECT id FROM loans WHERE client_id = ?)").run(req.params.id);
    await db.prepare("DELETE FROM loans WHERE client_id = ?").run(req.params.id);
    await db.prepare("DELETE FROM transactions WHERE client_id = ?").run(req.params.id);
    await db.prepare("DELETE FROM Missionary WHERE id = ?").run(req.params.id);
  });

  try {
    await deleteClient();
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting member:", err);
    res.status(500).json({ error: "Failed to delete member" });
  }
});

// Regenerate a client's portal link (invalidates the old one)
router.post("/api/Missionary/:id/regenerate-link", async (req, res) => {
  const token = makeToken();
  await db.prepare("UPDATE Missionary SET portal_token = ? WHERE id = ?").run(token, req.params.id);
  res.json({ portal_token: token });
});

// Withdraw savings — a member pulling out (part of) what THEY have saved,
// e.g. for an emergency. This is not a loan and adds no extra money: it's
// recorded as an expense transaction against the client, same mechanism the
// balance calc already uses, and is capped at what they currently have
// saved so nobody can withdraw more than they put in.
router.post("/api/Missionary/:id/withdraw", async (req, res) => {
  const c = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: "not_found" });

  const amount = parseFloat(req.body.amount);
  const date = req.body.date || nowISO().slice(0, 10);
  const note = (req.body.note || "").trim();

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "invalid_amount", message: "Enter a valid withdrawal amount." });
  }

  const { balance } = await clientBalance(c.id);
  if (amount > balance) {
    return res.status(400).json({
      error: "exceeds_savings",
      message: `${c.name} has only ${balance.toFixed(2)} saved — can't withdraw more than that.`,
    });
  }

  const id = uid();
  await db.prepare(`
    INSERT INTO transactions (id, type, amount, category, client_id, description, date, created_at)
    VALUES (?, 'expense', ?, 'Savings Withdrawal', ?, ?, ?, ?)
  `).run(id, amount, c.id, note || "Savings withdrawal", date, nowISO());

  res.json({ ok: true, transaction: await db.prepare("SELECT * FROM transactions WHERE id = ?").get(id), ...(await clientBalance(c.id)) });
});

module.exports = router;