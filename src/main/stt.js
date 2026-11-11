// Speech-to-text that runs entirely on this computer (Whisper via ONNX).
// Audio never leaves the machine; only the resulting text goes to Claude.
// The chosen model is downloaded once on first use and cached.

const SAMPLE_RATE = 16000;
const MAX_SECONDS = 28; // Whisper's window is 30 s; utterances are capped below it.

// Bigger models mishear fewer words (especially names and accents) but take
// longer per phrase and are a larger one-time download.
const MODELS = {
  fast: { id: "onnx-community/whisper-base.en", label: "Fast (80 MB)", multilingual: false },
  balanced: { id: "onnx-community/whisper-small.en", label: "Balanced (240 MB)", multilingual: false },
  best: { id: "onnx-community/whisper-large-v3-turbo", label: "Most accurate (1.1 GB, slower)", multilingual: true },
};
const DEFAULT_MODEL = "balanced";

class SpeechToText {
  /**
   * @param {object} deps
   * @param {string} deps.cacheDir where to keep downloaded models
   * @param {() => string} deps.getModelKey current choice: a key of MODELS
   * @param {(status: {state: string, progress?: number}) => void} [deps.onStatus]
   * @param {(modelId: string, options: object) => Promise<Function>} [deps.createPipeline] injectable for tests
   */
  constructor({ cacheDir, getModelKey, onStatus = () => {}, createPipeline }) {
    this.cacheDir = cacheDir;
    this.getModelKey = getModelKey;
    this.onStatus = onStatus;
    this.createPipeline = createPipeline ?? this.#defaultPipeline.bind(this);
    this.loaded = null; // { key, promise }
  }

  async #defaultPipeline(modelId, options) {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = this.cacheDir;
    return pipeline("automatic-speech-recognition", modelId, options);
  }

  load() {
    const key = MODELS[this.getModelKey()] ? this.getModelKey() : DEFAULT_MODEL;
    if (this.loaded?.key === key) return this.loaded.promise;

    const previous = this.loaded;
    const promise = (async () => {
      // Free the old model before loading another; they can be large.
      if (previous) await previous.promise.then(({ asr }) => asr.dispose?.()).catch(() => {});
      this.onStatus({ state: "loading", progress: 0 });
      const asr = await this.createPipeline(MODELS[key].id, {
        dtype: "q8",
        progress_callback: (p) => {
          if (p.status === "progress" && p.file?.endsWith(".onnx") && Number.isFinite(p.progress)) {
            this.onStatus({ state: "loading", progress: Math.round(p.progress) });
          }
        },
      });
      this.onStatus({ state: "ready" });
      return { asr, multilingual: MODELS[key].multilingual };
    })();
    this.loaded = { key, promise };
    promise.catch(() => {
      if (this.loaded?.promise === promise) this.loaded = null; // allow a retry after a failed download
      this.onStatus({ state: "error" });
    });
    return promise;
  }

  /** @param {Float32Array} samples mono PCM at 16 kHz */
  async transcribe(samples) {
    if (samples.length > MAX_SECONDS * SAMPLE_RATE) {
      throw new Error(`Recording is longer than ${MAX_SECONDS} seconds.`);
    }
    const { asr, multilingual } = await this.load();
    const options = multilingual ? { language: "en", task: "transcribe" } : {};
    const { text } = await asr(samples, options);
    // Whisper emits bracketed tags for non-speech, e.g. [BLANK_AUDIO] or (music).
    return text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();
  }
}

module.exports = { SpeechToText, MODELS, DEFAULT_MODEL, SAMPLE_RATE, MAX_SECONDS };
