// Pure voice logic with no browser dependencies, so it can be unit-tested
// in Node and loaded by the interface as a plain script.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VoiceLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const SAMPLE_RATE = 16000;

  function rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return Math.sqrt(sum / (frame.length || 1));
  }

  /**
   * Finds where a spoken phrase starts and ends in a stream of audio frames
   * using loudness relative to a slowly adapting background-noise estimate.
   */
  class Endpointer {
    constructor({
      frameMs = 100,
      startFrames = 2, // consecutive loud frames that begin an utterance
      endSilenceMs = 900, // quiet time that ends it
      minSpeechMs = 300,
      maxMs = 25000,
      preRollMs = 300, // audio kept from just before speech started
      minThreshold = 0.012,
      noiseRatio = 3,
    } = {}) {
      this.frameMs = frameMs;
      this.startFrames = startFrames;
      this.endSilenceFrames = Math.ceil(endSilenceMs / frameMs);
      this.minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
      this.maxFrames = Math.ceil(maxMs / frameMs);
      this.preRollFrames = Math.ceil(preRollMs / frameMs);
      this.minThreshold = minThreshold;
      this.noiseRatio = noiseRatio;
      this.noise = minThreshold / noiseRatio;
      this.reset();
    }

    reset() {
      this.inSpeech = false;
      this.frames = [];
      this.preRoll = [];
      this.loudRun = 0;
      this.quietRun = 0;
      this.loudFrames = 0;
    }

    /**
     * @param {Float32Array} frame
     * @returns {Float32Array | null} the full utterance once it has ended
     */
    push(frame) {
      const level = rms(frame);
      const threshold = Math.max(this.minThreshold, this.noise * this.noiseRatio);
      const loud = level > threshold;

      if (!this.inSpeech) {
        // Track background noise only while nobody is talking.
        this.noise = this.noise * 0.95 + Math.min(level, threshold) * 0.05;
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames + this.startFrames) this.preRoll.shift();
        this.loudRun = loud ? this.loudRun + 1 : 0;
        if (this.loudRun >= this.startFrames) {
          this.inSpeech = true;
          this.frames = this.preRoll.slice();
          this.loudFrames = this.loudRun;
          this.quietRun = 0;
          this.preRoll = [];
        }
        return null;
      }

      this.frames.push(frame);
      if (loud) {
        this.loudFrames++;
        this.quietRun = 0;
      } else {
        this.quietRun++;
      }

      const ended = this.quietRun >= this.endSilenceFrames || this.frames.length >= this.maxFrames;
      if (!ended) return null;

      const frames = this.frames;
      const enoughSpeech = this.loudFrames >= this.minSpeechFrames;
      this.reset();
      if (!enoughSpeech) return null; // a click or cough, not a phrase

      const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
      let offset = 0;
      for (const f of frames) {
        out.set(f, offset);
        offset += f.length;
      }
      return out;
    }
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Looks for the assistant's name near the start of what was heard.
   * "Hey Nova, what's next?" -> { matched: true, command: "what's next?" }
   */
  function matchWakeWord(transcript, name) {
    const text = String(transcript).trim();
    const wake = String(name).trim();
    if (!text || !wake) return { matched: false, command: "" };
    const pattern = new RegExp(
      `^(?:(?:hey|hi|ok|okay|hello|yo)[\\s,]+)?${escapeRegex(wake)}(?![\\p{L}\\p{N}])[\\s,.!?:;-]*`,
      "iu",
    );
    const match = text.match(pattern);
    if (!match) return { matched: false, command: "" };
    return { matched: true, command: text.slice(match[0].length).trim() };
  }

  /** Turn markdown-ish text into something a speech engine reads naturally. */
  function toSpeakable(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*•]\s+/gm, "")
      .replace(/[*_`~|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Splits streamed text into whole sentences so speech can start early. */
  class SentenceChunker {
    constructor(minLength = 24) {
      this.minLength = minLength;
      this.buffer = "";
    }

    push(delta) {
      this.buffer += delta;
      const out = [];
      // A sentence ends at . ! ? followed by whitespace, or at a line break.
      const boundary = /([.!?]["')\]]?\s+|\n+)/g;
      let start = 0;
      let match;
      while ((match = boundary.exec(this.buffer)) !== null) {
        const end = match.index + match[0].length;
        if (end - start < this.minLength) continue;
        out.push(this.buffer.slice(start, end));
        start = end;
      }
      this.buffer = this.buffer.slice(start);
      return out.map(toSpeakable).filter(Boolean);
    }

    flush() {
      const rest = toSpeakable(this.buffer);
      this.buffer = "";
      return rest ? [rest] : [];
    }
  }

  return { SAMPLE_RATE, rms, Endpointer, matchWakeWord, toSpeakable, SentenceChunker };
});
