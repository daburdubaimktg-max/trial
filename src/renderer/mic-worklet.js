// Runs on the audio thread: groups microphone samples into 100 ms frames
// and hands them to the page.
class FrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(Math.round(sampleRate / 10));
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const n = Math.min(channel.length - offset, this.frame.length - this.filled);
      this.frame.set(channel.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("frame-processor", FrameProcessor);
