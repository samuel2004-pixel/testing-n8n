require("dotenv").config();
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const db = require("./db");
const { router: authRouter, requireAuth } = require("./routes/auth");
const MissionaryRouter = require("./routes/Missionary");
const transactionsRouter = require("./routes/transactions");
const loansRouter = require("./routes/loans");
const portalRouter = require("./routes/portal");
const settingsRouter = require("./routes/settings");
const reportsRouter = require("./routes/reports");
const courierRouter = require("./routes/courier");
const deletedRouter = require("./routes/deleted");
const { startScheduler } = require("./scheduler");

const app = express();
const PORT = process.env.PORT || 3000;

// Safety net: log unexpected errors instead of letting them crash the
// whole server (e.g. a third-party library like the OCR engine throwing
// an unhandled error deep inside an async worker).
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught exception (server kept running):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("⚠️ Unhandled promise rejection (server kept running):", err);
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));

app.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: "user_sessions",
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || "YWAM-dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    // No maxAge/expires => a browser session cookie. The browser drops it
    // when it's closed, so admins are signed out at the end of the
    // browsing session instead of staying logged in for days on a shared
    // or public computer. (Cookies live per-browser, not per-tab, so
    // closing one tab while another admin tab is still open won't log
    // that session out — closing every tab/window for this site will.)
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
  },
}));

// ---- Public routes ----
app.use(portalRouter);
app.use(authRouter);

// ---- Static files ----
app.get("/portal.html", (req, res) => res.sendFile(path.join(__dirname, "public/portal/portal.html")));
app.use("/portal", express.static(path.join(__dirname, "public/portal")));
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "public/admin/login.html")));
app.use("/css", express.static(path.join(__dirname, "public/admin/css")));

// ---- Multer Configuration for Receipts ----
const UPLOAD_DIR = path.join(__dirname, 'uploads', 'receipts');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadReceipt = multer({ storage: storage });
app.locals.uploadReceipt = uploadReceipt;

// ---- Multer Configuration for multiple images per entry (Contributions /
// Courier) — separate directory from receipts, image files only. ----
const ENTRY_IMAGES_DIR = path.join(__dirname, 'uploads', 'entry-images');
if (!fs.existsSync(ENTRY_IMAGES_DIR)) {
    fs.mkdirSync(ENTRY_IMAGES_DIR, { recursive: true });
}
const entryImagesStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, ENTRY_IMAGES_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const uploadEntryImages = multer({
    storage: entryImagesStorage,
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per image
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    },
});

// ---- NEW: Payment & CSV Routes ----
// Mounted BEFORE the blanket requireAuth routers below. '/api/client/upload-payment'
// inside paymentRoutes must stay public (it's used by the client portal, which
// isn't an admin session) — if it were reachable only after the requireAuth
// routers, express-session would 401 every non-admin request before it ever
// got here. The admin-only routes in payments.js and csvhandlers.js
// (verify/approve/reject payments, CSV import/export) each apply requireAuth
// individually instead, so they stay protected either way.
const paymentRoutes = require('./routes/payments'); 
const csvRoutes = require('./routes/csvhandlers');
app.use('/api', paymentRoutes(db, uploadReceipt));
app.use('/admin', csvRoutes(db, uploadReceipt));

// ---- Automation routes (for n8n etc.) ----
// Mounted here (before the requireAuth block below) because these use their
// own AUTOMATION_API_KEY check instead of the admin session cookie — an
// external scheduler like n8n has no browser session to send.
const automationRoutes = require('./routes/automation');
app.use(automationRoutes);

// ---- Protected Routes ----
app.use(requireAuth, MissionaryRouter);
app.use(requireAuth, transactionsRouter);
app.use(requireAuth, loansRouter);
app.use(requireAuth, settingsRouter);
app.use(requireAuth, reportsRouter);
app.use(requireAuth, courierRouter);
app.use(requireAuth, deletedRouter);

const imagesRoutes = require('./routes/images');
app.use(requireAuth, imagesRoutes(db, uploadEntryImages, ENTRY_IMAGES_DIR));

// Serve uploaded receipts securely
app.use('/uploads/receipts', requireAuth, express.static(UPLOAD_DIR));
// Serve uploaded entry images (Contributions/Courier attachments) securely
app.use('/uploads/entry-images', requireAuth, express.static(ENTRY_IMAGES_DIR));

// ---- Admin UI page (gated) — must come before the static file server below,
// since public/admin/index.html would otherwise be served to anyone. ----
app.get(["/", "/index.html"], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public/admin/index.html"));
});

// ---- Admin UI static assets (css/js/images — not sensitive on their own) ----
app.use(express.static(path.join(__dirname, "public/admin")));

db.ready
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ YWAM server running on http://localhost:${PORT}`);
      if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
        console.warn("⚠️ WARNING: No ADMIN_PASSWORD set in .env");
      }
      startScheduler();
    });
  })
  .catch((err) => {
    console.error("❌ Failed to start server — database not ready:", err);
    process.exit(1);
  });