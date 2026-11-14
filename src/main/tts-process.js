// Runs the neural voice model in its own process (an Electron utility
// process) so synthesis never stalls the app and a fault in the model's
// native code cannot take the app down with it.

const parentPort = process.parentPort;
const cacheDir = process.argv[2];

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let ttsPromise = null;

function load() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { env } = await import("@huggingface/transformers");
      env.cacheDir = cacheDir;
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(MODEL, {
        dtype: "q8",
        device: "cpu",
        progress_callback: (p) => {
          if (p.status === "progress" && p.file?.endsWith(".onnx") && Number.isFinite(p.progress)) {
            parentPort.postMessage({ type: "status", state: "loading", progress: Math.round(p.progress) });
          }
        },
      });
    })();
    ttsPromise.catch(() => {
      ttsPromise = null; // allow a retry after a failed download
    });
  }
  return ttsPromise;
}

parentPort.on("message", async ({ data: { id, action, text, voice } }) => {
  try {
    const tts = await load();
    if (action === "load") {
      parentPort.postMessage({ type: "result", id });
      return;
    }
    const audio = await tts.generate(text, { voice });
    parentPort.postMessage({ type: "result", id, samples: audio.audio, sampleRate: audio.sampling_rate });
  } catch (err) {
    parentPort.postMessage({ type: "result", id, error: err.message || String(err) });
  }
});
