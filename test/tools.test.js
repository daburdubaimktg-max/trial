const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/main/store");
const { createTools } = require("../src/main/tools");

function setup({ approve = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nova-tools-"));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(base, "secret.txt"), "outside");
  const store = new Store(path.join(base, "data"));
  store.saveSettings({ workspaceDir: workspace });
  const calls = { opened: [], confirms: [], changed: 0 };
  const tools = createTools({
    store,
    openExternal: async (url) => calls.opened.push(url),
    openPath: async () => "",
    confirm: async (message) => {
      calls.confirms.push(message);
      return approve;
    },
    onDataChanged: () => calls.changed++,
  });
  return { base, workspace, store, tools, calls };
}

test("definitions are valid Claude tool schemas", () => {
  const { tools } = setup();
  for (const def of tools.definitions) {
    assert.match(def.name, /^[a-z_]+$/);
    assert.equal(def.input_schema.type, "object");
    assert.equal("$schema" in def.input_schema, false);
    assert.ok(def.description.length > 20);
  }
  const addTask = tools.definitions.find((d) => d.name === "add_task");
  assert.deepEqual(addTask.input_schema.required, ["title"]);
});

test("invalid input and unknown tools become error results, not exceptions", async () => {
  const { tools } = setup();
  assert.equal((await tools.execute("add_task", {})).isError, true);
  assert.equal((await tools.execute("add_task", { title: "x", remind_at: "next tuesday" })).isError, true);
  assert.equal((await tools.execute("nope", {})).isError, true);
});

test("task tools round-trip through the store", async () => {
  const { tools, store, calls } = setup();
  const added = await tools.execute("add_task", { title: "Send report", remind_at: "2026-11-12T16:00:00+04:00" });
  assert.equal(added.isError, false);
  const { id } = JSON.parse(added.content);
  assert.equal(store.getTasks()[0].remindAt, "2026-11-12T16:00:00+04:00");

  await tools.execute("update_task", { id, done: true });
  assert.equal((await tools.execute("list_tasks", {})).content, "No tasks.");
  assert.match((await tools.execute("list_tasks", { include_done: true })).content, /Send report/);
  assert.equal((await tools.execute("delete_task", { id })).content, "Deleted.");
  assert.ok(calls.changed >= 3);
});

test("memory tools save and forget", async () => {
  const { tools, store } = setup();
  const res = await tools.execute("remember", { fact: "Manager is Priya" });
  const id = res.content.match(/id (\w+)/)[1];
  assert.equal(store.getMemories()[0].text, "Manager is Priya");
  await tools.execute("forget", { id });
  assert.deepEqual(store.getMemories(), []);
});

test("file tools cannot leave the workspace", async () => {
  const { tools, workspace, base } = setup();
  fs.writeFileSync(path.join(workspace, "notes.md"), "hello");
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(workspace, "link.txt"));

  assert.equal((await tools.execute("read_file", { path: "notes.md" })).content, "hello");
  for (const bad of ["../secret.txt", path.join(base, "secret.txt"), "link.txt"]) {
    const res = await tools.execute("read_file", { path: bad });
    assert.equal(res.isError, true, bad);
    assert.match(res.content, /outside the workspace/);
  }
  const write = await tools.execute("write_file", { path: "../evil.txt", content: "x" });
  assert.equal(write.isError, true);
  assert.equal(fs.existsSync(path.join(base, "evil.txt")), false);
});

test("write_file asks first and respects a refusal", async () => {
  const denied = setup({ approve: false });
  const res = await denied.tools.execute("write_file", { path: "draft.md", content: "hi" });
  assert.match(res.content, /declined/);
  assert.equal(fs.existsSync(path.join(denied.workspace, "draft.md")), false);

  const allowed = setup();
  await allowed.tools.execute("write_file", { path: "out/draft.md", content: "hi" });
  assert.equal(fs.readFileSync(path.join(allowed.workspace, "out/draft.md"), "utf8"), "hi");
  assert.deepEqual(allowed.calls.confirms, ["Create out/draft.md?"]);
});

test("read_file refuses oversized and binary files", async () => {
  const { tools, workspace } = setup();
  fs.writeFileSync(path.join(workspace, "big.txt"), "a".repeat(400_001));
  fs.writeFileSync(path.join(workspace, "img.bin"), Buffer.from([1, 0, 2]));
  assert.match((await tools.execute("read_file", { path: "big.txt" })).content, /too large/);
  assert.match((await tools.execute("read_file", { path: "img.bin" })).content, /cannot be read/);
});

test("file tools explain when no workspace is set", async () => {
  const { tools, store } = setup();
  store.saveSettings({ workspaceDir: "" });
  assert.match((await tools.execute("list_files", {})).content, /No workspace folder/);
});

test("open_url only opens web links", async () => {
  const { tools, calls } = setup();
  assert.equal((await tools.execute("open_url", { url: "file:///etc/passwd" })).isError, true);
  assert.equal((await tools.execute("open_url", { url: "https://example.com/a" })).isError, false);
  assert.deepEqual(calls.opened, ["https://example.com/a"]);
});

test("calendar tool reports when nothing is connected", async () => {
  const { tools } = setup();
  const res = await tools.execute("get_calendar_events", { from: "2026-11-10T00:00:00Z", to: "2026-11-11T00:00:00Z" });
  assert.match(res.content, /No calendar is connected/);
});
