// The only bridge between the interface and the main process.
const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("nova", {
  getState: () => ipcRenderer.invoke("state:get"),
  saveSettings: (patch, apiKey) => ipcRenderer.invoke("settings:save", { patch, apiKey }),
  pickWorkspace: () => ipcRenderer.invoke("settings:pickWorkspace"),

  send: (text, spoken) => ipcRenderer.invoke("chat:send", { text, spoken }),
  cancel: () => ipcRenderer.invoke("chat:cancel"),
  reset: () => ipcRenderer.invoke("chat:reset"),

  loadSpeech: () => ipcRenderer.invoke("stt:load"),
  transcribe: (samples) => ipcRenderer.invoke("stt:transcribe", samples),

  loadVoice: () => ipcRenderer.invoke("tts:load"),
  synthesize: (text, voice) => ipcRenderer.invoke("tts:synthesize", { text, voice }),

  setTaskDone: (id, done) => ipcRenderer.invoke("tasks:setDone", { id, done }),
  deleteTask: (id) => ipcRenderer.invoke("tasks:delete", id),
  deleteMemory: (id) => ipcRenderer.invoke("memory:delete", id),
  todayAgenda: () => ipcRenderer.invoke("agenda:today"),

  onChatEvent: on("chat:event"),
  onDataChanged: on("data:changed"),
  onReminder: on("reminder"),
  onSpeechStatus: on("stt:status"),
  onVoiceStatus: on("tts:status"),
});
