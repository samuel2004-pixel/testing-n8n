const express = require('express');
const Tesseract = require('tesseract.js');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('./auth');
const { nowISO } = require('../utils/helpers');
const router = express.Router();

// How close (in currency units) the OCR-detected amount must be to the
// client's declared amount to be considered a match.
const AMOUNT_MATCH_TOLERANCE = 1;

// Pull plausible currency amounts out of OCR'd receipt text.
// Screenshots contain lots of other numbers (dates, UTR/reference numbers,
// phone numbers, account numbers) so we bound the length to avoid picking
// up long reference numbers, and strip thousands-separator commas first.
function extractAmountCandidates(text) {
    if (!text) return [];
    const cleaned = text.replace(/(\d),(\d{3})/g, "$1$2");
    const matches = cleaned.match(/\d{1,7}(?:\.\d{1,2})?/g) || [];
    return matches
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0 && n < 10000000);
}

function amountsMatch(a, b, tolerance = AMOUNT_MATCH_TOLERANCE) {
    if (!a || !b) return false;
    return Math.abs(a - b) <= tolerance;
}

// Choose the best OCR amount to record: prefer one that matches what the
// client declared, otherwise fall back to the largest plausible number
// found (receipts usually show the total as the largest amount on screen).
function pickBestAmount(candidates, declaredAmount) {
    if (!candidates.length) return 0;
    const closeMatch = candidates.find((n) => amountsMatch(n, declaredAmount));
    if (closeMatch !== undefined) return closeMatch;
    return Math.max(...candidates);
}

function extractUtr(text) {
    if (!text) return null;
    const m = text.match(/\b(?:UTR|UPI Ref|Txn ID|Transaction ID|Ref(?:erence)?)[\s.:#-]*([A-Za-z0-9]{6,25})\b/i);
    return m ? m[1] : null;
}

// Run Tesseract OCR with a hard timeout and an errorHandler so that a
// worker-level failure (e.g. no network access to fetch language data)
// rejects cleanly instead of hanging the request or crashing the process.
function runOcrWithTimeout(filePath, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("OCR timed out"));
        }, timeoutMs);

        Tesseract.recognize(filePath, 'eng', {
            errorHandler: (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            },
        }).then(({ data }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(data.text);
        }).catch((err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
    });
}

module.exports = (db, upload) => {

    // CLIENT: Upload Payment Proof
    // The client isn't logged in — they're identified by the portal token
    // in the URL, same as every other client-portal endpoint.
    router.post('/client/upload-payment', upload.single('receipt'), async (req, res) => {
        const token = req.query.token;
        if (!token) {
            return res.status(400).json({ success: false, error: "missing_token", message: "Missing client link token." });
        }

        const client = await db.prepare("SELECT * FROM Missionary WHERE portal_token = ?").get(token);
        if (!client) {
            return res.status(404).json({ success: false, error: "invalid_link", message: "This link doesn't match any account." });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, error: "no_file", message: "Please attach a screenshot or photo of the payment." });
        }

        const declaredAmount = parseFloat(req.body.amount) || 0;
        if (declaredAmount <= 0) {
            return res.status(400).json({ success: false, error: "invalid_amount", message: "Please enter a valid amount." });
        }

        const filePath = req.file.path;
        const proofId = uuidv4();
        let ocrAmount = 0;
        let ocrMatch = 0;
        let utrNumber = null;

        try {
            const text = await runOcrWithTimeout(filePath, 30000);
            const candidates = extractAmountCandidates(text);
            ocrAmount = pickBestAmount(candidates, declaredAmount);
            ocrMatch = amountsMatch(ocrAmount, declaredAmount) ? 1 : 0;
            utrNumber = extractUtr(text);
        } catch (err) {
            console.error("OCR Error:", err.message || err);
            // Keep ocrAmount at 0 / ocrMatch at 0 — admin will verify manually.
        }

        await db.prepare(`
            INSERT INTO payment_proofs (id, client_id, amount, ocr_amount, ocr_match, utr_number, screenshot, uploaded_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `).run(proofId, client.id, declaredAmount, ocrAmount, ocrMatch, utrNumber, req.file.filename, nowISO());

        res.json({
            success: true,
            matched: !!ocrMatch,
            ocrAmount,
            message: ocrMatch
                ? "Upload successful — the amount matched what we detected in your screenshot. Pending admin approval."
                : "Upload successful. We couldn't clearly confirm the amount from your screenshot, so the admin will double-check it manually before approving."
        });
    });

    // ADMIN: Get Pending Payments
    router.get('/verify-payments', requireAuth, async (req, res) => {
        const payments = await db.prepare(`
            SELECT p.*, m.name as client_name, m.member_id as client_member_id
            FROM payment_proofs p
            JOIN Missionary m ON p.client_id = m.id
            WHERE p.status = 'pending'
            ORDER BY p.uploaded_at DESC
        `).all();
        const withUrls = payments.map((p) => ({
            ...p,
            screenshot_url: p.screenshot ? `/uploads/receipts/${p.screenshot}` : null,
        }));
        res.json(withUrls);
    });

    // ADMIN: Approve Payment
    // Marks the proof approved, logs it in payment_history, AND records an
    // actual income transaction so the client's balance (which is computed
    // from the transactions table) reflects the payment immediately.
    router.post('/approve-payment/:id', requireAuth, async (req, res) => {
        const proofId = req.params.id;
        const proof = await db.prepare("SELECT * FROM payment_proofs WHERE id = ?").get(proofId);

        if (!proof) return res.status(404).json({ error: "Payment proof not found" });
        if (proof.status === 'approved') return res.status(400).json({ error: "Payment already approved" });

        const today = new Date().toISOString().slice(0, 10);
        const txId = uuidv4();
        const ts = nowISO();

        const dbTransact = db.transaction(async () => {
            await db.prepare("UPDATE payment_proofs SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?")
              .run(ts, req.user?.username || 'admin', proofId);

            await db.prepare(`
                UPDATE Missionary
                SET total_paid = total_paid + ?,
                    remaining_amount = remaining_amount - ?
                WHERE id = ?
            `).run(proof.amount, proof.amount, proof.client_id);

            await db.prepare(`
                INSERT INTO payment_history (id, client_id, amount, payment_date, payment_method, reference_no, proof_id, created_at)
                VALUES (?, ?, ?, ?, 'Screenshot upload', ?, ?, ?)
            `).run(uuidv4(), proof.client_id, proof.amount, ts, proof.utr_number || 'Admin Verified', proofId, ts);

            // Record it as an income transaction so it counts toward the
            // client's visible balance, same as any manually-entered payment.
            await db.prepare(`
                INSERT INTO transactions (id, type, amount, category, client_id, description, date, created_at)
                VALUES (?, 'income', ?, 'Payment', ?, ?, ?, ?)
            `).run(
                txId,
                proof.amount,
                proof.client_id,
                `Payment via screenshot upload${proof.ocr_match ? ' (amount auto-verified)' : ' (verified manually)'}`,
                today,
                ts
            );
        });

        try {
            await dbTransact();
            res.json({ success: true, message: "Payment approved and balance updated." });
        } catch (err) {
            console.error("Approval Error:", err);
            res.status(500).json({ error: "Database error during approval" });
        }
    });

    // ADMIN: Reject Payment
    router.post('/reject-payment/:id', requireAuth, async (req, res) => {
        const remarks = req.body.remarks || 'Rejected by admin';
        await db.prepare("UPDATE payment_proofs SET status = 'rejected', remarks = ? WHERE id = ?")
          .run(remarks, req.params.id);
        res.json({ success: true, message: "Payment rejected." });
    });

    return router;
};
