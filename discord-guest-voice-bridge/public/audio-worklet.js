class VoiceBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capture = new Float32Array(960);
    this.captureOffset = 0;
    this.playFrames = [];
    this.playFrame = null;
    this.playOffset = 0;
    this.port.onmessage = event => {
      if (event.data && event.data.type === 'play' && event.data.buffer) {
        this.playFrames.push(new Int16Array(event.data.buffer));
        if (this.playFrames.length > 40) this.playFrames.shift();
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (output) {
      let offset = 0;
      while (offset < output.length) {
        if (!this.playFrame || this.playOffset >= this.playFrame.length) {
          this.playFrame = this.playFrames.shift() || null;
          this.playOffset = 0;
        }
        if (!this.playFrame) {
          output.fill(0, offset);
          break;
        }
        const count = Math.min(output.length - offset, this.playFrame.length - this.playOffset);
        for (let i = 0; i < count; i++) output[offset + i] = this.playFrame[this.playOffset + i] / 32768;
        offset += count;
        this.playOffset += count;
      }
    }

    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.capture[this.captureOffset++] = input[i];
        if (this.captureOffset === 960) {
          const pcm = new Int16Array(960);
          for (let j = 0; j < 960; j++) {
            const value = Math.max(-1, Math.min(1, this.capture[j]));
            pcm[j] = value < 0 ? value * 32768 : value * 32767;
          }
          this.port.postMessage({ type: 'mic', buffer: pcm.buffer }, [pcm.buffer]);
          this.captureOffset = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('voice-bridge-processor', VoiceBridgeProcessor);