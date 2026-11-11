// The interface: conversation view, the orb, the side panel, and the glue
// between voice input, the assistant, and spoken replies.

/* global VoiceLogic, Voice */

const $ = (id) => document.getElementById(id);
const api = window.nova;

const FOLLOW_UP_MS = 8000; // after a reply, listen without needing the wake word
const AGENDA_REFRESH_MS = 5 * 60 * 1000;

const TOOL_LABELS = {
  web_search: "Searching the web",
  web_fetch: "Reading a page",
  get_calendar_events: "Checking your calendar",
  add_task: "Adding a task",
  list_tasks: "Looking at your tasks",
  update_task: "Updating a task",
  delete_task: "Removing a task",
  remember: "Saving to memory",
  forget: "Updating memory",
  open_url: "Opening the browser",
  list_files: "Looking in your workspace",
  read_file: "Reading a file",
  write_file: "Writing a file",
  open_file: "Opening a file",
};

const state = {
  settings: null,
  hasApiKey: false,
  keyFromEnv: false,
  tasks: [],
  memories: [],
  mode: "idle", // idle | listening | transcribing | thinking | speaking
  oneShot: false, // the orb was clicked: take the next phrase as a command
  followUpUntil: 0,
  turn: null, // the assistant message being streamed
  speechReady: false,
  level: 0,
};

// ---- small DOM helpers ---------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline formatting (**bold**, `code`, [links](https://…)) as safe DOM nodes. */
function appendInline(parent, text) {
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    if (match[2] !== undefined) parent.append(el("strong", "", match[2]));
    else if (match[3] !== undefined) parent.append(el("code", "", match[3]));
    else {
      const link = el("a", "", match[4]);
      link.href = match[5];
      link.target = "_blank";
      link.rel = "noreferrer";
      parent.append(link);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** A small, safe subset of markdown: paragraphs, bullet lists, headings. */
function renderMarkdown(container, text) {
  container.replaceChildren();
  let list = null;
  let paragraph = null;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (bullet) {
      paragraph = null;
      if (!list) container.append((list = el("ul")));
      appendInline(list.appendChild(el("li")), bullet[1]);
    } else if (heading) {
      list = paragraph = null;
      appendInline(container.appendChild(el("p")).appendChild(el("strong")), heading[1]);
    } else if (line.trim() === "") {
      list = paragraph = null;
    } else {
      list = null;
      if (!paragraph) container.append((paragraph = el("p")));
      else paragraph.append(" ");
      appendInline(paragraph, line);
    }
  }
}

// ---- conversation view ---------------------------------------------------

const messagesEl = $("messages");

function scrollToEnd() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showEmptyState() {
  const name = state.settings.assistantName;
  const box = el("div", "empty");
  box.append(el("h1", "", state.settings.userName ? `Hello, ${state.settings.userName}.` : "Hello."));
  box.append(el("div", "", `I'm ${name}. Talk to me or type below.`));
  const suggestions = el("div", "suggestions");
  for (const text of [
    "What's on my plate today?",
    "Remind me to send the weekly report at 4pm",
    "Research the latest news in my industry",
  ]) {
    const button = el("button", "", text);
    button.type = "button";
    button.addEventListener("click", () => submit(text, false));
    suggestions.append(button);
  }
  box.append(suggestions);
  messagesEl.replaceChildren(box);
}

function addMessage(kind, text) {
  messagesEl.querySelector(".empty")?.remove();
  const node = el("div", `msg ${kind}`, text);
  messagesEl.append(node);
  scrollToEnd();
  return node;
}

function startAssistantMessage() {
  const node = addMessage("assistant");
  const steps = node.appendChild(el("div", "steps"));
  const body = node.appendChild(el("div", "body"));
  body.append(el("span", "typing"));
  return { node, steps, body, text: "", renderQueued: false, seenTools: new Set() };
}

function queueRender(turn) {
  if (turn.renderQueued) return;
  turn.renderQueued = true;
  requestAnimationFrame(() => {
    turn.renderQueued = false;
    renderMarkdown(turn.body, turn.text);
    scrollToEnd();
  });
}

// ---- status and orb ------------------------------------------------------

const STATUS_TEXT = {
  idle: "Ready",
  listening: "Listening",
  transcribing: "Got it",
  thinking: "Thinking",
  speaking: "Speaking",
};

function wakeListening() {
  return state.settings?.wakeWordEnabled && mic.active;
}

function setMode(mode) {
  state.mode = mode;
  $("status").textContent = STATUS_TEXT[mode];
  const busy = mode === "thinking" || mode === "speaking";
  $("sendButton").textContent = busy ? "Stop" : "Send";
  $("sendButton").classList.toggle("stop", busy);
  // Never listen while the assistant is working or talking, so it cannot
  // hear its own voice.
  mic.setPaused(busy || mode === "transcribing");
  updateHint();
}

function updateHint(custom) {
  const name = state.settings?.assistantName ?? "Nova";
  let hint = "Click the orb and speak";
  if (custom) hint = custom;
  else if (state.mode === "listening") hint = "Go ahead, I'm listening";
  else if (state.mode === "thinking" || state.mode === "speaking") hint = "Click the orb to interrupt";
  else if (wakeListening()) hint = `Say “${name}” followed by what you need`;
  $("hint").textContent = hint;
}

const orbCanvas = $("orb");
const orbCtx = orbCanvas.getContext("2d");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let smoothLevel = 0;

function drawOrb(timeMs) {
  const t = reducedMotion ? 0 : timeMs / 1000;
  const size = orbCanvas.width;
  const c = size / 2;
  const mode = state.mode;

  let target = state.level;
  if (mode === "speaking") target = 0.35 + 0.3 * Math.abs(Math.sin(t * 7) * Math.sin(t * 2.3));
  if (mode === "thinking") target = 0.25;
  smoothLevel += (target - smoothLevel) * 0.18;

  const hue = mode === "thinking" ? 255 : mode === "listening" ? 165 : 192;
  const speed = mode === "thinking" ? 2.4 : mode === "idle" ? 0.25 : 0.8;
  const core = size * (0.17 + smoothLevel * 0.07);

  orbCtx.clearRect(0, 0, size, size);

  const glow = orbCtx.createRadialGradient(c, c, core * 0.2, c, c, size * 0.48);
  glow.addColorStop(0, `hsla(${hue}, 100%, 72%, ${0.55 + smoothLevel * 0.4})`);
  glow.addColorStop(0.35, `hsla(${hue}, 95%, 55%, 0.16)`);
  glow.addColorStop(1, "hsla(0, 0%, 0%, 0)");
  orbCtx.fillStyle = glow;
  orbCtx.fillRect(0, 0, size, size);

  orbCtx.beginPath();
  orbCtx.arc(c, c, core, 0, Math.PI * 2);
  const fill = orbCtx.createRadialGradient(c - core * 0.3, c - core * 0.3, core * 0.1, c, c, core);
  fill.addColorStop(0, `hsl(${hue}, 100%, 88%)`);
  fill.addColorStop(1, `hsl(${hue}, 90%, 52%)`);
  orbCtx.fillStyle = fill;
  orbCtx.fill();

  // Rotating arcs around the core.
  const rings = [
    { r: 0.27, width: 5, span: 1.5, dir: 1, alpha: 0.9 },
    { r: 0.33, width: 2, span: 2.4, dir: -1.4, alpha: 0.55 },
    { r: 0.39, width: 3, span: 0.9, dir: 0.7, alpha: 0.7 },
    { r: 0.44, width: 1.5, span: 3.6, dir: -0.5, alpha: 0.35 },
  ];
  orbCtx.lineCap = "round";
  rings.forEach((ring, i) => {
    const radius = size * ring.r * (1 + smoothLevel * 0.06 * (i + 1));
    const angle = t * speed * ring.dir + i * 1.7;
    orbCtx.strokeStyle = `hsla(${hue}, 100%, 70%, ${ring.alpha})`;
    orbCtx.lineWidth = ring.width;
    for (let k = 0; k < 2; k++) {
      orbCtx.beginPath();
      orbCtx.arc(c, c, radius, angle + k * Math.PI, angle + k * Math.PI + ring.span);
      orbCtx.stroke();
    }
  });

  requestAnimationFrame(drawOrb);
}

// ---- voice ---------------------------------------------------------------

const speaker = new Voice.Speaker({
  synthesize: (text, voiceId) => api.synthesize(text, voiceId),
  onSpeakingChange: (speaking) => {
    if (speaking) setMode("speaking");
    else if (state.mode === "speaking") afterReply();
  },
  onError: (error) =>
    addMessage("notice", `The built-in voice isn't available (${error.message}). Using the system voice for now.`),
});

/** Load the neural voice in the background so the first reply isn't delayed. */
function warmUpVoice() {
  if (state.settings.speakReplies && state.settings.voice.startsWith("neural:")) {
    api.loadVoice().catch(() => {}); // a failure is reported when speech is attempted
  }
}

const mic = new Voice.Microphone({
  onLevel: (level) => (state.level = level),
  onSpeechStart: () => {
    if (state.oneShot || Date.now() < state.followUpUntil) setMode("listening");
  },
  onUtterance: (samples) => handleUtterance(samples),
});

async function ensureSpeechReady() {
  if (state.speechReady) return true;
  updateHint("Preparing speech recognition (one-time download)…");
  try {
    await api.loadSpeech();
    state.speechReady = true;
    return true;
  } catch (err) {
    addMessage("error", `Speech recognition could not start: ${err.message}`);
    return false;
  } finally {
    updateHint();
  }
}

async function startMic() {
  if (mic.active) return true;
  if (!(await ensureSpeechReady())) return false;
  try {
    await mic.start();
    return true;
  } catch (err) {
    addMessage("error", `I couldn't use the microphone: ${err.message}. Check that a microphone is connected and allowed.`);
    return false;
  }
}

function stopMicUnlessWake() {
  if (!state.settings.wakeWordEnabled) mic.stop();
}

async function handleUtterance(samples) {
  const direct = state.oneShot || Date.now() < state.followUpUntil;
  if (!direct && !state.settings.wakeWordEnabled) return;

  if (direct) setMode("transcribing");
  let text = "";
  try {
    text = await api.transcribe(samples);
  } catch (err) {
    if (direct) addMessage("error", `I couldn't make that out: ${err.message}`);
  }

  if (direct) {
    state.oneShot = false;
    state.followUpUntil = 0;
    stopMicUnlessWake();
    if (text) return submit(text, true);
    setMode("idle");
    return;
  }

  // Wake-word mode: act only when the phrase starts with the assistant's name.
  const { matched, command } = VoiceLogic.matchWakeWord(text, state.settings.assistantName);
  if (!matched) return;
  if (command) return submit(command, true);
  // Just the name: wait for the request itself.
  state.followUpUntil = Date.now() + FOLLOW_UP_MS;
  setMode("listening");
}

/** Called when a reply (and any speech) has finished. */
function afterReply() {
  setMode("idle");
  if (wakeListening()) state.followUpUntil = Date.now() + FOLLOW_UP_MS;
}

// ---- talking to the assistant -------------------------------------------

async function submit(text, spoken) {
  text = text.trim();
  if (!text) return;
  if (state.turn) await interrupt();

  addMessage("user", text);
  const turn = (state.turn = startAssistantMessage());
  const chunker = state.settings.speakReplies ? new VoiceLogic.SentenceChunker() : null;
  turn.chunker = chunker;
  setMode("thinking");

  const result = await api.send(text, spoken);
  if (state.turn !== turn) return; // superseded by a newer message

  state.turn = null;
  turn.body.querySelector(".typing")?.remove();
  if (turn.text) renderMarkdown(turn.body, turn.text);

  if (result.status === "error") {
    if (!turn.text) turn.node.remove();
    addMessage("error", result.message);
  } else if (result.status === "cancelled") {
    if (!turn.text) turn.node.remove();
  } else if (chunker) {
    chunker.flush().forEach((sentence) => speaker.say(sentence));
  }
  if (!speaker.speaking) afterReply();
}

async function interrupt() {
  speaker.stop();
  const turn = state.turn;
  state.turn = null;
  if (turn) {
    turn.body.querySelector(".typing")?.remove();
    if (!turn.text) turn.node.remove();
    await api.cancel();
  }
  setMode("idle");
}

api.onChatEvent((event) => {
  const turn = state.turn;
  if (!turn) return;
  if (event.type === "text") {
    turn.text += event.delta;
    queueRender(turn);
    turn.chunker?.push(event.delta).forEach((sentence) => speaker.say(sentence));
  } else if (event.type === "tool") {
    if (turn.seenTools.has(event.name)) return;
    turn.seenTools.add(event.name);
    turn.steps.append(el("span", "step", TOOL_LABELS[event.name] ?? event.name));
    scrollToEnd();
  } else if (event.type === "notice") {
    addMessage("notice", event.message);
  }
});

// ---- side panel ----------------------------------------------------------

const timeFormat = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat([], { weekday: "short", day: "numeric", month: "short" });

function describeWhen(iso) {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? `today ${timeFormat.format(date)}` : `${dayFormat.format(date)} ${timeFormat.format(date)}`;
}

function removeButton(label, onClick) {
  const button = el("button", "remove", "×");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function renderTasks() {
  const box = $("tasks");
  const open = state.tasks.filter((t) => !t.done);
  if (open.length === 0) {
    box.replaceChildren(el("div", "none", "Nothing on your list."));
    return;
  }
  open.sort((a, b) => (a.due ?? a.remindAt ?? "9").localeCompare(b.due ?? b.remindAt ?? "9"));
  box.replaceChildren(
    ...open.map((task) => {
      const item = el("div", "item");
      const check = el("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", `Mark “${task.title}” done`);
      check.addEventListener("change", async () => applyState(await api.setTaskDone(task.id, true)));
      const body = el("div", "body", task.title);
      const when = task.due ?? task.remindAt;
      if (when) {
        const overdue = new Date(when) < new Date();
        const prefix = task.due ? "Due" : "Reminder";
        body.append(el("span", `meta${overdue ? " overdue" : ""}`, `${prefix} ${describeWhen(when)}`));
      }
      item.append(
        check,
        body,
        removeButton(`Delete “${task.title}”`, async () => applyState(await api.deleteTask(task.id))),
      );
      return item;
    }),
  );
}

function renderMemories() {
  const box = $("memories");
  if (state.memories.length === 0) {
    box.replaceChildren(el("div", "none", "Things I learn about you will appear here."));
    return;
  }
  box.replaceChildren(
    ...state.memories.map((memory) => {
      const item = el("div", "item");
      item.append(
        el("div", "body", memory.text),
        removeButton("Forget this", async () => applyState(await api.deleteMemory(memory.id))),
      );
      return item;
    }),
  );
}

async function refreshAgenda() {
  const box = $("agenda");
  let agenda;
  try {
    agenda = await api.todayAgenda();
  } catch (err) {
    box.replaceChildren(el("div", "none", `Calendar unavailable: ${err.message}`));
    return;
  }
  if (!agenda.connected) {
    box.replaceChildren(el("div", "none", "Add a calendar link in Settings to see your day."));
    return;
  }
  const nodes = agenda.events.map((event) => {
    const item = el("div", "item");
    item.append(el("div", "time", event.allDay ? "all day" : timeFormat.format(new Date(event.start))));
    const body = el("div", "body", event.title);
    if (event.location) body.append(el("span", "meta", event.location));
    item.append(body);
    return item;
  });
  if (nodes.length === 0 && agenda.errors.length === 0) nodes.push(el("div", "none", "No meetings today."));
  for (const error of agenda.errors) nodes.push(el("div", "none", `Couldn't load ${error}`));
  box.replaceChildren(...nodes);
}

// ---- settings ------------------------------------------------------------

function applyState(next) {
  Object.assign(state, next);
  const name = state.settings.assistantName;
  document.title = name;
  $("brandName").textContent = name;
  $("wakeLabel").textContent = `Listen for “${name}”`;
  $("wakeToggle").checked = state.settings.wakeWordEnabled;
  $("speakToggle").checked = state.settings.speakReplies;
  speaker.voice = state.settings.voice;
  renderTasks();
  renderMemories();
  updateHint();
}

function fillVoices() {
  const select = $("voiceSelect");
  const neural = el("optgroup");
  neural.label = "Built-in natural voices";
  for (const voice of state.neuralVoices) neural.append(new Option(voice.label, `neural:${voice.id}`));
  const system = el("optgroup");
  system.label = "System voices";
  system.append(new Option("System default", "system:"));
  for (const voice of speaker.systemVoices()) {
    system.append(new Option(`${voice.name} (${voice.lang})`, `system:${voice.name}`));
  }
  select.replaceChildren(neural, system);
  select.value = state.settings.voice;
  // The saved voice may no longer exist (a system voice was uninstalled).
  if (select.value !== state.settings.voice) select.value = `neural:${state.neuralVoices[0].id}`;
}

function openSettings() {
  const s = state.settings;
  $("apiKeyInput").value = "";
  $("apiKeyInput").disabled = state.keyFromEnv;
  $("apiKeyInput").placeholder = state.keyFromEnv
    ? "Set outside the app"
    : state.hasApiKey
      ? "Saved. Type a new key to replace it"
      : "sk-ant-…";
  $("apiKeyNote").textContent = state.keyFromEnv
    ? "Using the key from the ANTHROPIC_API_KEY environment variable."
    : "Stored encrypted on this computer and sent only to Anthropic.";
  $("assistantNameInput").value = s.assistantName;
  $("userNameInput").value = s.userName;
  $("calendarInput").value = s.calendarUrls.join("\n");
  $("workspaceInput").value = s.workspaceDir;
  $("settingsError").hidden = true;
  fillVoices();
  $("settingsDialog").showModal();
}

async function saveSettings(patch, apiKey) {
  applyState(await api.saveSettings(patch, apiKey));
}

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const apiKey = $("apiKeyInput").value.trim();
  try {
    await saveSettings(
      {
        assistantName: $("assistantNameInput").value,
        userName: $("userNameInput").value.trim(),
        voice: $("voiceSelect").value,
        calendarUrls: $("calendarInput").value.split("\n"),
        workspaceDir: $("workspaceInput").value,
      },
      apiKey || undefined,
    );
  } catch (err) {
    $("settingsError").textContent = err.message;
    $("settingsError").hidden = false;
    return;
  }
  $("settingsDialog").close();
  warmUpVoice();
  refreshAgenda();
  if (!messagesEl.querySelector(".msg")) showEmptyState();
});

$("settingsCancel").addEventListener("click", () => {
  speaker.stop();
  speaker.voice = state.settings.voice; // undo any preview
  $("settingsDialog").close();
});

$("previewVoiceButton").addEventListener("click", () => {
  speaker.stop();
  speaker.voice = $("voiceSelect").value;
  const name = $("assistantNameInput").value.trim() || state.settings.assistantName;
  speaker.say(`Hello, I'm ${name}. This is how I sound.`);
});
$("settingsButton").addEventListener("click", openSettings);
$("pickWorkspaceButton").addEventListener("click", async () => {
  const dir = await api.pickWorkspace();
  if (dir) $("workspaceInput").value = dir;
});

// ---- controls ------------------------------------------------------------

$("orbButton").addEventListener("click", async () => {
  if (state.mode === "thinking" || state.mode === "speaking") return interrupt();
  if (state.oneShot) {
    state.oneShot = false;
    stopMicUnlessWake();
    return setMode("idle");
  }
  if (!(await startMic())) return;
  state.oneShot = true;
  setMode("listening");
});

$("wakeToggle").addEventListener("change", async (event) => {
  const enabled = event.target.checked;
  if (enabled && !(await startMic())) {
    event.target.checked = false;
    return;
  }
  await saveSettings({ wakeWordEnabled: enabled });
  if (!enabled && !state.oneShot) mic.stop();
  updateHint();
});

$("speakToggle").addEventListener("change", async (event) => {
  if (!event.target.checked) speaker.stop();
  await saveSettings({ speakReplies: event.target.checked });
  warmUpVoice();
});

$("briefButton").addEventListener("click", () => submit("Give me my briefing for today.", false));

$("newChatButton").addEventListener("click", async () => {
  await interrupt();
  await api.reset();
  showEmptyState();
});

const input = $("input");

function autoGrow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value;
  if (!text.trim()) {
    if (state.mode === "thinking" || state.mode === "speaking") interrupt();
    return;
  }
  input.value = "";
  autoGrow();
  submit(text, false);
});

// ---- events from the main process ---------------------------------------

api.onDataChanged(applyState);

api.onReminder((task) => {
  addMessage("notice", `Reminder: ${task.title}`);
  if (state.settings.speakReplies && state.mode === "idle") speaker.say(`Reminder: ${task.title}`);
});

api.onSpeechStatus((status) => {
  if (status.state === "loading") {
    updateHint(`Preparing speech recognition (one-time download)… ${status.progress ?? 0}%`);
  } else {
    updateHint();
  }
});

api.onVoiceStatus((status) => {
  if (status.state === "loading") updateHint(`Preparing the voice (one-time download)… ${status.progress ?? 0}%`);
  else updateHint();
});

// ---- start ---------------------------------------------------------------

(async function init() {
  applyState(await api.getState());
  showEmptyState();
  setMode("idle");
  requestAnimationFrame(drawOrb);
  refreshAgenda();
  setInterval(refreshAgenda, AGENDA_REFRESH_MS);
  setInterval(renderTasks, 60_000); // keep "overdue" markers current
  if (typeof speechSynthesis !== "undefined") speechSynthesis.addEventListener("voiceschanged", fillVoices);

  warmUpVoice();
  if (!state.hasApiKey) openSettings();
  if (state.settings.wakeWordEnabled && !(await startMic())) {
    await saveSettings({ wakeWordEnabled: false });
  }
})();
