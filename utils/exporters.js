// ---------------------------------------------------------------------
// Shared export helpers.
//
// Every "export" feature in the app (Deleted Entries, Courier, and any
// future list) needs the same three output formats: CSV, Excel (.xlsx),
// and PDF. Rather than re-implement table-building logic three times per
// feature, routes describe their data once as:
//
//   columns: [{ key: 'date', label: 'Date', align: 'left'|'right' }, ...]
//   rows:    [{ date: '2026-01-01', ... }, ...]
//
// and call one of the three build* functions below to get a Buffer/string
// ready to send as a download.
// ---------------------------------------------------------------------

const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");

// ---------- CSV ----------
function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCSV(columns, rows) {
  const lines = [];
  lines.push(columns.map((c) => csvEscape(c.label)).join(","));
  rows.forEach((row) => {
    lines.push(columns.map((c) => csvEscape(row[c.key])).join(","));
  });
  // Leading BOM so Excel opens UTF-8 (₹ symbol, etc.) correctly.
  return "\uFEFF" + lines.join("\n");
}

// ---------- Excel (.xlsx) ----------
function buildExcelBuffer(columns, rows, sheetName) {
  const data = rows.map((row) => {
    const obj = {};
    columns.forEach((c) => { obj[c.label] = row[c.key] ?? ""; });
    return obj;
  });
  const worksheet = XLSX.utils.json_to_sheet(data, {
    header: columns.map((c) => c.label),
  });
  // Reasonable column widths based on label/content length.
  worksheet["!cols"] = columns.map((c) => {
    const maxLen = Math.max(
      c.label.length,
      ...rows.map((r) => String(r[c.key] ?? "").length)
    );
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, (sheetName || "Sheet1").slice(0, 31));
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// ---------- PDF ----------
// Draws a simple paginated table: a title, generated-on stamp, and a table
// with a repeating header row. Column widths are proportional to the
// `width` weight given on each column (defaults to equal split).
//
// Alignment is kept consistent everywhere a table is drawn:
//  - every cell (header and body) is vertically centered on its row using
//    the actual font metrics, instead of a fixed nudge that only looked
//    right at one font size;
//  - font size scales down as columns pile up (e.g. the 19-column yearly
//    report) so text never overlaps or gets crushed against its neighbor;
//  - thin ruled borders around the outer table and between columns give
//    the grid a hard edge to align to, rather than relying on whitespace;
//  - a "Page X of Y" footer is stamped on every page once the total page
//    count is known.
function buildPDFBuffer({ title, subtitle, columns, rows }) {
  return new Promise((resolve, reject) => {
    try {
      const landscape = columns.length > 6;
      const margin = columns.length > 12 ? 28 : 40;
      const doc = new PDFDocument({
        margin,
        size: "A4",
        layout: landscape ? "landscape" : "portrait",
        bufferPages: true,
      });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const totalWeight = columns.reduce((s, c) => s + (c.width || 1), 0);
      const colWidths = columns.map((c) => (pageWidth * (c.width || 1)) / totalWeight);

      // More columns => smaller type, so cells never overlap.
      const cellFontSize = columns.length > 14 ? 7 : columns.length > 9 ? 7.75 : 8.5;
      const headerFontSize = cellFontSize + 0.25;
      const rowHeight = Math.round(cellFontSize * 2.35);
      const headerHeight = Math.round(headerFontSize * 2.55);
      const cellPadX = 5;

      doc.font("Helvetica-Bold").fontSize(16).text(title, { align: "left" });
      if (subtitle) {
        doc.moveDown(0.2);
        doc.font("Helvetica").fontSize(9).fillColor("#666").text(subtitle);
        doc.fillColor("#000");
      }
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(8).fillColor("#888")
        .text(`Generated ${new Date().toLocaleString()}`, { align: "left" });
      doc.fillColor("#000");
      doc.moveDown(0.6);

      // Vertically centers a single line of text of the given font size
      // within a band of `rowH` starting at `y`.
      function centeredY(y, rowH, fontSize) {
        return y + (rowH - fontSize) / 2 - 1;
      }

      // Draws the vertical rules between (and around) columns for the
      // band from y to y+height, so header + body cells share one grid.
      function drawColumnRules(y, height, onDark) {
        let x = doc.page.margins.left;
        doc.save();
        doc.lineWidth(0.5).strokeColor(onDark ? "#555" : "#d8d8d8");
        columns.forEach((c, i) => {
          if (i > 0) doc.moveTo(x, y).lineTo(x, y + height).stroke();
          x += colWidths[i];
        });
        doc.restore();
      }

      function drawHeader(y) {
        const left = doc.page.margins.left;
        doc.rect(left, y, pageWidth, headerHeight).fill("#2c2c2c");
        let x = left;
        doc.font("Helvetica-Bold").fontSize(headerFontSize).fillColor("#fff");
        columns.forEach((c, i) => {
          doc.text(c.label, x + cellPadX, centeredY(y, headerHeight, headerFontSize), {
            width: colWidths[i] - cellPadX * 2,
            align: c.align || "left",
            lineBreak: false,
            ellipsis: true,
          });
          x += colWidths[i];
        });
        doc.fillColor("#000");
        return y + headerHeight;
      }

      // Outer border + header underline for the block from y0 to y1.
      function drawTableFrame(y0, y1) {
        doc.save();
        doc.lineWidth(0.75).strokeColor("#c9c9c9");
        doc.rect(doc.page.margins.left, y0, pageWidth, y1 - y0).stroke();
        doc.restore();
      }

      let y = doc.y;
      let pageTop = y;
      y = drawHeader(y);
      drawColumnRules(pageTop, headerHeight, true);

      doc.font("Helvetica").fontSize(cellFontSize);
      rows.forEach((row, idx) => {
        if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 16) {
          drawTableFrame(pageTop, y);
          doc.addPage();
          y = doc.page.margins.top;
          pageTop = y;
          y = drawHeader(y);
          drawColumnRules(pageTop, headerHeight, true);
          doc.font("Helvetica").fontSize(cellFontSize);
        }
        if (idx % 2 === 1) {
          doc.rect(doc.page.margins.left, y, pageWidth, rowHeight).fill("#f5f5f5");
          doc.fillColor("#000");
        }
        let x = doc.page.margins.left;
        columns.forEach((c, i) => {
          const val = row[c.key];
          doc.text(val === null || val === undefined ? "" : String(val), x + cellPadX, centeredY(y, rowHeight, cellFontSize), {
            width: colWidths[i] - cellPadX * 2,
            align: c.align || "left",
            ellipsis: true,
            lineBreak: false,
          });
          x += colWidths[i];
        });
        drawColumnRules(y, rowHeight);
        doc.moveTo(doc.page.margins.left, y + rowHeight)
          .lineTo(doc.page.margins.left + pageWidth, y + rowHeight)
          .lineWidth(0.5).strokeColor("#e8e8e8").stroke();
        y += rowHeight;
      });

      if (!rows.length) {
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#888")
          .text("No records found.", doc.page.margins.left, y + 10);
        y += 26;
      }

      drawTableFrame(pageTop, y);

      // Stamp "Page X of Y" bottom-right on every page, now that the
      // total page count is known.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font("Helvetica").fontSize(7.5).fillColor("#999")
          .text(
            `Page ${i - range.start + 1} of ${range.count}`,
            doc.page.margins.left,
            doc.page.height - doc.page.margins.bottom + 6,
            { width: pageWidth, align: "right" }
          );
        doc.fillColor("#000");
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Sends the right format based on `?format=csv|xlsx|pdf` (defaults to csv).
// `meta` = { title, subtitle, columns, rows, filenameBase }
async function sendExport(req, res, meta) {
  const format = (req.query.format || "csv").toLowerCase();
  const base = meta.filenameBase || "export";

  try {
    if (format === "xlsx" || format === "excel") {
      const buf = buildExcelBuffer(meta.columns, meta.rows, meta.title);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.xlsx`);
      return res.send(buf);
    }
    if (format === "pdf") {
      const buf = await buildPDFBuffer(meta);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=${base}.pdf`);
      return res.send(buf);
    }
    // default: csv
    const csv = buildCSV(meta.columns, meta.rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${base}.csv`);
    return res.send(csv);
  } catch (err) {
    console.error(`❌ Export (${format}) failed:`, err);
    res.status(500).json({ error: "export_failed", message: err.message });
  }
}

module.exports = { buildCSV, buildExcelBuffer, buildPDFBuffer, sendExport };
