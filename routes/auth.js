const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  // API/data routes get a JSON 401 so the frontend's fetch handling can
  // react (e.g. redirect to login); page loads get redirected directly.
  if (req.originalUrl.startsWith("/api/") || req.originalUrl.startsWith("/admin/")) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  return res.redirect("/login.html");
}

router.post("/api/login", async (req, res) => {
  const { password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const plain = process.env.ADMIN_PASSWORD;

  let ok = false;
  if (hash) {
    ok = await bcrypt.compare(password || "", hash);
  } else if (plain) {
    ok = password === plain;
  } else {
    // No password configured at all — refuse to run insecurely.
    return res.status(500).json({ error: "server_not_configured" });
  }

  if (!ok) return res.status(401).json({ error: "invalid_password" });

  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/api/session", (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

module.exports = { router, requireAuth };
