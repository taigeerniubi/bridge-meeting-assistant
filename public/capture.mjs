import { SpeechSegmenter, downsample, pcmToWav } from './audio-core.mjs';

export class AudioCapture {
  constructor({ onSegment, onLevel, onEnded, onError }) { Object.assign(this, { onSegment, onLevel, onEnded, onError }); this.blocked = false; }
  async start(kind, deviceId = '') {
    if (!globalThis.isSecureContext || !navigator.mediaDevices) throw new Error('麦克风需要安全连接：电脑使用 localhost，手机请使用可信的 HTTPS 地址。');
    if (kind === 'system' && !navigator.mediaDevices.getDisplayMedia) throw new Error('此设备不支持会议音频共享，请使用麦克风或 Windows 桌面版。');
    let stream;
    try {
      stream = kind === 'system'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' })
        : await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      this.stream = stream;
      if (!stream.getAudioTracks().length) throw new Error('共享中没有音频。请重新选择屏幕或标签页，并勾选“共享音频”。');
      for (const track of stream.getTracks()) track.onended = async () => { if (!this.stopping) { await this.stop(); this.onEnded?.(); } };
      this.context = new AudioContext();
      await this.context.resume();
      await this.context.audioWorklet.addModule('/capture-worklet.js');
      this.segmenter = new SpeechSegmenter({ sampleRate: this.context.sampleRate, onSegment: (samples, rate) => this.onSegment(pcmToWav(downsample(samples, rate), 16000)) });
      this.node = new AudioWorkletNode(this.context, 'bridge-capture');
      this.node.port.onmessage = event => {
        if (event.data === 'flushed') { this.flushComplete?.(); return; }
        if (this.stopped) return;
        try { this.onLevel?.(this.blocked ? 0 : this.segmenter.push(event.data)); } catch (error) { this.onError?.(error); }
      };
      this.source = this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.silent); this.silent.connect(this.context.destination);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      await this.context?.close().catch(() => {});
      if (error.name === 'NotAllowedError') throw new Error('音频权限未开启，或共享已取消。请授权后重试。');
      if (error.name === 'NotReadableError') throw new Error('无法打开音频设备。请检查设备是否被其他应用独占，或改用麦克风。');
      throw error;
    }
  }
  setBlocked(blocked) {
    if (blocked && !this.blocked) this.segmenter?.flush();
    this.blocked = blocked;
  }
  async stop() {
    if (this.stopping) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.source?.disconnect();
      // Retrieve the last, partly filled worklet frame before stopping tracks.
      // Otherwise a quick stop can clip the final consonant or syllable.
      if (this.node && this.context?.state === 'running') {
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 300);
          this.flushComplete = () => { clearTimeout(timeout); resolve(); };
          this.node.port.postMessage('flush');
        });
        this.flushComplete = null;
      }
      this.segmenter?.flush(); this.stopped = true;
      this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
      this.node?.disconnect(); this.silent?.disconnect();
      if (this.context && this.context.state !== 'closed') await this.context.close();
      this.onLevel?.(0);
    })();
    return this.stopPromise;
  }
}

export function base64Audio(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
