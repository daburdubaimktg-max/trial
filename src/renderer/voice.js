// Browser-side voice: microphone capture with phrase detection, and
// spoken replies through the operating system's built-in voices.

/* global VoiceLogic */

class Microphone {
  /**
   * @param {object} handlers
   * @param {(samples: Float32Array) => void} handlers.onUtterance a finished phrase
   * @param {(level: number) => void} [handlers.onLevel] loudness 0..1 for the orb
   * @param {() => void} [handlers.onSpeechStart]
   */
  constructor({ onUtterance, onLevel = () => {}, onSpeechStart = () => {} }) {
    this.onUtterance = onUtterance;
    this.onLevel = onLevel;
    this.onSpeechStart = onSpeechStart;
    this.endpointer = new VoiceLogic.Endpointer();
    this.context = null;
    this.stream = null;
    this.paused = false;
    this.manual = null; // frames collected while the talk key is held
  }

  /** Record everything until endManual(), with no guessing about pauses. */
  beginManual() {
    this.endpointer.reset();
    this.manual = [];
  }

  /** @returns {Float32Array} everything recorded since beginManual() */
  endManual() {
    const frames = this.manual ?? [];
    this.manual = null;
    const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const frame of frames) {
      out.set(frame, offset);
      offset += frame.length;
    }
    return out;
  }

  get active() {
    return this.context !== null;
  }

  async start() {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Asking for 16 kHz makes the browser resample for us; that is the rate
    // the speech recogniser expects.
    this.context = new AudioContext({ sampleRate: VoiceLogic.SAMPLE_RATE });
    await this.context.audioWorklet.addModule("mic-worklet.js");
    const source = this.context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.context, "frame-processor");
    node.port.onmessage = (event) => this.#onFrame(event.data);
    source.connect(node);
    this.endpointer.reset();
  }

  stop() {
    if (!this.active) return;
    this.stream.getTracks().forEach((track) => track.stop());
    this.context.close();
    this.context = null;
    this.stream = null;
    this.onLevel(0);
  }

  /** While paused, audio is ignored (used so the assistant never hears itself). */
  setPaused(paused) {
    this.paused = paused;
    if (paused) {
      this.endpointer.reset();
      this.onLevel(0);
    }
  }

  #onFrame(frame) {
    if (this.paused) return;
    this.onLevel(Math.min(1, VoiceLogic.rms(frame) * 12));
    if (this.manual) {
      // Stop collecting at the recogniser's limit; the rest would be refused.
      if (this.manual.length < Microphone.MAX_MANUAL_FRAMES) this.manual.push(frame);
      return;
    }
    const wasInSpeech = this.endpointer.inSpeech;
    const utterance = this.endpointer.push(frame);
    if (!wasInSpeech && this.endpointer.inSpeech) this.onSpeechStart();
    if (utterance) this.onUtterance(utterance);
  }
}

/**
 * Speaks sentences one after another. Uses the built-in neural voice when
 * the chosen voice starts with "neural:", otherwise an operating-system
 * voice. If the neural voice fails, that sentence falls back to the system
 * voice so a reply is never silently dropped.
 */
Microphone.MAX_MANUAL_FRAMES = 270; // 27 s of 100 ms frames

class Speaker {
  /**
   * @param {object} deps
   * @param {(speaking: boolean) => void} deps.onSpeakingChange
   * @param {(text: string, voiceId: string) => Promise<{samples: Float32Array, sampleRate: number}>} deps.synthesize
   * @param {(error: Error) => void} [deps.onError] called once per failure streak
   */
  constructor({ onSpeakingChange = () => {}, synthesize, onError = () => {} }) {
    this.onSpeakingChange = onSpeakingChange;
    this.synthesize = synthesize;
    this.onError = onError;
    this.voice = "neural:af_heart";
    this.queue = [];
    this.playing = false;
    this.generation = 0; // bumped by stop() so anything in flight is dropped
    this.context = null;
    this.source = null;
    this.errorReported = false;
    this.systemAvailable = typeof speechSynthesis !== "undefined";
  }

  systemVoices() {
    return this.systemAvailable ? speechSynthesis.getVoices() : [];
  }

  get speaking() {
    return this.playing;
  }

  say(text) {
    if (!text) return;
    this.queue.push({ text, voice: this.voice, audio: null });
    this.#pump();
  }

  /**
   * Begin generating audio for a queued sentence. Only the sentence being
   * played and the one after it are ever in flight, so an interruption
   * leaves almost nothing to wait out.
   */
  #prepare(item) {
    if (!item || item.audio || !item.voice.startsWith("neural:")) return;
    item.audio = this.synthesize(item.text, item.voice.slice("neural:".length)).then(
      (audio) => {
        this.errorReported = false;
        return audio;
      },
      (error) => {
        if (!this.errorReported) this.onError(error);
        this.errorReported = true;
        return null;
      },
    );
  }

  stop() {
    this.generation++;
    this.queue = [];
    try {
      this.source?.stop();
    } catch {
      // already finished
    }
    if (this.systemAvailable) speechSynthesis.cancel();
    if (this.playing) {
      this.playing = false;
      this.onSpeakingChange(false);
    }
  }

  async #pump() {
    if (this.playing) return;
    this.playing = true;
    const generation = this.generation;
    this.onSpeakingChange(true);
    while (this.queue.length > 0 && generation === this.generation) {
      const item = this.queue.shift();
      this.#prepare(item);
      this.#prepare(this.queue[0]);
      const audio = item.audio ? await item.audio : null;
      if (generation !== this.generation) return;
      this.#prepare(this.queue[0]); // may have arrived while waiting
      if (audio) await this.#playSamples(audio);
      else await this.#speakWithSystem(item.text, item.voice);
    }
    if (generation !== this.generation) return;
    this.playing = false;
    this.onSpeakingChange(false);
  }

  #playSamples({ samples, sampleRate }) {
    return new Promise((resolve) => {
      this.context ??= new AudioContext();
      const buffer = this.context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
      this.source = source;
      this.context.resume().then(() => source.start(), resolve);
    });
  }

  #speakWithSystem(text, chosen) {
    return new Promise((resolve) => {
      if (!this.systemAvailable) return resolve();
      const utterance = new SpeechSynthesisUtterance(text);
      const name = chosen.startsWith("system:") ? chosen.slice("system:".length) : "";
      const voice = this.systemVoices().find((v) => v.name === name);
      if (voice) utterance.voice = voice;
      utterance.rate = 1.05;
      utterance.onend = resolve;
      utterance.onerror = resolve;
      speechSynthesis.speak(utterance);
    });
  }
}

window.Voice = { Microphone, Speaker };
