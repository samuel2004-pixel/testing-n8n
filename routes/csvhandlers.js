const express = require('express');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('./auth');
const { nowISO } = require('../utils/helpers');
const { buildPDFBuffer } = require('../utils/exporters');
const router = express.Router();

module.exports = (db, upload) => {

    // EXPORT: PDF Ledger Format
    router.get('/export-ledger-csv', requireAuth, async (req, res) => {
        const clients = await db.prepare('SELECT *, YWAM AS "YWAM" FROM Missionary').all();
        const exportDir = path.join(__dirname, '..', 'exports');

        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        const filePath = path.join(exportDir, 'ledger.csv');

        const csvWriter = createCsvWriter({
            path: filePath,
            header: [
                { id: 'name', title: 'Name' },
                { id: 'member_id', title: 'Member ID' },
                { id: 'YWAM', title: 'YWAM Branch' },
                { id: 'total_amount', title: 'Total Amount' },
                { id: 'total_paid', title: 'Total Paid' },
                { id: 'remaining_amount', title: 'Balance Due' },
                { id: 'phone', title: 'Phone' }
            ]
        });

        const records = clients.map(c => ({
            name: c.name,
            member_id: c.member_id || '',
            YWAM: c.YWAM || '',
            total_amount: c.total_amount || 0,
            total_paid: c.total_paid || 0,
            remaining_amount: c.remaining_amount || 0,
            phone: c.phone || ''
        }));

        csvWriter.writeRecords(records).then(() => {
            res.download(filePath);
        }).catch(err => {
            console.error("CSV Export Error:", err);
            res.status(500).send("Error generating CSV");
        });
    });
    // EXPORT: Name + Portal Link only — meant to be shared as a searchable
    // sheet so each client can find their own row and tap their link.
    router.get('/export-portal-links-csv', requireAuth, async (req, res) => {
        const clients = await db.prepare("SELECT * FROM Missionary ORDER BY LOWER(name)").all();
        const exportDir = path.join(__dirname, '..', 'exports');

        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        const filePath = path.join(exportDir, 'portal-links.csv');

        // Prefer an explicit BASE_URL (same one scheduler.js uses for
        // reminder messages) so the link is stable regardless of which
        // request happens to generate it; fall back to the request's own
        // host if it isn't set.
        const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

        const csvWriter = createCsvWriter({
            path: filePath,
            header: [
                { id: 'name', title: 'Name' },
                { id: 'link', title: 'Portal Link' }
            ]
        });

        const records = clients
            .filter(c => c.portal_token) // skip anyone without a link yet
            .map(c => ({
                name: c.name,
                link: `${base}/portal.html?token=${c.portal_token}`
            }));

        csvWriter.writeRecords(records).then(() => {
            res.download(filePath, 'portal-links.csv');
        }).catch(err => {
            console.error("Portal links CSV export error:", err);
            res.status(500).send("Error generating CSV");
        });
    });

    // EXPORT: Name + Portal Link — PDF version of the export above, for
    // printing or sharing as a document instead of a spreadsheet.
    router.get('/export-portal-links-pdf', requireAuth, async (req, res) => {
        try {
            const clients = await db.prepare("SELECT * FROM Missionary ORDER BY LOWER(name)").all();
            const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

            const rows = clients
                .filter(c => c.portal_token)
                .map((c, i) => ({
                    sno: i + 1,
                    member_id: c.member_id || '',
                    name: c.name,
                    link: `${base}/portal.html?token=${c.portal_token}`,
                }));

            const buf = await buildPDFBuffer({
                title: "Missionary Portal Links",
                subtitle: "YWAM - TRICHY  |  Each missionary's self-service portal link",
                columns: [
                    { key: "sno", label: "S.No", width: 0.5, align: "right" },
                    { key: "member_id", label: "Member ID", width: 1 },
                    { key: "name", label: "Name", width: 1.6 },
                    { key: "link", label: "Portal Link", width: 3 },
                ],
                rows,
            });

            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", "attachment; filename=portal-links.pdf");
            res.send(buf);
        } catch (err) {
            console.error("Portal links PDF export error:", err);
            res.status(500).json({ error: "Failed to export PDF" });
        }
    });

    // EXPORT: Third-Party Payments
    router.get('/export-third-party-payments-csv', requireAuth, async (req, res) => {
        const payments = await db.prepare(`
            SELECT * FROM transactions
            WHERE type = 'expense' AND category = 'Third Party Payment'
            ORDER BY date DESC, created_at DESC
        `).all();
        const exportDir = path.join(__dirname, '..', 'exports');

        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }

        const filePath = path.join(exportDir, 'third-party-payments.csv');

        const csvWriter = createCsvWriter({
            path: filePath,
            header: [
                { id: 'date', title: 'Date' },
                { id: 'payee', title: 'Paid To' },
                { id: 'amount', title: 'Amount' },
                { id: 'description', title: 'Description' }
            ]
        });

        const records = payments.map(p => ({
            date: p.date,
            payee: p.payee || '',
            amount: p.amount || 0,
            description: p.description || ''
        }));

        csvWriter.writeRecords(records).then(() => {
            res.download(filePath, 'third-party-payments.csv');
        }).catch(err => {
            console.error("Third-party payments CSV export error:", err);
            res.status(500).send("Error generating CSV");
        });
    });

    // EXPORT: Third-Party Payments — PDF version
    router.get('/export-third-party-payments-pdf', requireAuth, async (req, res) => {
        try {
            const payments = await db.prepare(`
                SELECT * FROM transactions
                WHERE type = 'expense' AND category = 'Third Party Payment'
                ORDER BY date DESC, created_at DESC
            `).all();

            const rows = payments.map((p, i) => ({
                sno: i + 1,
                date: p.date || '',
                payee: p.payee || '',
                description: p.description || '',
                amount: Number(p.amount || 0).toFixed(2),
            }));
            const total = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
            if (rows.length) {
                rows.push({ sno: "", date: "", payee: "", description: "TOTAL", amount: total.toFixed(2) });
            }

            const buf = await buildPDFBuffer({
                title: "Third-Party Payments",
                subtitle: "YWAM - TAMILNADU to MUT Contributions",
                columns: [
                    { key: "sno", label: "S.No", width: 0.5, align: "right" },
                    { key: "date", label: "Date", width: 1 },
                    { key: "payee", label: "Paid To", width: 1.6 },
                    { key: "description", label: "Description", width: 2.2 },
                    { key: "amount", label: "Amount", width: 1, align: "right" },
                ],
                rows,
            });

            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", "attachment; filename=third-party-payments.pdf");
            res.send(buf);
        } catch (err) {
            console.error("Third-party payments PDF export error:", err);
            res.status(500).json({ error: "Failed to export PDF" });
        }
    });

// IMPORT: PDF Ledger Format
router.post('/import-ledger-csv', requireAuth, upload.single('csvfile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }

    const rows = [];

    fs.createReadStream(req.file.path)
        .pipe(csv({ headers: false }))
        .on("data", row => rows.push(row))
        .on("end", async () => {

            // Skip first row (header)
            const data = rows.slice(1);

            // NOTE: uses ON CONFLICT DO UPDATE (upsert) rather than a full
            // row replace, so re-importing an existing member (matched by
            // id) updates only these columns and doesn't blank out fields
            // like email, portal_token, or photo that this CSV doesn't carry.
            const insertStmt = db.prepare(`
                INSERT INTO Missionary
                (
                    id,
                    member_id,
                    name,
                    YWAM,
                    total_amount,
                    total_paid,
                    remaining_amount,
                    phone,
                    created_at
                )
                VALUES
                (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT (id) DO UPDATE SET
                    member_id = EXCLUDED.member_id,
                    name = EXCLUDED.name,
                    YWAM = EXCLUDED.YWAM,
                    total_amount = EXCLUDED.total_amount,
                    total_paid = EXCLUDED.total_paid,
                    remaining_amount = EXCLUDED.remaining_amount,
                    phone = EXCLUDED.phone
            `);

            let successCount = 0;

            for (const r of data) {
                try {
                    // Columns match export-ledger-csv exactly:
                    // 0: Name, 1: Member ID, 2: YWAM Branch, 3: Total Amount, 4: Total Paid, 5: Balance Due, 6: Phone
                    const name = String(r[0] || "").trim();
                    const memberId = String(r[1] || "").trim();
                    const ywam = String(r[2] || "").trim();

                    const totalAmount = Number(r[3] || 0);
                    const totalPaid = Number(r[4] || 0);
                    const balance = Number(r[5] || 0);

                    const phone = String(r[6] || "").trim();

                    if (!name && !memberId) continue; // blank row

                    // BUG FIX: this used to do `id = memberId || uuidv4()` and
                    // rely on ON CONFLICT (id) to upsert. But a client's real
                    // primary key is a generated uid (e.g. "a1b2c3..."), not
                    // their member_id (e.g. "MUT-001") — so on re-import this
                    // never matched an existing id. It then hit the separate
                    // UNIQUE constraint on member_id instead, which ON
                    // CONFLICT (id) doesn't catch, so Postgres threw a
                    // duplicate-key error that the catch block below silently
                    // swallowed. Net effect: re-importing the ledger CSV to
                    // bulk-edit an existing client (e.g. their YWAM branch)
                    // silently did nothing. Look the client up by member_id
                    // (falling back to name) first, and update that row.
                    let existing = null;
                    if (memberId) {
                        existing = await db.prepare(
                            "SELECT id FROM Missionary WHERE LOWER(member_id) = LOWER(?)"
                        ).get(memberId);
                    }
                    if (!existing && name) {
                        existing = await db.prepare(
                            "SELECT id FROM Missionary WHERE LOWER(name) = LOWER(?)"
                        ).get(name);
                    }
                    const id = existing ? existing.id : uuidv4();

                    await insertStmt.run(
                        id,
                        memberId,
                        name,
                        ywam,
                        totalAmount,
                        totalPaid,
                        balance,
                        phone,
                        nowISO()
                    );

                    successCount++;
                } catch (err) {
                    console.error("Import Error:", err);
                }
            }

            fs.unlinkSync(req.file.path);

            res.json({
                success: true,
                imported: successCount
            });

        })
        .on("error", err => {

            console.error(err);

            res.status(500).json({
                error: "Failed to import CSV"
            });

        });

});

    return router;
};
