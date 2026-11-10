// Electron main process: owns the window, the data, and everything that
// touches the network or the file system. The interface (renderer) only
// talks to it through the narrow API in preload.js.

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, session, Notification } = require("electron");
const path = require("node:path");
const { Store } = require("./store");
const { createTools } = require("./tools");
const { Agent } = require("./agent");
const { SpeechToText } = require("./stt");
const calendar = require("./calendar");

const REMINDER_CHECK_MS = 20_000;

/** @type {BrowserWindow | null} */
let win = null;
let store, agent, stt;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function snapshot() {
  return {
    settings: store.getSettings(),
    hasApiKey: store.hasApiKey(),
    keyFromEnv: Boolean(process.env.ANTHROPIC_API_KEY),
    tasks: store.getTasks(),
    memories: store.getMemories(),
  };
}

function setUp() {
  const dataDir = process.env.NOVA_DATA_DIR || path.join(app.getPath("userData"), "data");
  const canEncrypt = safeStorage.isEncryptionAvailable();
  store = new Store(
    dataDir,
    canEncrypt
      ? {
          encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
          decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
        }
      : {},
  );

  const tools = createTools({
    store,
    openExternal: (url) => shell.openExternal(url),
    openPath: (file) => shell.openPath(file),
    confirm: async (message, detail) => {
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Allow", "Don't allow"],
        defaultId: 0,
        cancelId: 1,
        message,
        detail,
      });
      return response === 0;
    },
    onDataChanged: () => send("data:changed", snapshot()),
  });
  agent = new Agent({ store, tools });
  stt = new SpeechToText(path.join(dataDir, "models"), (status) => send("stt:status", status));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#070b12",
    title: "Nova",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // The window only ever shows the local interface; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("closed", () => {
    win = null;
  });
}

function registerIpc() {
  ipcMain.handle("state:get", () => snapshot());

  ipcMain.handle("settings:save", (_e, { patch, apiKey }) => {
    store.saveSettings(patch ?? {});
    if (typeof apiKey === "string") store.setApiKey(apiKey);
    return snapshot();
  });

  ipcMain.handle("settings:pickWorkspace", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Choose a folder the assistant may read and write",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("chat:send", (_e, { text, spoken }) =>
    agent.send(String(text), { spoken: Boolean(spoken), onEvent: (event) => send("chat:event", event) }),
  );
  ipcMain.handle("chat:cancel", () => agent.cancel());
  ipcMain.handle("chat:reset", () => agent.reset());

  ipcMain.handle("stt:load", () => stt.load().then(() => true));
  ipcMain.handle("stt:transcribe", (_e, samples) => stt.transcribe(new Float32Array(samples)));

  ipcMain.handle("tasks:setDone", (_e, { id, done }) => {
    store.updateTask(id, { done: Boolean(done) });
    return snapshot();
  });
  ipcMain.handle("tasks:delete", (_e, id) => {
    store.deleteTask(id);
    return snapshot();
  });
  ipcMain.handle("memory:delete", (_e, id) => {
    store.deleteMemory(id);
    return snapshot();
  });

  ipcMain.handle("agenda:today", async () => {
    const urls = store.getSettings().calendarUrls;
    if (urls.length === 0) return { connected: false, events: [], errors: [] };
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { connected: true, ...(await calendar.getEvents(urls, from, to)) };
  });
}

function startReminders() {
  setInterval(() => {
    const due = store.takeDueReminders();
    if (due.length === 0) return;
    for (const task of due) {
      if (Notification.isSupported()) {
        new Notification({ title: `${store.getSettings().assistantName}: reminder`, body: task.title }).show();
      }
      send("reminder", task);
    }
    send("data:changed", snapshot());
  }, REMINDER_CHECK_MS);
}

app.whenReady().then(() => {
  setUp();

  // Only the app's own page may use the microphone; nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "media" && webContents.getURL().startsWith("file://"));
  });

  registerIpc();
  createWindow();
  startReminders();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
