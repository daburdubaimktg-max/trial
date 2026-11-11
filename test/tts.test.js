const test = require("node:test");
const assert = require("node:assert/strict");
const { NeuralVoice, VOICES, DEFAULT_VOICE, MAX_CHARS } = require("../src/main/tts");
const { DEFAULT_SETTINGS } = require("../src/main/store");

test("voice list is well formed and the default setting points at a real voice", () => {
  assert.ok(VOICES.length >= 4);
  assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
  for (const v of VOICES) assert.match(v.id, /^[ab][fm]_[a-z]+$/);
  assert.equal(DEFAULT_SETTINGS.voice, `neural:${DEFAULT_VOICE}`);
});

/** A stand-in for the engine process that records what it is asked. */
function fakeEngine() {
  const { EventEmitter } = require("node:events");
  const forks = [];
  const fork = (script, args) => {
    const child = new EventEmitter();
    child.args = args;
    child.sent = [];
    child.postMessage = (msg) => child.sent.push(msg);
    child.kill = () => (child.killed = true);
    forks.push(child);
    return child;
  };
  return { fork, forks };
}

const reply = (engine, index, body) => engine.emit("message", { type: "result", id: engine.sent[index].id, ...body });

test("empty and oversized text is rejected before the engine is started", async () => {
  const { fork, forks } = fakeEngine();
  const voice = new NeuralVoice({ cacheDir: "/cache", fork });
  await assert.rejects(voice.synthesize("   ", DEFAULT_VOICE), /Nothing to say/);
  await assert.rejects(voice.synthesize("a".repeat(MAX_CHARS + 1), DEFAULT_VOICE), /longer than/);
  assert.equal(forks.length, 0);
});

test("requests are matched to replies, and unknown voices use the default", async () => {
  const { fork, forks } = fakeEngine();
  const statuses = [];
  const voice = new NeuralVoice({ cacheDir: "/cache", fork, onStatus: (s) => statuses.push(s.state) });
  const first = voice.synthesize("one", "bm_george");
  const second = voice.synthesize("two", "not_a_voice");
  const [engine] = forks;
  assert.equal(forks.length, 1);
  assert.deepEqual(engine.args, ["/cache"]);
  assert.deepEqual(engine.sent.map((m) => [m.text, m.voice]), [["one", "bm_george"], ["two", DEFAULT_VOICE]]);

  engine.emit("message", { type: "status", state: "loading", progress: 40 });
  // Replies arrive out of order.
  reply(engine, 1, { samples: new Float32Array(2), sampleRate: 24000 });
  reply(engine, 0, { error: "boom" });
  assert.equal((await second).sampleRate, 24000);
  await assert.rejects(first, /boom/);
  assert.deepEqual(statuses, ["loading"]);
});

test("if the engine dies, waiting requests fail and the next one starts a new engine", async () => {
  const { fork, forks } = fakeEngine();
  const voice = new NeuralVoice({ cacheDir: "/cache", fork });
  const doomed = voice.synthesize("one", DEFAULT_VOICE);
  forks[0].emit("exit", 139);
  await assert.rejects(doomed, /stopped unexpectedly/);

  const retry = voice.synthesize("two", DEFAULT_VOICE);
  assert.equal(forks.length, 2);
  reply(forks[1], 0, { samples: new Float32Array(1), sampleRate: 24000 });
  await retry;
  voice.dispose();
  assert.equal(forks[1].killed, true);
});
