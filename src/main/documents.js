// Office and PDF support: turn Excel, Word, PowerPoint and PDF files into
// text Claude can read, and build real .xlsx, .pptx and .docx files from
// structured content.

const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_TEXT_CHARS = 400_000; // about 100k tokens; larger reads must be narrowed
const SHEET_PREVIEW_ROWS = 30;

const READABLE = new Set([".xlsx", ".xlsm", ".docx", ".pptx", ".pdf"]);

function isDocument(file) {
  return READABLE.has(path.extname(file).toLowerCase());
}

// ---- reading -------------------------------------------------------------

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return cellText(value.result); // formula: show the computed value
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value) return String(value.text); // hyperlink
    if ("error" in value) return String(value.error);
    return "";
  }
  if (typeof value === "number") return String(Math.round(value * 1e6) / 1e6);
  return String(value).replace(/[\t\r\n]+/g, " ");
}

function sheetRows(sheet, from, to) {
  const lines = [];
  for (let r = from; r <= to; r++) {
    const row = sheet.getRow(r);
    const cells = [];
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(cellText(row.getCell(c).value));
    lines.push(`${r}\t${cells.join("\t").replace(/\t+$/, "")}`);
  }
  return lines.join("\n");
}

/**
 * Excel as tab-separated text, one block per sheet, each line prefixed with
 * its row number. When the whole workbook is too big, returns an outline
 * (sizes plus the first rows of each sheet) and says how to ask for more.
 */
async function readSpreadsheet(file, { sheet: sheetName, startRow, endRow } = {}) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheets = workbook.worksheets;
  if (sheets.length === 0) return "The workbook has no sheets.";

  const describe = (s) => `Sheet "${s.name}": ${s.rowCount} rows x ${s.columnCount} columns`;

  if (sheetName || startRow || endRow) {
    const target = sheetName ? sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase()) : sheets[0];
    if (!target) {
      throw new Error(`No sheet named "${sheetName}". Sheets: ${sheets.map((s) => s.name).join(", ")}`);
    }
    const from = Math.max(1, startRow ?? 1);
    const to = Math.min(target.rowCount, endRow ?? target.rowCount);
    const text = `${describe(target)} (rows ${from}-${to})\n${sheetRows(target, from, to)}`;
    if (text.length > MAX_TEXT_CHARS) {
      throw new Error(
        `Rows ${from}-${to} of "${target.name}" are too much to read at once. Ask for a smaller range with start_row and end_row.`,
      );
    }
    return text;
  }

  const full = sheets.map((s) => `${describe(s)}\n${sheetRows(s, 1, s.rowCount)}`).join("\n\n");
  if (full.length <= MAX_TEXT_CHARS) return full;

  const outline = sheets
    .map((s) => `${describe(s)}\n${sheetRows(s, 1, Math.min(s.rowCount, SHEET_PREVIEW_ROWS))}`)
    .join("\n\n");
  return `This workbook is too large to read in one go, so only the first ${SHEET_PREVIEW_ROWS} rows of each sheet are shown. Call read_file again with sheet, start_row and end_row to read specific ranges.\n\n${outline}`;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

/** Text of a slide's XML: one line per paragraph, table rows tab-separated. */
function xmlText(xml) {
  const paragraphs = (fragment) =>
    fragment
      .replace(/<a:br\/>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
  const text = xml
    .replace(/>\s+</g, "><") // indentation between tags is not content
    .replace(/<a:tc[ >].*?<\/a:tc>/gs, (cell) => `${paragraphs(cell).trim().replace(/\n+/g, " ")}\t`)
    .replace(/\t?<\/a:tr>/g, "\n");
  return decodeEntities(paragraphs(text))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}

/** PowerPoint text slide by slide, including speaker notes. */
async function readPresentation(file) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const slideNumber = (name) => Number(name.match(/(\d+)\.xml$/)[1]);
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (slides.length === 0) return "The presentation has no slides.";

  const parts = [];
  for (const name of slides) {
    const n = slideNumber(name);
    let block = `--- Slide ${n} ---\n${xmlText(await zip.file(name).async("string")) || "(no text)"}`;
    const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    if (notes) {
      // Notes pages repeat the slide number as a lone digit; drop it.
      const text = xmlText(await notes.async("string")).replace(/^\d+$/gm, "").trim();
      if (text) block += `\n[Speaker notes] ${text}`;
    }
    parts.push(block);
  }
  return parts.join("\n\n");
}

async function readWord(file) {
  const mammoth = require("mammoth");
  const { value } = await mammoth.extractRawText({ path: file });
  return value.replace(/\n{3,}/g, "\n\n").trim() || "The document has no text.";
}

async function readPdf(file) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(await fs.readFile(file)));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((page, i) => `--- Page ${i + 1} ---\n${page.trim()}`);
  if (text.every((page) => page.trim() === "")) {
    return `This PDF has ${totalPages} pages but no selectable text (it is probably a scan), so it cannot be read.`;
  }
  return pages.join("\n\n");
}

/** Read any supported document as text. */
async function readDocument(file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  let text;
  if (ext === ".xlsx" || ext === ".xlsm") return readSpreadsheet(file, options);
  if (ext === ".pptx") text = await readPresentation(file);
  else if (ext === ".docx") text = await readWord(file);
  else if (ext === ".pdf") text = await readPdf(file);
  else throw new Error(`Unsupported file type: ${ext}`);

  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(
      `This file has about ${text.length.toLocaleString()} characters of text, over the ${MAX_TEXT_CHARS.toLocaleString()} limit for one read. Tell the user it is too long to read in one go.`,
    );
  }
  return text;
}

// ---- writing -------------------------------------------------------------

const BRAND = { ink: "1B2A41", accent: "0B7FAB", muted: "5B6B7F", light: "EEF3F8" };

/** @param {{name: string, rows: (string|number|boolean|null)[][]}[]} sheets */
async function writeSpreadsheet(file, sheets) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  for (const { name, rows } of sheets) {
    // Excel sheet names: max 31 chars, none of \ / ? * [ ] :
    const sheet = workbook.addWorksheet(name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
    for (const row of rows) {
      sheet.addRow(
        row.map((cell) => (typeof cell === "string" && cell.startsWith("=") ? { formula: cell.slice(1) } : cell)),
      );
    }
    if (rows.length > 0) {
      const header = sheet.getRow(1);
      header.font = { bold: true, color: { argb: "FFFFFFFF" } };
      header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${BRAND.ink}` } };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
    }
    sheet.columns.forEach((column) => {
      let width = 8;
      column.eachCell({ includeEmpty: false }, (cell) => {
        width = Math.max(width, Math.min(60, cellText(cell.value).length + 2));
      });
      column.width = width;
    });
  }
  await workbook.xlsx.writeFile(file);
}

/**
 * @param {object} deck
 * @param {string} deck.title
 * @param {string} [deck.subtitle]
 * @param {{title: string, bullets?: string[], table?: (string|number)[][],
 *   chart?: {type: "bar"|"line"|"pie", categories: string[], series: {name: string, values: number[]}[]},
 *   notes?: string}[]} deck.slides
 */
async function writePresentation(file, { title, subtitle, slides }) {
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  pptx.title = title;

  const cover = pptx.addSlide();
  cover.background = { color: BRAND.ink };
  cover.addText(title, { x: 0.8, y: 2.4, w: 11.7, h: 1.5, fontSize: 40, bold: true, color: "FFFFFF" });
  if (subtitle) cover.addText(subtitle, { x: 0.8, y: 3.9, w: 11.7, h: 0.8, fontSize: 20, color: "C9D6E5" });

  for (const spec of slides) {
    const slide = pptx.addSlide();
    slide.addText(spec.title, { x: 0.6, y: 0.35, w: 12.1, h: 0.9, fontSize: 28, bold: true, color: BRAND.ink });
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.25, w: 1.2, h: 0.06, fill: { color: BRAND.accent } });

    const visual = spec.chart || spec.table;
    const hasBullets = spec.bullets && spec.bullets.length > 0;
    // Bullets take the left side when there is also a chart or table.
    const textWidth = visual && hasBullets ? 5.2 : 12.1;
    const visualBox = hasBullets ? { x: 6.2, y: 1.6, w: 6.5, h: 5.2 } : { x: 0.6, y: 1.6, w: 12.1, h: 5.2 };

    if (hasBullets) {
      slide.addText(
        spec.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.6, y: 1.6, w: textWidth, h: 5.2, fontSize: 18, color: BRAND.ink, valign: "top", paraSpaceAfter: 8 },
      );
    }

    if (spec.chart) {
      const kind = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie }[spec.chart.type];
      const data = spec.chart.series.map((s) => ({ name: s.name, labels: spec.chart.categories, values: s.values }));
      slide.addChart(kind, data, {
        ...visualBox,
        showLegend: spec.chart.series.length > 1 || spec.chart.type === "pie",
        legendPos: "b",
        chartColors: [BRAND.accent, BRAND.ink, "F2A541", "7BB662", "C4553D", "8E6BBF"],
        catAxisLabelFontSize: 12,
        valAxisLabelFontSize: 12,
      });
    } else if (spec.table && spec.table.length > 0) {
      const rows = spec.table.map((row, r) =>
        row.map((cell) => ({
          text: String(cell ?? ""),
          options:
            r === 0
              ? { bold: true, color: "FFFFFF", fill: { color: BRAND.ink } }
              : { color: BRAND.ink, fill: { color: r % 2 ? "FFFFFF" : BRAND.light } },
        })),
      );
      slide.addTable(rows, { x: visualBox.x, y: visualBox.y, w: visualBox.w, fontSize: 16, border: { type: "solid", color: "D5DEE8", pt: 0.5 } });
    }

    if (spec.notes) slide.addNotes(spec.notes);
  }
  await pptx.writeFile({ fileName: file });
}

/**
 * @param {object} doc
 * @param {string} doc.title
 * @param {({heading: string} | {paragraph: string} | {bullets: string[]} | {table: (string|number)[][]})[]} doc.blocks
 */
async function writeWord(file, { title, blocks }) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType } = require("docx");
  const children = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const block of blocks) {
    if (block.heading) children.push(new Paragraph({ text: block.heading, heading: HeadingLevel.HEADING_1 }));
    else if (block.paragraph) children.push(new Paragraph({ text: block.paragraph, spacing: { after: 160 } }));
    else if (block.bullets) {
      for (const text of block.bullets) children.push(new Paragraph({ text, bullet: { level: 0 } }));
    } else if (block.table && block.table.length > 0) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.table.map(
            (row, r) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [new Paragraph({ children: [new TextRun({ text: String(cell ?? ""), bold: r === 0 })] })],
                    }),
                ),
              }),
          ),
        }),
        new Paragraph({ text: "" }),
      );
    }
  }
  const doc = new Document({ sections: [{ children }] });
  await fs.writeFile(file, await Packer.toBuffer(doc));
}

module.exports = { isDocument, readDocument, writeSpreadsheet, writePresentation, writeWord, MAX_TEXT_CHARS };
