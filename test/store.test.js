const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/main/store");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nova-store-"));

test("settings merge with defaults and ignore unknown keys", () => {
  const store = new Store(tmp());
  assert.equal(store.getSettings().assistantName, "Nova");
  const saved = store.saveSettings({ assistantName: "  Atlas ", calendarUrls: [" https://a/x.ics ", ""], bogus: 1 });
  assert.equal(saved.assistantName, "Atlas");
  assert.deepEqual(saved.calendarUrls, ["https://a/x.ics"]);
  assert.equal("bogus" in saved, false);
  assert.equal(new Store(store.dir).getSettings().assistantName, "Atlas");
});

test("blank assistant name falls back to the default", () => {
  const store = new Store(tmp());
  assert.equal(store.saveSettings({ assistantName: "   " }).assistantName, "Nova");
});

test("API key is encrypted on disk and refused without secure storage", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const plain = new Store(tmp());
    assert.throws(() => plain.setApiKey("sk-ant-x"), /Secure storage/);
    assert.equal(plain.hasApiKey(), false);

    const secure = new Store(tmp(), {
      encrypt: (s) => Buffer.from(s).toString("hex"),
      decrypt: (s) => Buffer.from(s, "hex").toString(),
    });
    secure.setApiKey(" sk-ant-secret ");
    assert.equal(secure.getApiKey(), "sk-ant-secret");
    assert.equal(fs.readFileSync(secure.file("api-key.enc"), "utf8").includes("sk-ant"), false);
    secure.setApiKey("");
    assert.equal(secure.hasApiKey(), false);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("memories can be added and deleted", () => {
  const store = new Store(tmp());
  const m = store.addMemory("Prefers short emails");
  assert.equal(store.getMemories().length, 1);
  assert.equal(store.deleteMemory("nope"), false);
  assert.equal(store.deleteMemory(m.id), true);
  assert.deepEqual(store.getMemories(), []);
});

test("reminders fire once, and again after being rescheduled", () => {
  const store = new Store(tmp());
  const now = new Date("2026-11-10T10:00:00Z");
  const past = store.addTask({ title: "Call supplier", remindAt: "2026-11-10T09:59:00Z" });
  store.addTask({ title: "Later", remindAt: "2026-11-10T11:00:00Z" });
  const done = store.addTask({ title: "Done already", remindAt: "2026-11-10T09:00:00Z" });
  store.updateTask(done.id, { done: true });

  assert.deepEqual(store.takeDueReminders(now).map((t) => t.title), ["Call supplier"]);
  assert.deepEqual(store.takeDueReminders(now), []);

  store.updateTask(past.id, { remindAt: "2026-11-10T09:59:30Z" });
  assert.equal(store.takeDueReminders(now).length, 1);
});

test("a corrupt data file is reported instead of silently reset", () => {
  const store = new Store(tmp());
  fs.writeFileSync(store.file("tasks.json"), "{not json");
  assert.throws(() => store.getTasks(), /Could not read tasks.json/);
});
