const express = require("express");
const fs = require("fs");
const path = require("path");
const { uid, nowISO } = require("../utils/helpers");

// entryType values currently supported by the UI: 'transaction' | 'courier'.
// Kept generic (not hardcoded to a single table) so any future entry type
// can reuse the same upload/list/delete endpoints.
const ALLOWED_ENTRY_TYPES = new Set(["transaction", "courier"]);

module.exports = (db, uploadImages, imagesDir) => {
  const router = express.Router();

  function assertType(req, res) {
    if (!ALLOWED_ENTRY_TYPES.has(req.params.entryType)) {
      res.status(400).json({ error: "invalid_entry_type" });
      return false;
    }
    return true;
  }

  // POST /api/entries/:entryType/:entryId/images — upload up to 10 images
  router.post(
    "/api/entries/:entryType/:entryId/images",
    (req, res, next) => (assertType(req, res) ? next() : null),
    uploadImages.array("images", 10),
    async (req, res) => {
      const { entryType, entryId } = req.params;
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "no_files" });

      try {
        const saved = [];
        for (const file of files) {
          const id = uid();
          await db.prepare(`
            INSERT INTO entry_images (id, entry_type, entry_id, filename, original_name, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(id, entryType, entryId, file.filename, file.originalname, nowISO());
          saved.push({ id, entry_type: entryType, entry_id: entryId, filename: file.filename, original_name: file.originalname });
        }
        res.json({ ok: true, images: saved });
      } catch (err) {
        console.error("❌ Error saving entry images:", err);
        res.status(500).json({ error: err.message });
      }
    }
  );

  // GET /api/entries/:entryType/:entryId/images — list
  router.get("/api/entries/:entryType/:entryId/images", async (req, res) => {
    if (!assertType(req, res)) return;
    const { entryType, entryId } = req.params;
    try {
      const rows = await db.prepare(`
        SELECT * FROM entry_images WHERE entry_type = ? AND entry_id = ? ORDER BY uploaded_at DESC
      `).all(entryType, entryId);
      res.json(rows.map((r) => ({ ...r, url: `/uploads/entry-images/${r.filename}` })));
    } catch (err) {
      console.error("❌ Error listing entry images:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/entries/:entryType/:entryId/images/:imageId/download — forces
  // a download with the original filename (the static /uploads route is
  // used for inline previews instead).
  router.get("/api/entries/:entryType/:entryId/images/:imageId/download", async (req, res) => {
    if (!assertType(req, res)) return;
    const { entryType, entryId, imageId } = req.params;
    try {
      const row = await db.prepare(`
        SELECT * FROM entry_images WHERE id = ? AND entry_type = ? AND entry_id = ?
      `).get(imageId, entryType, entryId);
      if (!row) return res.status(404).json({ error: "not_found" });
      const filePath = path.join(imagesDir, row.filename);
      res.download(filePath, row.original_name || row.filename);
    } catch (err) {
      console.error("❌ Error downloading entry image:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/entries/:entryType/:entryId/images/:imageId
  router.delete("/api/entries/:entryType/:entryId/images/:imageId", async (req, res) => {
    if (!assertType(req, res)) return;
    const { entryType, entryId, imageId } = req.params;
    try {
      const row = await db.prepare(`
        SELECT * FROM entry_images WHERE id = ? AND entry_type = ? AND entry_id = ?
      `).get(imageId, entryType, entryId);
      if (!row) return res.status(404).json({ error: "not_found" });

      await db.prepare("DELETE FROM entry_images WHERE id = ?").run(imageId);

      const filePath = path.join(imagesDir, row.filename);
      fs.unlink(filePath, (err) => {
        if (err && err.code !== "ENOENT") console.error("⚠️ Could not remove image file:", err.message);
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Error deleting entry image:", err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
