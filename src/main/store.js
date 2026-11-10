// Local persistence: settings, long-term memory, and tasks.
// Everything lives as plain files in one data directory so it is easy to
// inspect, back up, or delete.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_SETTINGS = {
  assistantName: "Nova",
  userName: "",
  wakeWordEnabled: false,
  speakReplies: true,
  voiceName: "",
  calendarUrls: [],
  workspaceDir: "",
};

class Store {
  /**
   * @param {string} dir data directory
   * @param {{encrypt?: (s: string) => string, decrypt?: (s: string) => string}} [secrets]
   *   Optional OS-backed encryption for the API key. Without it the key is
   *   only ever read from the environment and never written to disk.
   */
  constructor(dir, secrets = {}) {
    this.dir = dir;
    this.secrets = secrets;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(name) {
    return path.join(this.dir, name);
  }

  readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return fallback;
      throw new Error(`Could not read ${name}: ${err.message}`);
    }
  }

  writeJson(name, value) {
    // Write-then-rename so a crash mid-write cannot corrupt the file.
    const tmp = this.file(`${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file(name));
  }

  // ---- settings ----------------------------------------------------------

  getSettings() {
    return { ...DEFAULT_SETTINGS, ...this.readJson("settings.json", {}) };
  }

  saveSettings(patch) {
    const next = { ...this.getSettings() };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    next.assistantName = String(next.assistantName).trim() || DEFAULT_SETTINGS.assistantName;
    next.calendarUrls = (next.calendarUrls || []).map((u) => String(u).trim()).filter(Boolean);
    this.writeJson("settings.json", next);
    return next;
  }

  // ---- API key -----------------------------------------------------------

  getApiKey() {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    if (!this.secrets.decrypt) return "";
    try {
      return this.secrets.decrypt(fs.readFileSync(this.file("api-key.enc"), "utf8"));
    } catch {
      return "";
    }
  }

  setApiKey(key) {
    if (!this.secrets.encrypt) {
      throw new Error("Secure storage is unavailable on this computer. Set the ANTHROPIC_API_KEY environment variable instead.");
    }
    const trimmed = String(key).trim();
    if (!trimmed) {
      fs.rmSync(this.file("api-key.enc"), { force: true });
      return;
    }
    fs.writeFileSync(this.file("api-key.enc"), this.secrets.encrypt(trimmed), { mode: 0o600 });
  }

  hasApiKey() {
    return Boolean(this.getApiKey());
  }

  // ---- long-term memory --------------------------------------------------

  getMemories() {
    return this.readJson("memory.json", []);
  }

  addMemory(text) {
    const memories = this.getMemories();
    const entry = { id: crypto.randomUUID().slice(0, 8), text: String(text).trim(), savedAt: new Date().toISOString() };
    memories.push(entry);
    this.writeJson("memory.json", memories);
    return entry;
  }

  deleteMemory(id) {
    const memories = this.getMemories();
    const next = memories.filter((m) => m.id !== id);
    if (next.length === memories.length) return false;
    this.writeJson("memory.json", next);
    return true;
  }

  // ---- tasks and reminders -----------------------------------------------

  getTasks() {
    return this.readJson("tasks.json", []);
  }

  addTask({ title, due = null, remindAt = null, notes = "" }) {
    const tasks = this.getTasks();
    const task = {
      id: crypto.randomUUID().slice(0, 8),
      title: String(title).trim(),
      due,
      remindAt,
      notes,
      done: false,
      reminded: false,
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    this.writeJson("tasks.json", tasks);
    return task;
  }

  updateTask(id, patch) {
    const tasks = this.getTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) return null;
    for (const key of ["title", "due", "remindAt", "notes", "done", "reminded"]) {
      if (patch[key] !== undefined) task[key] = patch[key];
    }
    // A rescheduled reminder should fire again.
    if (patch.remindAt !== undefined && patch.reminded === undefined) task.reminded = false;
    this.writeJson("tasks.json", tasks);
    return task;
  }

  deleteTask(id) {
    const tasks = this.getTasks();
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    this.writeJson("tasks.json", next);
    return true;
  }

  /** Reminders whose time has come; marks them so each fires once. */
  takeDueReminders(now = new Date()) {
    const tasks = this.getTasks();
    const due = tasks.filter(
      (t) => !t.done && !t.reminded && t.remindAt && new Date(t.remindAt).getTime() <= now.getTime(),
    );
    if (due.length === 0) return [];
    for (const task of due) task.reminded = true;
    this.writeJson("tasks.json", tasks);
    return due;
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
