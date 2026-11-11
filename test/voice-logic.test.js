const test = require("node:test");
const assert = require("node:assert/strict");
const { Endpointer, matchWakeWord, toSpeakable, SentenceChunker } = require("../src/renderer/voice-logic");

const frame = (amplitude) => new Float32Array(1600).fill(amplitude);

function feed(endpointer, pattern) {
  // pattern: array of [amplitude, frameCount]
  const out = [];
  for (const [amp, count] of pattern) {
    for (let i = 0; i < count; i++) {
      const utterance = endpointer.push(frame(amp));
      if (utterance) out.push(utterance);
    }
  }
  return out;
}

test("endpointer returns one utterance with pre-roll after trailing silence", () => {
  const ep = new Endpointer();
  const out = feed(ep, [[0.001, 10], [0.1, 10], [0.001, 9]]);
  assert.equal(out.length, 1);
  // 10 loud + 9 quiet + 3 pre-roll frames (pre-roll includes the first 2 loud)
  const frames = out[0].length / 1600;
  assert.ok(frames >= 20 && frames <= 23, `got ${frames} frames`);
  assert.equal(ep.inSpeech, false);
});

test("endpointer ignores short clicks and steady background noise", () => {
  const ep = new Endpointer();
  assert.equal(feed(ep, [[0.001, 10], [0.2, 1], [0.001, 15]]).length, 0);
  assert.equal(feed(ep, [[0.001, 10], [0.2, 2], [0.001, 15]]).length, 0); // 200 ms < minSpeech
  assert.equal(feed(new Endpointer(), [[0.02, 200]]).length <= 1, true);
  // Quiet speech from a laptop microphone still registers.
  assert.equal(feed(new Endpointer(), [[0.0015, 10], [0.012, 8], [0.0015, 10]]).length, 1);
});

test("endpointer cuts very long speech at the cap", () => {
  const ep = new Endpointer({ maxMs: 2000 });
  const out = feed(ep, [[0.001, 5], [0.1, 60]]);
  assert.ok(out.length >= 2);
  assert.ok(out[0].length / 16000 <= 2.01);
});

test("wake word matches at the start only, with common greetings", () => {
  assert.deepEqual(matchWakeWord("Hey Nova, what's next?", "Nova"), { matched: true, command: "what's next?" });
  assert.deepEqual(matchWakeWord("nova remind me at 4", "Nova"), { matched: true, command: "remind me at 4" });
  assert.deepEqual(matchWakeWord("Nova.", "Nova"), { matched: true, command: "" });
  assert.equal(matchWakeWord("I watched a show about a nova", "Nova").matched, false);
  assert.equal(matchWakeWord("Novartis results are out", "Nova").matched, false);
  assert.equal(matchWakeWord("", "Nova").matched, false);
  assert.equal(matchWakeWord("Okay C.3 (beta) go", "C.3 (beta)").matched, true);
});

test("wake word tolerates the near misses speech recognition makes", () => {
  assert.deepEqual(matchWakeWord("Nora, what's on today?", "Nova"), { matched: true, command: "what's on today?" });
  assert.deepEqual(matchWakeWord("Hey Novah remind me at four", "Nova"), { matched: true, command: "remind me at four" });
  assert.deepEqual(matchWakeWord("No va, open the tracker", "Nova"), { matched: true, command: "open the tracker" });
  assert.deepEqual(matchWakeWord("Nov.", "Nova"), { matched: true, command: "" });
  // Two letters off, or the right word in the wrong place, is not a match.
  assert.equal(matchWakeWord("Noah called earlier", "Nova").matched, false);
  assert.equal(matchWakeWord("Never mind that", "Nova").matched, false);
  assert.equal(matchWakeWord("Tell Nora I said hi", "Nova").matched, false);
  // Very short names must match exactly.
  assert.equal(matchWakeWord("Max, hello", "Sam").matched, false);
});

test("toSpeakable strips markdown and links", () => {
  assert.equal(
    toSpeakable("## Plan\n- **First**, read [the doc](https://x.y/z)\n- then `run` it https://a.b"),
    "Plan First, read the doc then run it",
  );
});

test("sentence chunker emits whole sentences as text streams in", () => {
  const chunker = new SentenceChunker();
  const spoken = [];
  for (const delta of ["You have three meet", "ings today. The first is at ", "nine. Ok", "ay? Yes"]) {
    spoken.push(...chunker.push(delta));
  }
  assert.deepEqual(spoken, ["You have three meetings today.", "The first is at nine. Okay?"]);
  assert.deepEqual(chunker.flush(), ["Yes"]);
  assert.deepEqual(chunker.flush(), []);
});
