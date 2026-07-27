const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, nowISO } = require("../utils/helpers");
const { sendExport } = require("../utils/exporters");
const { logDeletion } = require("../utils/trash");

// ==========================================
// Courier — tracks Client-to-Third-Party shipments: money a client sent
// that then needs to travel through/to a courier or third party, with
// its own send date, courier date, total amount, and third-party payout.
// ==========================================

router.get("/api/courier", async (req, res) => {
  try {
    const { clientId, q } = req.query;
    let sql = `
      SELECT cs.*, m.name AS client_name
      FROM courier_shipments cs
      LEFT JOIN Missionary m ON m.id = cs.client_id
      WHERE 1=1
    `;
    const params = [];
    if (clientId) { sql += " AND cs.client_id = ?"; params.push(clientId); }
    if (q) {
      sql += " AND (m.name ILIKE ? OR cs.third_party_name ILIKE ? OR cs.description ILIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY cs.send_date DESC, cs.created_at DESC";

    const rows = await db.prepare(sql).all(...params);

    const totals = rows.reduce(
      (acc, r) => {
        acc.totalAmount += Number(r.total_amount) || 0;
        acc.totalPayout += Number(r.third_party_payout) || 0;
        return acc;
      },
      { totalAmount: 0, totalPayout: 0 }
    );

    res.json({
      shipments: rows,
      totalAmount: totals.totalAmount,
      totalPayout: totals.totalPayout,
      netRetained: totals.totalAmount - totals.totalPayout,
    });
  } catch (err) {
    console.error("❌ Error fetching courier shipments:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/courier", async (req, res) => {
  const { clientId, thirdPartyName, sendDate, courierDate, totalAmount, thirdPartyPayout, description } = req.body;

  if (!sendDate) return res.status(400).json({ error: "send_date_required" });
  const total = parseFloat(totalAmount);
  if (isNaN(total) || total < 0) return res.status(400).json({ error: "invalid_total_amount" });
  const payout = parseFloat(thirdPartyPayout) || 0;

  if (clientId) {
    const client = await db.prepare("SELECT id FROM Missionary WHERE id = ?").get(clientId);
    if (!client) return res.status(400).json({ error: "invalid_client", message: "Selected client does not exist." });
  }

  const id = uid();
  try {
    await db.prepare(`
      INSERT INTO courier_shipments
        (id, client_id, third_party_name, send_date, courier_date, total_amount, third_party_payout, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, clientId || null, thirdPartyName || "", sendDate, courierDate || null, total, payout, description || "", nowISO());

    const row = await db.prepare(`
      SELECT cs.*, m.name AS client_name FROM courier_shipments cs
      LEFT JOIN Missionary m ON m.id = cs.client_id WHERE cs.id = ?
    `).get(id);
    res.json(row);
  } catch (err) {
    console.error("❌ Error creating courier shipment:", err);
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/courier/:id", async (req, res) => {
  const { clientId, thirdPartyName, sendDate, courierDate, totalAmount, thirdPartyPayout, description } = req.body;
  const existing = await db.prepare("SELECT * FROM courier_shipments WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not_found" });

  if (!sendDate) return res.status(400).json({ error: "send_date_required" });
  const total = parseFloat(totalAmount);
  if (isNaN(total) || total < 0) return res.status(400).json({ error: "invalid_total_amount" });
  const payout = parseFloat(thirdPartyPayout) || 0;

  try {
    await db.prepare(`
      UPDATE courier_shipments
      SET client_id = ?, third_party_name = ?, send_date = ?, courier_date = ?,
          total_amount = ?, third_party_payout = ?, description = ?
      WHERE id = ?
    `).run(clientId || null, thirdPartyName || "", sendDate, courierDate || null, total, payout, description || "", req.params.id);

    const row = await db.prepare(`
      SELECT cs.*, m.name AS client_name FROM courier_shipments cs
      LEFT JOIN Missionary m ON m.id = cs.client_id WHERE cs.id = ?
    `).get(req.params.id);
    res.json(row);
  } catch (err) {
    console.error("❌ Error updating courier shipment:", err);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/courier/:id", async (req, res) => {
  try {
    const row = await db.prepare(`
      SELECT cs.*, m.name AS client_name FROM courier_shipments cs
      LEFT JOIN Missionary m ON m.id = cs.client_id WHERE cs.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });

    await logDeletion({
      entryType: "courier",
      entryId: row.id,
      summary: `Shipment for ${row.client_name || "Unknown missionary"} → ${row.third_party_name || "Third party"}`,
      amount: row.total_amount,
      entryDate: row.send_date,
      data: row,
    });

    await db.prepare("DELETE FROM entry_images WHERE entry_type = 'courier' AND entry_id = ?").run(req.params.id);
    await db.prepare("DELETE FROM courier_shipments WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error deleting courier shipment:", err);
    res.status(500).json({ error: err.message });
  }
});

// Export: ?format=csv|xlsx|pdf (defaults to csv)
router.get("/api/courier/export", async (req, res) => {
  try {
    const { clientId, q } = req.query;
    let sql = `
      SELECT cs.*, m.name AS client_name
      FROM courier_shipments cs
      LEFT JOIN Missionary m ON m.id = cs.client_id
      WHERE 1=1
    `;
    const params = [];
    if (clientId) { sql += " AND cs.client_id = ?"; params.push(clientId); }
    if (q) {
      sql += " AND (m.name ILIKE ? OR cs.third_party_name ILIKE ? OR cs.description ILIKE ?)";
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY cs.send_date DESC, cs.created_at DESC";

    const rows = await db.prepare(sql).all(...params);

    const columns = [
      { key: "client_name", label: "Missionary", width: 1.3 },
      { key: "third_party_name", label: "Third Party", width: 1.3 },
      { key: "send_date", label: "Bill Received Date", width: 1 },
      { key: "courier_date", label: "Bill sent to MUT", width: 1 },
      { key: "total_amount", label: "Total Amount", align: "right", width: 1 },
      { key: "third_party_payout", label: "Received Payments MUT", align: "right", width: 1 },
      { key: "description", label: "Description", width: 1.8 },
    ];

    const data = rows.map((r) => ({
      ...r,
      client_name: r.client_name || "—",
      total_amount: Number(r.total_amount || 0).toFixed(2),
      third_party_payout: Number(r.third_party_payout || 0).toFixed(2),
    }));

    await sendExport(req, res, {
      title: "Courier Shipments",
      subtitle: "",
      columns,
      rows: data,
      filenameBase: "courier-shipments",
    });
  } catch (err) {
    console.error("❌ Error exporting courier shipments:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
