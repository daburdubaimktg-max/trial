const test = require("node:test");
const assert = require("node:assert/strict");
const { SpeechToText, MODELS, DEFAULT_MODEL, SAMPLE_RATE, MAX_SECONDS } = require("../src/main/stt");
const { DEFAULT_SETTINGS } = require("../src/main/store");

function setup(initial = "balanced") {
  const state = { key: initial, created: [], disposed: [], calls: [] };
  const stt = new SpeechToText({
    cacheDir: "/cache",
    getModelKey: () => state.key,
    createPipeline: async (id) => {
      state.created.push(id);
      const asr = async (samples, options) => {
        state.calls.push({ id, options });
        return { text: " Hello there [BLANK_AUDIO] (music) " };
      };
      asr.dispose = () => state.disposed.push(id);
      return asr;
    },
  });
  return { stt, state };
}

test("the default setting names a real model", () => {
  assert.ok(MODELS[DEFAULT_MODEL]);
  assert.equal(DEFAULT_SETTINGS.speechModel, DEFAULT_MODEL);
});

test("transcribes, strips non-speech tags, and loads the model once", async () => {
  const { stt, state } = setup();
  assert.equal(await stt.transcribe(new Float32Array(SAMPLE_RATE)), "Hello there");
  await stt.transcribe(new Float32Array(SAMPLE_RATE));
  assert.deepEqual(state.created, [MODELS.balanced.id]);
  assert.deepEqual(state.calls[0].options, {});
});

test("changing the accuracy setting swaps models and frees the old one", async () => {
  const { stt, state } = setup("fast");
  await stt.transcribe(new Float32Array(10));
  state.key = "best";
  await stt.transcribe(new Float32Array(10));
  assert.deepEqual(state.created, [MODELS.fast.id, MODELS.best.id]);
  assert.deepEqual(state.disposed, [MODELS.fast.id]);
  // The multilingual model is told to expect English.
  assert.deepEqual(state.calls[1].options, { language: "en", task: "transcribe" });
});

test("an unknown setting falls back to the default, and long audio is refused", async () => {
  const { stt, state } = setup("nonsense");
  await stt.transcribe(new Float32Array(10));
  assert.deepEqual(state.created, [MODELS[DEFAULT_MODEL].id]);
  await assert.rejects(stt.transcribe(new Float32Array(MAX_SECONDS * SAMPLE_RATE + 1)), /longer than/);
});

test("a failed download can be retried", async () => {
  let attempts = 0;
  const stt = new SpeechToText({
    cacheDir: "/cache",
    getModelKey: () => "fast",
    createPipeline: async () => {
      if (attempts++ === 0) throw new Error("network down");
      return async () => ({ text: "ok" });
    },
  });
  await assert.rejects(stt.transcribe(new Float32Array(10)), /network down/);
  assert.equal(await stt.transcribe(new Float32Array(10)), "ok");
});
