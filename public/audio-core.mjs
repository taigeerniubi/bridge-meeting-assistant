// Pure, shared audio primitives; independent of browser permissions and UI.
export function pcmToWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, value) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

export function downsample(samples, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const result = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < result.length; i++) {
    const from = Math.floor(i * ratio), to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    result[i] = sum / (to - from);
  }
  return result;
}

// Preserve fractional resampling state across worklet frames. Per-frame
// rounding slowly drops audio samples and makes a long live stream drift.
export class PcmStreamEncoder {
  constructor({ sampleRate, targetRate = 16000, frameSamples = 1600, onFrame }) {
    this.ratio = sampleRate / targetRate; this.remaining = this.ratio; this.sum = 0;
    this.frame = new ArrayBuffer(frameSamples * 2); this.view = new DataView(this.frame); this.position = 0; this.onFrame = onFrame;
  }
  write(value) {
    const sample = Math.max(-1, Math.min(1, value || 0));
    this.view.setInt16(this.position * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    if (++this.position * 2 === this.frame.byteLength) { this.position = 0; this.onFrame(this.frame.slice(0)); }
  }
  push(samples, muted = false) {
    let power = 0;
    for (const sample of samples) {
      power += sample * sample;
      let weight = 1;
      while (weight > 1e-9) {
        const used = Math.min(weight, this.remaining);
        this.sum += (muted ? 0 : sample) * used; this.remaining -= used; weight -= used;
        if (this.remaining < 1e-9) { this.write(this.sum / this.ratio); this.remaining = this.ratio; this.sum = 0; }
      }
    }
    return muted ? 0 : Math.sqrt(power / (samples.length || 1));
  }
  flush() {
    if (this.ratio - this.remaining > 1e-9) this.write(this.sum / (this.ratio - this.remaining));
    if (this.position) this.onFrame(this.frame.slice(0, this.position * 2));
    this.position = 0; this.sum = 0; this.remaining = this.ratio;
  }
}

export class SpeechSegmenter {
  constructor({ sampleRate, onSegment, threshold = 0.012, silenceMs = 650, maxMs = 8000, minVoiceMs = 160 }) {
    Object.assign(this, { sampleRate, onSegment, threshold, silenceMs, maxMs, minVoiceMs });
    this.reset();
  }
  reset() { this.chunks = []; this.pre = []; this.total = 0; this.voiced = 0; this.silence = 0; this.active = false; }
  push(frame) {
    let power = 0;
    for (const sample of frame) power += sample * sample;
    const rms = Math.sqrt(power / frame.length);
    const ms = frame.length / this.sampleRate * 1000;
    const speaking = rms >= this.threshold;
    if (!this.active) {
      this.pre.push(frame);
      while (this.pre.reduce((n, f) => n + f.length, 0) > this.sampleRate * 0.24 && this.pre.length > 1) this.pre.shift();
      if (!speaking) return rms;
      this.active = true;
      this.chunks = this.pre; this.pre = [];
      this.total = this.chunks.reduce((n, f) => n + f.length, 0);
    } else { this.chunks.push(frame); this.total += frame.length; }
    if (speaking) { this.voiced += ms; this.silence = 0; } else this.silence += ms;
    if (this.silence >= this.silenceMs || this.total / this.sampleRate * 1000 >= this.maxMs) this.flush();
    return rms;
  }
  flush() {
    if (this.active && this.voiced >= this.minVoiceMs) {
      const data = new Float32Array(this.total);
      let offset = 0;
      for (const frame of this.chunks) { data.set(frame, offset); offset += frame.length; }
      this.onSegment(data, this.sampleRate);
    }
    this.reset();
  }
}
