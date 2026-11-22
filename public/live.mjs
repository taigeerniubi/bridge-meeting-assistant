import { AudioCapture } from './capture.mjs';

export class RealtimeCapture {
  constructor({ csrf, source, targetLanguage, glossary, audio, onTranscript, onAudio, onLevel, onEnded, onError }) {
    Object.assign(this, { csrf, source, targetLanguage, glossary, audio, onTranscript, onAudio, onLevel, onEnded, onError });
    this.playbackEnabled = audio === true;
    this.pre = []; this.preBytes = 0;
    this.finishedPromise = new Promise(resolve => { this.resolveFinished = resolve; });
    this.readyPromise = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.readyPromise.catch(() => {});
  }
  async start(kind, deviceId) {
    this.capture = new AudioCapture({ onPcm: frame => this.sendPcm(frame), onLevel: this.onLevel,
      onEnded: () => { void this.stop().finally(() => this.onEnded?.()); }, onError: error => this.fail(error) });
    try {
      this.captureStarted = this.capture.start(kind, deviceId);
      await this.captureStarted;
      if (this.stopping || this.failed) throw new Error('已取消音频接入。');
      const url = new URL('/api/live', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('csrf', this.csrf);
      this.socket = new WebSocket(url);
      this.timer = setTimeout(() => this.fail(new Error('实时连接超时，请检查同传配置后重试。')), 20000);
      this.socket.onopen = () => this.socket.send(JSON.stringify({ type: 'start', source: this.source, targetLanguage: this.targetLanguage, glossary: this.glossary, audio: this.audio }));
      this.socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'ready') {
            clearTimeout(this.timer); this.ready = true;
            for (const frame of this.pre) this.sendPcm(frame);
            this.pre = []; this.preBytes = 0; this.resolveReady();
          } else if (message.type === 'transcript') this.onTranscript?.(message);
          else if (message.type === 'audio' && this.playbackEnabled) this.onAudio?.(message);
          else if (message.type === 'error') this.fail(new Error(message.error));
          else if (message.type === 'finished') { this.finished = true; this.resolveFinished(); this.socket.close(); }
        } catch (error) { this.fail(error); }
      };
      this.socket.onerror = () => this.fail(new Error('无法连接本机实时服务，请重启应用并重新接入音频。'));
      this.socket.onclose = () => { if (!this.finished && !this.failed) this.fail(new Error('实时连接已断开，收到的文字已保留，请重新接入音频。')); };
      await this.readyPromise;
    } catch (error) {
      clearTimeout(this.timer); this.failed = true; this.socket?.close(); this.resolveFinished();
      await this.capture.stop(); throw error;
    }
  }
  sendPcm(frame) {
    if (this.failed || this.finished) return;
    if (!this.ready) {
      this.preBytes += frame.byteLength;
      if (this.preBytes > 160000) throw new Error('同传连接尚未就绪，已停止录音；请检查配置后重新接入。');
      this.pre.push(frame); return;
    }
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 320000) throw new Error('网络发送速度跟不上录音，已停止同传，请重新连接。');
    this.socket.send(frame);
  }
  setBlocked(blocked) { this.capture?.setBlocked(blocked); }
  setAudioEnabled(enabled) {
    // Qwen session configuration is fixed once audio starts. This switch only
    // mutes/resumes local playback; it must never reconfigure the live session.
    this.playbackEnabled = enabled === true;
  }
  fail(error) {
    if (this.failed || this.finished) return;
    this.failed = true; clearTimeout(this.timer); this.pre = []; this.preBytes = 0;
    this.rejectReady(error); this.resolveFinished(); this.socket?.close();
    void this.capture?.stop().catch(() => {}); this.onError?.(error);
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      await this.captureStarted?.catch(() => {});
      await this.capture?.stop();
      this.pre = []; this.preBytes = 0;
      if (!this.ready || this.failed || this.finished) {
        this.finished = true; this.rejectReady(new Error('已取消音频接入。')); this.socket?.close(); this.resolveFinished(); clearTimeout(this.timer); return;
      }
      this.socket.send(JSON.stringify({ type: 'finish' }));
      this.timer = setTimeout(() => this.fail(new Error('同传收尾超时，已保留当前结果，请核对最后一段。')), 25000);
      await this.finishedPromise; clearTimeout(this.timer);
    })().catch(error => this.fail(error));
    return this.stopPromise;
  }
}

// Schedule PCM as it arrives; no whole-file download or sentence boundary is
// needed. The output device is independent from the microphone input.
export class PcmStreamPlayer {
  constructor({ onActivity = () => {} } = {}) { this.onActivity = onActivity; this.sources = new Set(); this.generation = 0; }
  async prepare(sinkId = '') {
    this.context ||= new AudioContext({ sampleRate: 24000 });
    if (sinkId !== (this.sinkId || '')) {
      if (!this.context.setSinkId) throw new Error('当前设备不支持指定同传语音输出，请选择系统默认输出。');
      await this.context.setSinkId(sinkId);
    }
    this.sinkId = sinkId;
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('请重新点击自动播报开关，允许播放实时语音。');
  }
  push(base64, sampleRate = 24000) {
    if (!this.context || this.context.state !== 'running') throw new Error('实时语音输出未就绪，请重新开启自动播报。');
    const binary = atob(base64);
    if (!binary.length || binary.length % 2 || binary.length > 1_500_000 || sampleRate !== 24000) throw new Error('同传语音分片格式无效。');
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0)), view = new DataView(bytes.buffer);
    const now = this.context.currentTime;
    const start = Math.max(this.nextTime || 0, now + 0.06);
    if (start + binary.length / 2 / sampleRate - now > 8) throw new Error('英文播报积压超过 8 秒，已暂停自动播放；字幕继续更新。');
    const buffer = this.context.createBuffer(1, binary.length / 2, sampleRate), samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.context.destination);
    const generation = this.generation;
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (generation === this.generation && !this.sources.size) this.onActivity(false); };
    this.sources.add(source); source.start(start); this.nextTime = start + buffer.duration; this.onActivity(true);
  }
  stop() {
    this.generation++;
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.nextTime = 0; this.onActivity(false);
  }
}
