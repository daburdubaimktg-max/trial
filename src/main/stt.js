// Speech-to-text that runs entirely on this computer (Whisper via ONNX).
// Audio never leaves the machine; only the resulting text goes to Claude.
// The model (~80 MB) is downloaded once on first use and cached.

const MODEL = "onnx-community/whisper-base.en";
const SAMPLE_RATE = 16000;
const MAX_SECONDS = 28; // Whisper's window is 30 s; utterances are capped below it.

class SpeechToText {
  /**
   * @param {string} cacheDir where to keep the downloaded model
   * @param {(status: {state: string, progress?: number}) => void} [onStatus]
   */
  constructor(cacheDir, onStatus = () => {}) {
    this.cacheDir = cacheDir;
    this.onStatus = onStatus;
    this.pipelinePromise = null;
  }

  load() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = this.cacheDir;
        this.onStatus({ state: "loading", progress: 0 });
        const asr = await pipeline("automatic-speech-recognition", MODEL, {
          dtype: "q8",
          progress_callback: (p) => {
            if (p.status === "progress" && p.file?.endsWith(".onnx") && Number.isFinite(p.progress)) {
              this.onStatus({ state: "loading", progress: Math.round(p.progress) });
            }
          },
        });
        this.onStatus({ state: "ready" });
        return asr;
      })().catch((err) => {
        this.pipelinePromise = null; // allow a retry after a failed download
        this.onStatus({ state: "error" });
        throw err;
      });
    }
    return this.pipelinePromise;
  }

  /** @param {Float32Array} samples mono PCM at 16 kHz */
  async transcribe(samples) {
    if (samples.length > MAX_SECONDS * SAMPLE_RATE) {
      throw new Error(`Recording is longer than ${MAX_SECONDS} seconds.`);
    }
    const asr = await this.load();
    const { text } = await asr(samples);
    // Whisper emits bracketed tags for non-speech, e.g. [BLANK_AUDIO] or (music).
    return text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();
  }
}

module.exports = { SpeechToText, SAMPLE_RATE, MAX_SECONDS };
