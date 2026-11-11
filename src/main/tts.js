// Natural-sounding speech generated on this computer (Kokoro, an open
// neural voice model). Nothing is sent anywhere; the model (~90 MB) is
// downloaded once on first use.

const path = require("node:path");

const ENGINE_SCRIPT = path.join(__dirname, "tts-process.js");

// A short list of the model's better-rated English voices.
const VOICES = [
  { id: "af_heart", label: "Heart (US, female)" },
  { id: "af_bella", label: "Bella (US, female)" },
  { id: "af_nicole", label: "Nicole (US, female)" },
  { id: "am_michael", label: "Michael (US, male)" },
  { id: "am_fenrir", label: "Fenrir (US, male)" },
  { id: "am_puck", label: "Puck (US, male)" },
  { id: "bf_emma", label: "Emma (British, female)" },
  { id: "bf_isabella", label: "Isabella (British, female)" },
  { id: "bm_george", label: "George (British, male)" },
  { id: "bm_fable", label: "Fable (British, male)" },
];
const DEFAULT_VOICE = VOICES[0].id;
const MAX_CHARS = 1000;

class NeuralVoice {
  /**
   * @param {object} deps
   * @param {string} deps.cacheDir where to keep the downloaded model
   * @param {(script: string, args: string[]) => object} deps.fork starts the
   *   engine process; in the app this is Electron's utilityProcess.fork
   * @param {(status: {state: string, progress?: number}) => void} [deps.onStatus]
   */
  constructor({ cacheDir, fork, onStatus = () => {} }) {
    this.cacheDir = cacheDir;
    this.fork = fork;
    this.onStatus = onStatus;
    this.engine = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  #ensureEngine() {
    if (this.engine) return this.engine;
    const engine = this.fork(ENGINE_SCRIPT, [this.cacheDir]);
    engine.on("message", (msg) => {
      if (msg.type === "status") return this.onStatus(msg);
      const request = this.pending.get(msg.id);
      if (!request) return;
      this.pending.delete(msg.id);
      if (msg.error) request.reject(new Error(msg.error));
      else request.resolve(msg);
    });
    engine.on("exit", () => {
      if (this.engine !== engine) return; // we shut it down ourselves
      this.engine = null; // a fresh engine starts on next use
      for (const { reject } of this.pending.values()) reject(new Error("The voice engine stopped unexpectedly."));
      this.pending.clear();
    });
    this.engine = engine;
    return engine;
  }

  #request(payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#ensureEngine().postMessage({ id, ...payload });
    });
  }

  async load() {
    await this.#request({ action: "load" });
    this.onStatus({ state: "ready" });
  }

  /** @returns {Promise<{samples: Float32Array, sampleRate: number}>} */
  async synthesize(text, voice) {
    const clean = String(text).trim();
    if (!clean) throw new Error("Nothing to say.");
    if (clean.length > MAX_CHARS) throw new Error(`Text is longer than ${MAX_CHARS} characters.`);
    const voiceId = VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE;
    const { samples, sampleRate } = await this.#request({ action: "speak", text: clean, voice: voiceId });
    return { samples, sampleRate };
  }

  dispose() {
    const engine = this.engine;
    this.engine = null;
    engine?.kill();
  }
}

module.exports = { NeuralVoice, VOICES, DEFAULT_VOICE, MAX_CHARS };
