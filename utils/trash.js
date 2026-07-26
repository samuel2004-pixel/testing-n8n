// ---------------------------------------------------------------------
// Whenever an entry is permanently deleted elsewhere in the app
// (transactions, third-party payments, loans, clients, courier
// shipments), we keep a lightweight audit trail here so admins can see
// what was removed, when, and export that list — without turning every
// delete into a "soft delete" that the rest of the app would then have
// to remember to filter out everywhere.
// ---------------------------------------------------------------------
const db = require("../db");
const { uid, nowISO } = require("./helpers");

// entryType: 'transaction' | 'third_party_payment' | 'loan' | 'client' | 'courier'
// row: the full DB row being deleted (used to build a snapshot + summary)
// summary: short human-readable description for the trash list
async function logDeletion({ entryType, entryId, summary, amount, entryDate, data }) {
  try {
    await db.prepare(`
      INSERT INTO deleted_entries (id, entry_type, entry_id, summary, amount, entry_date, data, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uid(),
      entryType,
      entryId,
      summary || "",
      amount === undefined || amount === null || isNaN(amount) ? null : Number(amount),
      entryDate || null,
      data ? JSON.stringify(data) : null,
      nowISO()
    );
  } catch (err) {
    // Never let trash-logging break the actual delete operation.
    console.error("⚠️ Failed to log deleted entry (delete still proceeds):", err.message);
  }
}

module.exports = { logDeletion };
