class BridgeCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(2048); this.position = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') {
        if (this.position) {
          const tail = this.buffer.slice(0, this.position);
          this.port.postMessage(tail, [tail.buffer]); this.position = 0;
        }
        this.port.postMessage('flushed');
      }
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i] || 0;
      this.buffer[this.position++] = sum / channels.length;
      if (this.position === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048); this.position = 0;
      }
    }
    return true;
  }
}
registerProcessor('bridge-capture', BridgeCapture);
