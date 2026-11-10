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
    const wasInSpeech = this.endpointer.inSpeech;
    const utterance = this.endpointer.push(frame);
    if (!wasInSpeech && this.endpointer.inSpeech) this.onSpeechStart();
    if (utterance) this.onUtterance(utterance);
  }
}

class Speaker {
  /** @param {(speaking: boolean) => void} onSpeakingChange */
  constructor(onSpeakingChange = () => {}) {
    this.onSpeakingChange = onSpeakingChange;
    this.pending = 0;
    this.generation = 0; // bumped by stop() so cancelled speech is ignored
    this.voiceName = "";
    this.available = typeof speechSynthesis !== "undefined";
  }

  voices() {
    return this.available ? speechSynthesis.getVoices() : [];
  }

  get speaking() {
    return this.pending > 0;
  }

  say(text) {
    if (!this.available || !text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.voices().find((v) => v.name === this.voiceName);
    if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    const generation = this.generation;
    const finished = () => {
      if (generation !== this.generation) return;
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.onSpeakingChange(false);
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    if (this.pending++ === 0) this.onSpeakingChange(true);
    speechSynthesis.speak(utterance);
  }

  stop() {
    if (!this.available) return;
    this.generation++;
    speechSynthesis.cancel();
    if (this.pending > 0) {
      this.pending = 0;
      this.onSpeakingChange(false);
    }
  }
}

window.Voice = { Microphone, Speaker };
