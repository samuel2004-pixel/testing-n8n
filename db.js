const { Pool } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");
const path = require("path");
const fs = require("fs");

const UPLOADS_DIR = path.join(__dirname, "uploads", "receipts");
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is not set. Add it to your .env file, e.g.");
    console.error("   DATABASE_URL=postgres://user:password@host:5432/YWAM");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Most managed Postgres providers (Render, Railway, Supabase, RDS, etc.)
    // require SSL. Set PGSSL=disable for a local Postgres without SSL.
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    // Render's Postgres (especially the free tier) silently drops
    // connections that sit idle for a while and also enforces its own
    // connection cap. Without these, `pg` keeps a client open past that
    // point, and the *next* query on it fails with "Connection terminated
    // unexpectedly" instead of the pool just opening a fresh one — this is
    // the main cause of "works, then randomly doesn't" behavior.
    max: Number(process.env.PG_POOL_MAX) || 8,
    idleTimeoutMillis: 20000,       // release idle clients before Render kills them
    connectionTimeoutMillis: 10000, // fail fast instead of hanging forever
    keepAlive: true,
});

pool.on("error", (err) => {
    // A background/idle client died (e.g. Render closed it). `pg` already
    // drops it from the pool on its own — the next checkout opens a new
    // connection — so this is just visibility, not a crash.
    console.error("Unexpected Postgres pool error (idle client):", err.message);
});

// Errors that mean "the connection died", not "the query was wrong" — safe
// to retry once on a fresh connection.
function isTransientConnectionError(err) {
    const code = err && err.code;
    const msg = (err && err.message) || "";
    return (
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "57P01" || // admin_shutdown
        code === "08006" || // connection_failure
        code === "08003" || // connection_does_not_exist
        msg.includes("Connection terminated unexpectedly") ||
        msg.includes("terminating connection") ||
        msg.includes("Client has encountered a connection error")
    );
}

// ---------------------------------------------------------------------
// better-sqlite3 compatibility shim
// ---------------------------------------------------------------------
// The rest of the codebase was written against better-sqlite3's
// synchronous `db.prepare(sql).get(...params)/.all(...params)/.run(...params)`
// API. Rather than rewrite every query by hand, `prepare()` here returns an
// object with the same method names, backed by `pg`. The methods are now
// async (they return Promises) — callers must `await` them — and `?`
// placeholders are translated to Postgres's `$1, $2, ...` automatically.
function toPgQuery(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}

// When code runs inside db.transaction(fn), all queries issued by prepare()
// (even several calls deep) must run on the same client connection so they
// see each other's uncommitted writes and can be rolled back together.
// AsyncLocalStorage threads that client through without changing call sites.
const txContext = new AsyncLocalStorage();

function runner() {
    return txContext.getStore() || pool;
}

// Runs `queryFn` against the current runner (transaction client or pool).
// On a transient connection error it retries exactly once — but only when
// we're NOT inside a transaction, since a transaction is pinned to one
// client on purpose (retrying there would silently drop the BEGIN and any
// prior statements in it). A mid-transaction failure still throws, and
// db.transaction()'s catch block rolls back as before.
async function runQuery(text, flat) {
    const inTransaction = !!txContext.getStore();
    try {
        return await runner().query(text, flat);
    } catch (err) {
        if (!inTransaction && isTransientConnectionError(err)) {
            console.warn("⚠️ Transient Postgres error, retrying once:", err.message);
            return await pool.query(text, flat);
        }
        throw err;
    }
}

function prepare(sql) {
    const text = toPgQuery(sql);
    return {
        async get(...params) {
            const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            const res = await runQuery(text, flat);
            return res.rows[0];
        },
        async all(...params) {
            const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            const res = await runQuery(text, flat);
            return res.rows;
        },
        async run(...params) {
            const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
            const res = await runQuery(text, flat);
            return { changes: res.rowCount, rows: res.rows };
        },
    };
}

async function exec(sql) {
    await runQuery(sql);
}

// better-sqlite3-style helper: `db.transaction(fn)` returns a function;
// calling it runs `fn` (which may be async) inside a BEGIN/COMMIT block,
// rolling back on any thrown error. Unlike better-sqlite3, the returned
// function is async and must be awaited.
function transaction(fn) {
    return async (...args) => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await txContext.run(client, () => fn(...args));
            await client.query("COMMIT");
            return result;
        } catch (err) {
            try { await client.query("ROLLBACK"); } catch (_) { /* ignore */ }
            throw err;
        } finally {
            client.release();
        }
    };
}

const db = {
    pool,
    prepare,
    exec,
    transaction,
    query: (text, params) => runner().query(text, params),
};

// =====================================================
// SCHEMA
// =====================================================
async function initSchema() {
    await exec(`
CREATE TABLE IF NOT EXISTS Missionary (
    id TEXT PRIMARY KEY,
    member_id TEXT UNIQUE,
    name TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    email TEXT,
    YWAM TEXT,
    notes TEXT,
    photo TEXT,
    portal_token TEXT UNIQUE,
    total_amount REAL DEFAULT 0,
    total_paid REAL DEFAULT 0,
    remaining_amount REAL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('income','expense')),
    amount REAL NOT NULL,
    category TEXT,
    client_id TEXT,
    description TEXT,
    date TEXT NOT NULL,
    loan_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(client_id) REFERENCES Missionary(id)
);

CREATE TABLE IF NOT EXISTS loans (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    amount REAL NOT NULL,
    date_given TEXT NOT NULL,
    due_date TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    FOREIGN KEY(client_id) REFERENCES Missionary(id)
);

CREATE TABLE IF NOT EXISTS loan_payments (
    id TEXT PRIMARY KEY,
    loan_id TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    source TEXT DEFAULT 'portal',
    created_at TEXT NOT NULL,
    FOREIGN KEY(loan_id) REFERENCES loans(id)
);

CREATE TABLE IF NOT EXISTS monthly_payments (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    month TEXT NOT NULL,
    year INTEGER NOT NULL,
    amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    FOREIGN KEY(client_id) REFERENCES Missionary(id)
);

CREATE TABLE IF NOT EXISTS payment_proofs (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    amount REAL,
    ocr_amount REAL,
    utr_number TEXT,
    screenshot TEXT,
    uploaded_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    approved_by TEXT,
    approved_at TEXT,
    remarks TEXT,
    FOREIGN KEY(client_id) REFERENCES Missionary(id)
);

CREATE TABLE IF NOT EXISTS payment_history (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_date TEXT NOT NULL,
    payment_method TEXT,
    reference_no TEXT,
    proof_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(client_id) REFERENCES Missionary(id)
);

CREATE TABLE IF NOT EXISTS reminders_log (
    id TEXT PRIMARY KEY,
    loan_id TEXT,
    client_id TEXT,
    sent_at TEXT NOT NULL,
    message TEXT,
    status TEXT,
    error TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Audit trail of permanently-deleted entries (transactions, third-party
-- payments, loans, clients, courier shipments) so they can be listed and
-- exported even after the original row is gone.
CREATE TABLE IF NOT EXISTS deleted_entries (
    id TEXT PRIMARY KEY,
    entry_type TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    summary TEXT,
    amount REAL,
    entry_date TEXT,
    data TEXT,
    deleted_at TEXT NOT NULL
);

-- Courier tab: tracks Client -> Third-Party shipments (send date, courier
-- date, total amount, and the payout given to the third party/courier).
CREATE TABLE IF NOT EXISTS courier_shipments (
    id TEXT PRIMARY KEY,
    client_id TEXT,
    third_party_name TEXT,
    send_date TEXT NOT NULL,
    courier_date TEXT,
    total_amount REAL NOT NULL DEFAULT 0,
    third_party_payout REAL NOT NULL DEFAULT 0,
    description TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(client_id) REFERENCES Missionary(id)
);

-- Multiple images attached to an entry (a transaction/Contributions entry
-- or a courier shipment). Files themselves live on disk under
-- uploads/entry-images; this table just indexes them per entry.
CREATE TABLE IF NOT EXISTS entry_images (
    id TEXT PRIMARY KEY,
    entry_type TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    uploaded_at TEXT NOT NULL
);
`);

    // =====================================================
    // AUTOMATIC MIGRATION: Rename old columns to match code
    // =====================================================
    const tablesToMigrate = [
        'transactions',
        'loans',
        'monthly_payments',
        'payment_proofs',
        'payment_history',
        'reminders_log'
    ];

    for (const table of tablesToMigrate) {
        try {
            await exec(`ALTER TABLE ${table} RENAME COLUMN "Missionary_id" TO client_id`);
            console.log(`✅ Database migrated: renamed '${table}.Missionary_id' to 'client_id'`);
        } catch (err) {
            // Ignore errors (this means the column is already named 'client_id' or doesn't exist)
        }
    }

    // =====================================================
    // MIGRATION: Drop the GSTIN / Tax ID column (no longer used).
    // =====================================================
    try {
        await exec(`ALTER TABLE Missionary DROP COLUMN IF EXISTS gstin`);
    } catch (err) {
        // Ignore errors
    }

    // =====================================================
    // MIGRATION: Add ocr_match column to payment_proofs
    // =====================================================
    try {
        await exec(`ALTER TABLE payment_proofs ADD COLUMN IF NOT EXISTS ocr_match INTEGER DEFAULT 0`);
    } catch (err) {
        // Ignore errors (column already exists)
    }

    // =====================================================
    // MIGRATION: Add payee column to transactions (used by
    // Third-Party Payments — who the money was paid to).
    // =====================================================
    try {
        await exec(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payee TEXT`);
    } catch (err) {
        // Ignore errors (column already exists)
    }

    // =====================================================
    // MIGRATION: Backfill a human-readable MUT ID (member_id)
    // for any client that doesn't already have one.
    // =====================================================
    const missingIds = await prepare(
        "SELECT id FROM Missionary WHERE member_id IS NULL OR member_id = '' ORDER BY created_at"
    ).all();
    if (missingIds.length) {
        const updateStmt = prepare("UPDATE Missionary SET member_id = ? WHERE id = ?");
        for (const row of missingIds) {
            const newId = await generateMemberId();
            await updateStmt.run(newId, row.id);
        }
        console.log(`✅ Database migrated: assigned MUT IDs to ${missingIds.length} existing client(s)`);
    }

    // Initialize default currency if not set
    const currencyRow = await prepare("SELECT value FROM settings WHERE key='currency'").get();
    if (!currencyRow) {
        await prepare("INSERT INTO settings(key,value) VALUES('currency',?)").run("₹");
    }
}

async function generateMemberId() {
    const row = await prepare(`
        SELECT member_id FROM Missionary
        WHERE member_id LIKE 'CL-%'
        ORDER BY CAST(SUBSTR(member_id, 4) AS INTEGER) DESC
        LIMIT 1
    `).get();
    let next = 1;
    if (row && row.member_id) {
        const n = parseInt(row.member_id.slice(3), 10);
        if (!isNaN(n)) next = n + 1;
    }
    return `CL-${String(next).padStart(4, "0")}`;
}

db.generateMemberId = generateMemberId;
db.ready = initSchema().then(() => {
    console.log("✅ Postgres schema ready");
}).catch((err) => {
    console.error("❌ Failed to initialize Postgres schema:", err);
    process.exit(1);
});

module.exports = db;
