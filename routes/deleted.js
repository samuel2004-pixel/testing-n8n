const express = require("express");
const router = express.Router();
const db = require("../db");
const { sendExport } = require("../utils/exporters");

// ==========================================
// Deleted Entries (trash)
// Every hard-delete elsewhere in the app (transactions, third-party
// payments, loans, clients, courier shipments) writes a row here first
// via utils/trash.js#logDeletion. This just lists/exports that log.
// ==========================================

const TYPE_LABELS = {
  transaction: "Entry (Income/Expense)",
  third_party_payment: "Third-Party Payment",
  loan: "Loan",
  client: "Missionary/Client",
  courier: "Courier Shipment",
};

router.get("/api/deleted-entries", async (req, res) => {
  try {
    const { type, q } = req.query;
    let sql = "SELECT * FROM deleted_entries WHERE 1=1";
    const params = [];
    if (type && type !== "all") {
      sql += " AND entry_type = ?";
      params.push(type);
    }
    if (q) {
      sql += " AND (summary ILIKE ? OR entry_id ILIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY deleted_at DESC";

    const rows = await db.prepare(sql).all(...params);
    res.json(
      rows.map((r) => ({
        ...r,
        entry_type_label: TYPE_LABELS[r.entry_type] || r.entry_type,
      }))
    );
  } catch (err) {
    console.error("❌ Error fetching deleted entries:", err);
    res.status(500).json({ error: err.message });
  }
});

// Permanently clear a single trash row (does NOT restore anything —
// the original record is already gone; this just removes it from the list).
router.delete("/api/deleted-entries/:id", async (req, res) => {
  try {
    await db.prepare("DELETE FROM deleted_entries WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error clearing deleted entry:", err);
    res.status(500).json({ error: err.message });
  }
});

// Export: ?format=csv|xlsx|pdf (defaults to csv)
router.get("/api/deleted-entries/export", async (req, res) => {
  try {
    const { type, q } = req.query;
    let sql = "SELECT * FROM deleted_entries WHERE 1=1";
    const params = [];
    if (type && type !== "all") {
      sql += " AND entry_type = ?";
      params.push(type);
    }
    if (q) {
      sql += " AND (summary ILIKE ? OR entry_id ILIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY deleted_at DESC";

    const rows = await db.prepare(sql).all(...params);

    const columns = [
      { key: "entry_type_label", label: "Type", width: 1.3 },
      { key: "summary", label: "Summary", width: 2.5 },
      { key: "amount", label: "Amount", align: "right", width: 1 },
      { key: "entry_date", label: "Entry Date", width: 1 },
      { key: "deleted_at", label: "Deleted At", width: 1.4 },
    ];

    const data = rows.map((r) => ({
      ...r,
      entry_type_label: TYPE_LABELS[r.entry_type] || r.entry_type,
      amount: r.amount === null || r.amount === undefined ? "" : Number(r.amount).toFixed(2),
    }));

    await sendExport(req, res, {
      title: "Deleted Entries",
      subtitle: type && type !== "all" ? `Filtered by type: ${TYPE_LABELS[type] || type}` : "All types",
      columns,
      rows: data,
      filenameBase: "deleted-entries",
    });
  } catch (err) {
    console.error("❌ Error exporting deleted entries:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
