const express = require("express");
const router = express.Router();
const db = require("../db");
const { uid, nowISO } = require("../utils/helpers");
const { buildPDFBuffer } = require("../utils/exporters");

// Helper to determine contribution status
function getStatus(netSaved, yearlyTarget = 1200) {
  if (netSaved >= yearlyTarget) return "Paid";
  if (netSaved > 0) return "Partial";
  return "Pending";
}

// Helper to calculate remaining pending amount
function getPending(netSaved, yearlyTarget = 1200) {
  return Math.max(0, yearlyTarget - netSaved);
}

// Helper function to parse CSV line (handles quoted fields with commas or semicolons)
function parseCSVLine(line, delimiter = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Excel frequently re-saves CSVs with ';' instead of ',' when the system's
// regional settings use a comma as the decimal separator. Detect whichever
// delimiter actually splits the header into more columns.
function detectDelimiter(headerLine) {
  const commaCount = (headerLine.match(/,/g) || []).length;
  const semicolonCount = (headerLine.match(/;/g) || []).length;
  return semicolonCount > commaCount ? ';' : ',';
}

// ==========================================
// 0. GET: Dashboard summary
// The admin dashboard (public/admin/js/app.js -> renderDashboard) calls
// GET /api/dashboard and expects { income, expense, balance, overdueLoans,
// recent, clientBalances } — this route was missing entirely, so the whole
// dashboard silently failed to load (the fetch throws, the catch just
// returns, leaving every summary card blank/zero).
//
// income/expense/balance are computed across ALL transactions, including
// Third-Party Payments (type='expense', client_id=NULL) and every client's
// own transactions — so a third-party payment reduces this organization-
// wide total, exactly like it should. It intentionally does NOT touch any
// individual client's own balance: clientBalances below is grouped by
// client_id, and third-party rows have client_id=NULL so they never show
// up against any one person's own net total.
// ==========================================
router.get("/api/dashboard", async (req, res) => {
  try {
    const totalsRow = await db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expense
      FROM transactions
    `).get();
    const income = Number(totalsRow.income);
    const expense = Number(totalsRow.expense);

    const today = new Date().toISOString().slice(0, 10);
    const overdueLoans = (await db.prepare(`
      SELECT l.*, c.name as client_name,
        COALESCE((SELECT SUM(amount) FROM loan_payments WHERE loan_id = l.id), 0) as paid
      FROM loans l
      JOIN Missionary c ON c.id = l.client_id
      WHERE l.status != 'paid' AND l.due_date < ?
      ORDER BY l.due_date ASC
    `).all(today)).map((l) => ({ ...l, outstanding: Number(l.amount) - Number(l.paid) }));

    const recent = await db.prepare(`
      SELECT t.*, m.name as client_name
      FROM transactions t
      LEFT JOIN Missionary m ON t.client_id = m.id
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT 10
    `).all();

    const clientBalances = (await db.prepare(`
      SELECT m.id, m.name,
        COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END), 0) AS received,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0) AS spent
      FROM Missionary m
      LEFT JOIN transactions t ON t.client_id = m.id
      GROUP BY m.id, m.name
      ORDER BY LOWER(m.name)
    `).all()).map((b) => {
      const received = Number(b.received);
      const spent = Number(b.spent);
      return { ...b, received, spent, balance: received - spent };
    });

    res.json({
      income,
      expense,
      balance: income - expense,
      overdueLoans,
      recent,
      clientBalances,
    });
  } catch (err) {
    console.error("❌ Error building dashboard:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 1. GET: Fetch Yearly Contributions Report
// ==========================================
router.get("/api/reports/yearly-contributions", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const yearlyTarget = 1200;

    const members = await db.prepare(`
      SELECT id, member_id, name, phone, YWAM AS "YWAM"
      FROM Missionary
      ORDER BY LOWER(name)
    `).all();
    const rows = await db.prepare(`
      SELECT client_id,
             CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE type = 'income'
        AND client_id IS NOT NULL
        AND (category IS NULL OR category != 'Registration Fee')
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id, month
    `).all(String(year));

    // Every expense recorded against a client (Savings Withdrawal or any
    // other category) reduces what they've net-contributed THAT month —
    // not just the running yearly total. Grouped by month so it can be
    // subtracted from the matching month's income below.
    const expenseRows = await db.prepare(`
      SELECT client_id,
             CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE type = 'expense'
        AND client_id IS NOT NULL
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id, month
    `).all(String(year));

    const byClient = {};
    rows.forEach((r) => {
      if (!byClient[r.client_id]) byClient[r.client_id] = {};
      byClient[r.client_id][r.month] = Number(r.total);
    });

    const expenseByClient = {};
    expenseRows.forEach((r) => {
      if (!expenseByClient[r.client_id]) expenseByClient[r.client_id] = {};
      expenseByClient[r.client_id][r.month] = Number(r.total);
    });

    const result = members.map((m) => {
      const monthly = {};
      let totalIncome = 0;
      let totalExpense = 0;
      for (let mo = 1; mo <= 12; mo++) {
        const income = (byClient[m.id] && byClient[m.id][mo]) || 0;
        const expense = (expenseByClient[m.id] && expenseByClient[m.id][mo]) || 0;
        monthly[mo] = income - expense; // net contribution for THIS month
        totalIncome += income;
        totalExpense += expense;
      }

      // monthly[] already nets expenses month-by-month, so summing it is
      // the year's net-saved figure. "Total Paid" now shows that same net
      // figure (income minus same-month expense), matching the client portal.
      const totalPaid = totalIncome - totalExpense;
      const netSaved = totalPaid;
      const pending = getPending(netSaved, yearlyTarget);
      const status = getStatus(netSaved, yearlyTarget);

      return {
        id: m.id,
        member_id: m.member_id,
        name: m.name,
        phone: m.phone || "",
        YWAM: m.YWAM || "",
        monthly,
        totalPaid,
        totalExpense,
        netSaved,
        yearlyTarget,
        pending,
        status,
      };
    });

    // Third-Party Payments (client_id IS NULL, category = 'Third Party
    // Payment') never touch any individual client's own totalPaid/netSaved
    // above — that's per-client and only sums that client's own
    // transactions. But money paid out to a third party during the year
    // did leave the organization, so it comes off the ORG-WIDE total below
    // — "yearly collected from clients" as a whole, not any one person's
    // figure.
    const thirdPartyRow = await db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE type = 'expense'
        AND client_id IS NULL
        AND category = 'Third Party Payment'
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
    `).get(String(year));
    const thirdPartyTotal = Number(thirdPartyRow.total);

    const totalsByMonth = {};
    for (let mo = 1; mo <= 12; mo++) {
      totalsByMonth[mo] = result.reduce((s, r) => s + r.monthly[mo], 0);
    }

    const totalCollected = result.reduce((s, r) => s + r.totalPaid, 0) - thirdPartyTotal;
    const totalNetSaved = result.reduce((s, r) => s + r.netSaved, 0) - thirdPartyTotal;
    const totalPending = result.reduce((s, r) => s + r.pending, 0);

    res.json({
      year,
      members: result,
      totalsByMonth,
      totalCollected,
      totalNetSaved,
      totalPending,
      thirdPartyTotal,
      memberCount: members.length,
      yearlyTarget,
    });
  } catch (error) {
    console.error("Error generating yearly contributions report:", error);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// // ==========================================
// 2. GET: Export Yearly Contributions as CSV
// ==========================================
router.get("/api/reports/yearly-contributions/export", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const yearlyTarget = 1200;

    const members = await db.prepare(`
      SELECT id, member_id, name, YWAM AS "YWAM"
      FROM Missionary
      ORDER BY LOWER(name)
    `).all();

    const rows = await db.prepare(`
      SELECT client_id,
             CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE type = 'income'
        AND client_id IS NOT NULL
        AND (category IS NULL OR category != 'Registration Fee')
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id, month
    `).all(String(year));

    // Same-month expense netting as the JSON report above.
    const expenseRows = await db.prepare(`
      SELECT client_id,
             CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE type = 'expense'
        AND client_id IS NOT NULL
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id, month
    `).all(String(year));

    const byClient = {};
    rows.forEach((r) => {
      if (!byClient[r.client_id]) byClient[r.client_id] = {};
      byClient[r.client_id][r.month] = Number(r.total);
    });

    const expenseByClient = {};
    expenseRows.forEach((r) => {
      if (!expenseByClient[r.client_id]) expenseByClient[r.client_id] = {};
      expenseByClient[r.client_id][r.month] = Number(r.total);
    });

    const csvRows = [];

    csvRows.push([
      "S.No",
      "MUT ID",
      "Name",
      "YWAM Branch",
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
      "Total Paid",
      "Yearly Contribution",
      "",
      "Status"
    ].join(","));

    members.forEach((m, index) => {

      let totalIncome = 0;
      let totalExpense = 0;
      const monthly = [];

      for (let month = 1; month <= 12; month++) {
        const income = (byClient[m.id] && byClient[m.id][month]) || 0;
        const expense = (expenseByClient[m.id] && expenseByClient[m.id][month]) || 0;
        monthly.push(income - expense); // net for THIS month
        totalIncome += income;
        totalExpense += expense;
      }

      const totalPaid = totalIncome - totalExpense;
      const netSaved = totalPaid;
      const pending = Math.max(0, yearlyTarget - netSaved);
      const status =
        netSaved >= yearlyTarget
          ? "Paid"
          : netSaved > 0
          ? "Partial"
          : "Pending";

      csvRows.push([
        index + 1,
        `"${m.member_id || ""}"`,
        `"${(m.name || "").replace(/"/g, '""')}"`,
        `"${(m.YWAM || "").replace(/"/g, '""')}"`,
        ...monthly,
        totalPaid,
        yearlyTarget,
        pending,
        `"${status}"`
      ].join(","));
    });

    const csvContent = "\uFEFF" + csvRows.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=yearly_contributions_${year}.csv`
    );

    res.send(csvContent);

  } catch (error) {
    console.error("Error exporting CSV:", error);
    res.status(500).json({ error: "Failed to export CSV" });
  }
});
// ==========================================
// 2b. GET: Export Yearly Contributions as PDF
// Same figures as the CSV export above (route 2), just rendered as a
// paginated landscape table instead of comma-separated text.
// ==========================================
router.get("/api/reports/yearly-contributions/export-pdf", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const yearlyTarget = 1200;

    const members = await db.prepare(`
      SELECT id, member_id, name, YWAM AS "YWAM"
      FROM Missionary
      ORDER BY LOWER(name)
    `).all();

    const rows = await db.prepare(`
      SELECT client_id,
             CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE type = 'income'
        AND client_id IS NOT NULL
        AND (category IS NULL OR category != 'Registration Fee')
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id, month
    `).all(String(year));

    const expenseRows = await db.prepare(`
      SELECT client_id,
             CAST(TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'MM') AS INTEGER) AS month,
             SUM(amount) AS total
      FROM transactions
      WHERE type = 'expense'
        AND client_id IS NOT NULL
        AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      GROUP BY client_id, month
    `).all(String(year));

    const byClient = {};
    rows.forEach((r) => {
      if (!byClient[r.client_id]) byClient[r.client_id] = {};
      byClient[r.client_id][r.month] = Number(r.total);
    });

    const expenseByClient = {};
    expenseRows.forEach((r) => {
      if (!expenseByClient[r.client_id]) expenseByClient[r.client_id] = {};
      expenseByClient[r.client_id][r.month] = Number(r.total);
    });

    const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const columns = [
      { key: "sno", label: "S.No", width: 0.6, align: "right" },
      { key: "member_id", label: "MUT ID", width: 1.1 },
      { key: "name", label: "Name", width: 1.6 },
      { key: "ywam", label: "YWAM", width: 1.1 },
      ...monthLabels.map((label, i) => ({ key: `m${i + 1}`, label, width: 0.7, align: "right" })),
      { key: "totalPaid", label: "Total Paid", width: 0.9, align: "right" },
      { key: "target", label: "Target", width: 0.8, align: "right" },
      { key: "pending", label: "Pending", width: 0.85, align: "right" },
      { key: "status", label: "Status", width: 0.8 },
    ];

    const pdfRows = members.map((m, index) => {
      let totalIncome = 0;
      let totalExpense = 0;
      const monthly = {};
      for (let mo = 1; mo <= 12; mo++) {
        const income = (byClient[m.id] && byClient[m.id][mo]) || 0;
        const expense = (expenseByClient[m.id] && expenseByClient[m.id][mo]) || 0;
        monthly[mo] = income - expense;
        totalIncome += income;
        totalExpense += expense;
      }
      const totalPaid = totalIncome - totalExpense;
      const netSaved = totalPaid;
      const pending = getPending(netSaved, yearlyTarget);
      const status = getStatus(netSaved, yearlyTarget);

      const row = {
        sno: index + 1,
        member_id: m.member_id || "",
        name: m.name || "",
        ywam: m.YWAM || "",
        totalPaid: totalPaid.toFixed(2),
        target: yearlyTarget.toFixed(2),
        pending: pending.toFixed(2),
        status,
      };
      for (let mo = 1; mo <= 12; mo++) row[`m${mo}`] = monthly[mo] ? monthly[mo].toFixed(2) : "0.00";
      return row;
    });

    const buf = await buildPDFBuffer({
      title: `Yearly Contribution Report — ${year}`,
      subtitle: `YWAM - TRICHY  |  Yearly target per member: ${yearlyTarget.toFixed(2)}`,
      columns,
      rows: pdfRows,
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=yearly_contributions_${year}.pdf`);
    res.send(buf);
  } catch (error) {
    console.error("Error exporting yearly contributions PDF:", error);
    res.status(500).json({ error: "Failed to export PDF" });
  }
});

// ==========================================
// 3. POST: Import Yearly Contributions from CSV
// ==========================================
router.post("/api/reports/yearly-contributions/import", async (req, res) => {
  console.log("📥 CSV Import route hit! Year:", req.body.year);

  try {
    const csvData = req.body.csvData;
    const year = parseInt(req.body.year, 10) || new Date().getFullYear();

    if (!csvData) {
      return res.status(400).json({ error: "No CSV data provided" });
    }

    // Strip a leading UTF-8 BOM (Excel adds one, and it would otherwise get
    // stuck onto the first header name, e.g. "\uFEFFS.No").
    const cleanCsvData = csvData.replace(/^\uFEFF/, '');

    const lines = cleanCsvData.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: "CSV file is empty or invalid" });
    }

    const delimiter = detectDelimiter(lines[0]);
    const headers = parseCSVLine(lines[0], delimiter).map(h => h.replace(/"/g, ''));

    const results = {
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      details: []
    };

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Use a transaction so if one row fails, nothing is partially saved.
    //
    // IMPORTANT: the old version of this route ran up to ~13 queries PER
    // CSV ROW (1 member lookup + 12 "does this month already exist"
    // checks) sequentially inside the transaction. For a CSV with 80+
    // members that's 1,000+ round-trips to Postgres in a row — on a
    // hosted DB that's easily minutes, which blows past the hosting
    // platform's request timeout. The request would die client-side
    // while the import kept running server-side in the background, so
    // a re-upload would only ever seem to "catch" the first chunk that
    // finished before the timeout — hence needing to upload repeatedly,
    // and monthly payments appearing not to update.
    //
    // Fix: load every member and every existing transaction for the
    // year ONCE up front (2 queries total), then just look things up
    // in memory per row. Only inserts/updates still hit the DB.
    const runImport = db.transaction(async () => {
      const allMembers = await db.prepare(
        "SELECT id, member_id, name FROM Missionary"
      ).all();
      const memberByMemberId = new Map();
      const memberByName = new Map();
      for (const m of allMembers) {
        if (m.member_id) memberByMemberId.set(m.member_id.toLowerCase(), m);
        if (m.name) memberByName.set(m.name.toLowerCase(), m);
      }

      const existingRows = await db.prepare(`
        SELECT id, client_id,
               TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY-MM') AS month_str
        FROM transactions
        WHERE type = 'income'
          AND TO_CHAR((CASE WHEN date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN date::date ELSE NULL END), 'YYYY') = ?
      `).all(String(year));
      // existingByClientMonth["<client_id>|<YYYY-MM>"] = transaction id
      const existingByClientMonth = new Map();
      for (const r of existingRows) {
        if (r.month_str) existingByClientMonth.set(`${r.client_id}|${r.month_str}`, r.id);
      }

      for (let i = 1; i < lines.length; i++) {
        const row = parseCSVLine(lines[i], delimiter);

        if (!row || row.length < 4) {
          results.errors++;
          results.details.push({ row: i + 1, error: "Invalid row format" });
          continue;
        }

        const memberIdIndex = headers.indexOf('MUT ID');
        const nameIndex = headers.indexOf('Name');
        const memberId = memberIdIndex >= 0 ? (row[memberIdIndex] || '').replace(/"/g, '').trim() : '';
        const rowName = nameIndex >= 0 ? (row[nameIndex] || '').replace(/"/g, '').trim() : '';

        let member = null;
        if (memberId) {
          member = memberByMemberId.get(memberId.toLowerCase()) || null;
        }
        // Fall back to matching by name if the Member ID is blank or doesn't
        // match anything (e.g. it was cleared, or edited in Excel).
        if (!member && rowName) {
          member = memberByName.get(rowName.toLowerCase()) || null;
        }

        if (!memberId && !rowName) {
          results.skipped++;
          results.details.push({ row: i + 1, error: "Missing MUT ID and Name" });
          continue;
        }

        if (!member) {
          results.skipped++;
          results.details.push({ row: i + 1, member: memberId || rowName, error: "Member not found in database" });
          continue;
        }

        const monthlyAmounts = [];
        for (let m = 0; m < 12; m++) {
          const colIndex = headers.indexOf(months[m]);
          const raw = colIndex >= 0 ? (row[colIndex] || '') : '';
          // Strip anything that isn't a digit, minus sign, or decimal point
          // (currency symbols, thousands separators, stray quotes/spaces).
          const cleaned = raw.replace(/"/g, '').replace(/[^0-9.\-]/g, '');
          const amount = cleaned ? parseFloat(cleaned) : 0;
          monthlyAmounts.push(isNaN(amount) ? 0 : amount);
        }

        let updatedCount = 0;
        let insertedCount = 0;

        for (let m = 0; m < 12; m++) {
          const amount = monthlyAmounts[m];
          if (amount > 0) {
            const monthDate = `${year}-${String(m + 1).padStart(2, '0')}-01`;
            const monthStr = monthDate.substring(0, 7); // YYYY-MM
            const existingId = existingByClientMonth.get(`${member.id}|${monthStr}`);

            if (existingId) {
              await db.prepare(`
                UPDATE transactions SET amount = ? WHERE id = ?
              `).run(amount, existingId);
              updatedCount++;
            } else {
              const newId = uid();
              await db.prepare(`
                INSERT INTO transactions (id, date, type, category, client_id, amount, description, created_at)
                VALUES (?, ?, 'income', 'Contribution', ?, ?, 'Imported from CSV', ?)
              `).run(newId, monthDate, member.id, amount, nowISO());
              // Keep the in-memory map in sync in case the same month
              // appears again later for this client in the same file.
              existingByClientMonth.set(`${member.id}|${monthStr}`, newId);
              insertedCount++;
            }
          }
        }

        if (updatedCount > 0 || insertedCount > 0) {
          results.imported++;
          results.updated += (updatedCount + insertedCount);
          results.details.push({
            row: i + 1,
            member: memberId,
            name: member.name,
            monthsUpdated: updatedCount + insertedCount
          });
        } else {
          results.skipped++;
        }
      }
    });

    try {
      await runImport();
      console.log("✅ CSV Import successful!");
    } catch (innerError) {
      console.error("❌ Transaction rolled back due to error:", innerError);
      throw innerError;
    }

    res.json({
      success: true,
      message: `Imported: ${results.imported}, Updated: ${results.updated}, Skipped: ${results.skipped}, Errors: ${results.errors}`,
      results
    });

  } catch (error) {
    console.error("❌ Error importing CSV:", error);
    res.status(500).json({ error: "Failed to import CSV: " + error.message });
  }
});

module.exports = router;
