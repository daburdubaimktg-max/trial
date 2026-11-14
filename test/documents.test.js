const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/main/store");
const { createTools } = require("../src/main/tools");
const documents = require("../src/main/documents");

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nova-docs-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  const store = new Store(path.join(base, "data"));
  store.saveSettings({ workspaceDir: workspace });
  const confirms = [];
  const tools = createTools({
    store,
    openExternal: async () => {},
    openPath: async () => "",
    confirm: async (message, detail) => {
      confirms.push([message, detail]);
      return true;
    },
  });
  return { workspace, tools, confirms };
}

test("a spreadsheet is created, read back, and its formulas are real formulas", async () => {
  const { workspace, tools, confirms } = setup();
  const made = await tools.execute("create_spreadsheet", {
    path: "sales.xlsx",
    sheets: [
      { name: "Q3", rows: [["Brand", "Units", "Value"], ["Vatika", 1200, 5400.5], ["Amla", 800, 2100], ["Total", "=SUM(B2:B3)", "=SUM(C2:C3)"]] },
      { name: "Notes/2026", rows: [["Note"], ["Prices in AED"]] },
    ],
  });
  assert.deepEqual(made, { content: "Saved sales.xlsx.", isError: false });
  assert.match(confirms[0][1], /2 sheet\(s\), 6 rows/);

  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(workspace, "sales.xlsx"));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["Q3", "Notes 2026"]);
  assert.equal(wb.getWorksheet("Q3").getCell("B4").formula, "SUM(B2:B3)");
  assert.equal(wb.getWorksheet("Q3").getCell("A1").font.bold, true);

  const read = await tools.execute("read_file", { path: "sales.xlsx" });
  assert.equal(read.isError, false);
  assert.match(read.content, /Sheet "Q3": 4 rows x 3 columns/);
  assert.match(read.content, /2\tVatika\t1200\t5400\.5/);
  assert.match(read.content, /Prices in AED/);

  const range = await tools.execute("read_file", { path: "sales.xlsx", sheet: "q3", start_row: 3, end_row: 3 });
  assert.match(range.content, /rows 3-3\)\n3\tAmla\t800\t2100$/);
  const missing = await tools.execute("read_file", { path: "sales.xlsx", sheet: "Q9" });
  assert.match(missing.content, /No sheet named "Q9"\. Sheets: Q3, Notes 2026/);
});

test("a workbook too large for one read returns an outline, never a silent cut", async () => {
  const { workspace, tools } = setup();
  const rows = [["id", "text"]];
  for (let i = 1; i <= 9000; i++) rows.push([i, "x".repeat(50)]);
  await documents.writeSpreadsheet(path.join(workspace, "big.xlsx"), [{ name: "Data", rows }]);
  const read = await tools.execute("read_file", { path: "big.xlsx" });
  assert.match(read.content, /too large to read in one go, so only the first 30 rows/);
  assert.match(read.content, /Sheet "Data": 9001 rows x 2 columns/);
  assert.equal(read.content.includes("\n31\t"), false);
  const tail = await tools.execute("read_file", { path: "big.xlsx", start_row: 9000, end_row: 9001 });
  assert.match(tail.content, /9001\t9000\t/);
});

test("a deck with bullets, table, chart and notes is created and read back", async () => {
  const { workspace, tools } = setup();
  const made = await tools.execute("create_presentation", {
    path: "decks/review.pptx",
    title: "Q3 Brand Review",
    subtitle: "Hair care, GCC",
    slides: [
      { title: "Vatika grew 12% & led the category", bullets: ["Share up 1.4 pts", "KSA drove growth"], notes: "Mention Ramadan timing." },
      { title: "Sales by market", table: [["Market", "Units"], ["UAE", 1200], ["KSA", 3400]] },
      { title: "Trend", bullets: ["Steady climb"], chart: { type: "bar", categories: ["Jul", "Aug", "Sep"], series: [{ name: "Units", values: [10, 12, 15] }] } },
    ],
  });
  assert.equal(made.isError, false, made.content);

  const read = await tools.execute("read_file", { path: "decks/review.pptx" });
  assert.match(read.content, /--- Slide 1 ---\nQ3 Brand Review\nHair care, GCC/);
  assert.match(read.content, /--- Slide 2 ---\nVatika grew 12% & led the category\nShare up 1\.4 pts\nKSA drove growth\n\[Speaker notes\] Mention Ramadan timing\./);
  assert.match(read.content, /Sales by market\nMarket\tUnits\nUAE\t1200\nKSA\t3400/);
  assert.match(read.content, /--- Slide 4 ---\nTrend/);

  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(workspace, "decks/review.pptx")));
  assert.ok(Object.keys(zip.files).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)), "chart part exists");
});

test("chart series must match the categories", async () => {
  const { tools } = setup();
  const res = await tools.execute("create_presentation", {
    path: "bad.pptx",
    title: "x",
    slides: [{ title: "t", chart: { type: "pie", categories: ["a", "b"], series: [{ name: "s", values: [1] }] } }],
  });
  assert.equal(res.isError, true);
  assert.match(res.content, /one value per category/);
});

test("a Word document is created and read back", async () => {
  const { tools } = setup();
  const made = await tools.execute("create_document", {
    path: "brief.docx",
    title: "Campaign brief",
    blocks: [
      { heading: "Objective" },
      { paragraph: "Grow Amla share among women 25-40." },
      { bullets: ["TV", "Social"] },
      { table: [["Channel", "Budget"], ["TV", 500000]] },
    ],
  });
  assert.equal(made.isError, false, made.content);
  const read = await tools.execute("read_file", { path: "brief.docx" });
  for (const text of ["Campaign brief", "Objective", "Grow Amla share among women 25-40.", "Social", "500000"]) {
    assert.ok(read.content.includes(text), `missing ${text}`);
  }
});

test("a PDF's text is read page by page", async () => {
  const { workspace, tools } = setup();
  // A minimal hand-built one-page PDF.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 100 Td (Offtake grew 8 percent) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(workspace, "report.pdf"), pdf, "latin1");

  const read = await tools.execute("read_file", { path: "report.pdf" });
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /--- Page 1 ---\nOfftake grew 8 percent/);
});

test("Office tools enforce the extension, the workspace, and plain text for write_file", async () => {
  const { tools } = setup();
  assert.match((await tools.execute("create_spreadsheet", { path: "x.csv", sheets: [{ name: "a", rows: [] }] })).content, /must end in \.xlsx/);
  assert.match((await tools.execute("create_document", { path: "../x.docx", title: "t", blocks: [{ paragraph: "p" }] })).content, /outside the workspace/);
  assert.match((await tools.execute("write_file", { path: "x.xlsx", content: "a,b" })).content, /only writes plain text/);
  assert.match((await tools.execute("read_file", { path: "nope.xlsx" })).content, /nope\.xlsx|no such file/i);
});
