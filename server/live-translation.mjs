import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

export function liveSession(provider, { source, targetLanguage = source === 'me' ? 'en' : 'zh', audio = false, glossary = [] }) {
  if (!['en', 'zh'].includes(targetLanguage)) throw new Error('请选择英文或中文作为同传目标语言。');
  const phrases = Object.fromEntries(glossary.slice(0, 120).flatMap(term => {
    const en = String(term?.en || '').trim().slice(0, 100), zh = String(term?.zh || '').trim().slice(0, 100);
    return en && zh ? [[targetLanguage === 'en' ? zh : en, targetLanguage === 'en' ? en : zh]] : [];
  }));
  const translation = { language: targetLanguage, corpus: { phrases } };
  const modalities = audio && targetLanguage === 'en' ? ['text', 'audio'] : ['text'];
  if (/^qwen3\.5-livetranslate-/.test(provider.liveModel)) return {
    modalities, voice: provider.liveVoice, sample_rate: 16000,
    input_audio_format: 'pcm', output_audio_format: 'pcm', enable_voice_clone: false,
    input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
    turn_detection: { type: 'server_vad', threshold: 0.2, silence_duration_ms: 400 }, translation,
  };
  if (!/^qwen3\.8-livetranslate-/.test(provider.liveModel)) throw new Error('实时同传需要 Qwen3.8 或 Qwen3.5 LiveTranslate Realtime 模型，请检查设置。');
  return {
    input_modalities: ['audio'], output_modalities: modalities, enable_voice_clone: false,
    audio: { input: { format: { type: 'pcm', sample_rate: 16000 }, turn_detection: { type: 'speaker_detection', threshold: 0.5 } }, output: { voice: provider.liveVoice } },
    translation,
  };
}

// Join source and translation by the documented item relationship, never by
// whichever speaker happened to produce the most recent event.
export class LiveTranscript {
  constructor(emit) { this.emit = emit; this.items = new Map(); this.translations = new Map(); this.responses = new Map(); this.waiting = new Map(); this.waitingCount = 0; }
  item(id) {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('同传服务返回了无效的发言标识。');
    if (!this.items.has(id)) {
      if (this.items.size >= 3000) throw new Error('本次同传记录已达上限，请停止采集并新建会议。');
      this.items.set(id, { id, original: '', translated: '', originalDone: false, translatedDone: false, responseDone: false });
    }
    return this.items.get(id);
  }
  publish(item) {
    if (item.original.length > 24000 || item.translated.length > 24000) throw new Error('同传单条结果过长，请重新接入音频。');
    if (item.originalDone && item.translatedDone && item.responseDone && (!item.original.trim() || !item.translated.trim())) item.error ||= '同传未返回完整原文或译文，请重新录入。';
    const final = Boolean(item.originalDone && item.translatedDone && item.responseDone && !item.error);
    this.emit({ type: 'transcript', ...item, final });
  }
  process(event) {
    const type = event.type;
    if (type === 'input_audio_buffer.speech_started') {
      const item = this.item(event.item_id);
      if (Number.isInteger(event.speaker_id)) item.speakerId = event.speaker_id;
      return;
    }
    if (type === 'conversation.item.created' && event.item?.role === 'assistant') {
      // Creation notifications also include source-audio/placeholder items.
      // Only a translation with an explicit source link establishes a pair.
      if (event.item.content?.some(part => part.type === 'input_audio') || event.previous_item_id == null || event.previous_item_id === '') return;
      if (typeof event.item.id !== 'string' || !event.item.id || event.item.id.length > 200) throw new Error('同传服务返回了无效的译文标识。');
      this.item(event.previous_item_id);
      this.translations.set(event.item.id, event.previous_item_id);
      const buffered = this.waiting.get(event.item.id) || [];
      this.waiting.delete(event.item.id); this.waitingCount -= buffered.length;
      for (const queued of buffered) this.process(queued);
      return;
    }
    if (type?.startsWith('conversation.item.input_audio_transcription.')) {
      const item = this.item(event.item_id);
      if (type.endsWith('.delta') && !item.originalDone) item.original += event.delta || '';
      if (type.endsWith('.text') && !item.originalDone) item.original = (event.text || '') + (event.stash || '');
      if (type.endsWith('.completed')) { item.original = event.transcript || ''; item.originalDone = true; }
      if (type.endsWith('.failed')) item.error = '原文识别未完成，请重新录入。';
      this.publish(item); return;
    }
    if (type === 'response.done') {
      const outputs = event.response?.output || [];
      for (const output of outputs) {
        this.process({ type: 'response.item.finished', item_id: output.id, output, status: event.response.status });
      }
      for (const id of this.responses.get(event.response?.id) || []) if (!outputs.some(output => output.id === id)) {
        this.process({ type: 'response.item.finished', item_id: id, output: { content: [] }, status: event.response.status === 'completed' ? 'incomplete' : event.response.status });
      }
      this.responses.delete(event.response?.id);
      return;
    }
    if (!['response.text.delta', 'response.text.text', 'response.text.done', 'response.audio_transcript.delta', 'response.audio_transcript.text', 'response.audio_transcript.done', 'response.audio.delta', 'response.item.finished'].includes(type)) return;
    if (event.response_id) {
      if (!this.responses.has(event.response_id)) this.responses.set(event.response_id, new Set());
      this.responses.get(event.response_id).add(event.item_id);
    }
    const inputId = this.translations.get(event.item_id);
    if (!inputId) {
      if (++this.waitingCount > 200) throw new Error('同传原文与译文无法对应，请重新接入音频。');
      const buffered = this.waiting.get(event.item_id) || [];
      buffered.push(event); this.waiting.set(event.item_id, buffered); return;
    }
    const item = this.item(inputId);
    if (type === 'response.audio.delta') {
      if (typeof event.delta !== 'string' || event.delta.length > 2_000_000) throw new Error('同传语音分片格式无效。');
      this.emit({ type: 'audio', id: inputId, data: event.delta, sampleRate: 24000 }); return;
    }
    if (type.endsWith('.delta') && !item.translatedDone) item.translated += event.delta || '';
    if (type.endsWith('.text') && !item.translatedDone) item.translated = (event.text || '') + (event.stash || '');
    if (type.endsWith('.done')) { item.translated = event.text ?? event.transcript ?? ''; item.translatedDone = true; }
    if (type === 'response.item.finished') {
      if (event.status !== 'completed') item.error = '这段同传未完整生成，已保留收到的文字。';
      else {
        const content = (event.output.content || []).map(part => part.text ?? part.transcript ?? '').join('');
        if (content) item.translated = content;
        item.translatedDone = true; item.responseDone = true;
      }
    }
    this.publish(item);
  }
  finish(message = '同传连接已结束，当前片段未完整确认。') {
    for (const item of this.items.values()) if ((!item.originalDone || !item.translatedDone || !item.responseDone) && (item.original || item.translated)) {
      item.error ||= message; this.publish(item);
    }
  }
}

export function createLiveGateway({ getConfig, authorize, socketFactory = (url, options) => new WebSocket(url, options) }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const upgrade = (req, socket, head) => {
    if (!authorize(req) || wss.clients.size >= 4) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => {
      let upstream, provider, configured = false, playbackEnabled = true, ready = false, finishing = false, ended = false;
      let timer = setTimeout(() => fail('实时连接初始化超时，请重新接入音频。'), 15000);
      const redact = message => String(message).split(provider?.key || '\0').join('[已隐藏]').slice(0, 500);
      const send = event => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 2_000_000) { client.terminate(); return; }
        client.send(JSON.stringify(event));
      };
      const transcript = new LiveTranscript(event => { if (event.type !== 'audio' || playbackEnabled) send(event); });
      const closeUpstream = () => { if (upstream && upstream.readyState !== WebSocket.CLOSED) upstream.terminate(); };
      const fail = message => {
        if (ended) return;
        ended = true; clearTimeout(timer);
        const error = redact(message);
        try { transcript.finish(error); } catch { /* A malformed partial must not prevent socket cleanup. */ }
        send({ type: 'error', error });
        client.close(1011, 'Realtime session ended'); closeUpstream();
      };
      const sendUpstream = event => {
        if (upstream?.readyState !== WebSocket.OPEN) throw new Error('实时同传连接尚未就绪。');
        if (upstream.bufferedAmount > 320_000) throw new Error('网络发送速度跟不上录音，已停止同传，请重新连接。');
        upstream.send(JSON.stringify({ event_id: randomUUID(), ...event }));
      };
      client.on('message', (data, binary) => {
        try {
          if (binary) {
            if (!ready || finishing || !data.length || data.length > 32000 || data.length % 2) throw new Error('实时音频分片无效或连接尚未就绪。');
            sendUpstream({ type: 'input_audio_buffer.append', audio: data.toString('base64') }); return;
          }
          const event = JSON.parse(data.toString());
          if (event.type === 'start' && !upstream) {
            if (!['me', 'remote'].includes(event.source) || !Array.isArray(event.glossary || [])) throw new Error('请选择有效的音频来源。');
            provider = getConfig().providers.qwen;
            if (!provider?.key) throw new Error('实时同传需要在设置中填写 Qwen / 百炼 API Key。');
            const settings = { source: event.source, targetLanguage: event.targetLanguage, audio: event.audio === true, glossary: event.glossary || [] };
            const session = liveSession(provider, settings);
            const url = new URL(provider.liveUrl);
            if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('实时同传地址需要使用无密码、无查询参数的 wss:// 地址。');
            url.searchParams.set('model', provider.liveModel);
            upstream = socketFactory(url.toString(), { headers: { Authorization: `Bearer ${provider.key}` }, handshakeTimeout: 15000, maxPayload: 4_000_000 });
            upstream.on('error', () => fail('无法连接实时同传服务，请检查网络、同传地址、模型权限及密钥地域。'));
            upstream.on('unexpected-response', (request, response) => { response.resume(); fail(`实时同传连接被拒绝（${response.statusCode}），请检查密钥地域、模型权限及业务空间地址。`); });
            upstream.on('close', () => { if (!ended) fail('实时同传连接意外断开，请重新接入音频。'); });
            upstream.on('message', message => {
              try {
                const result = JSON.parse(message.toString());
                if (result.type === 'session.created' && !configured) { configured = true; sendUpstream({ type: 'session.update', session }); }
                else if (result.type === 'session.updated' && !ready) { clearTimeout(timer); ready = true; send({ type: 'ready', model: provider.liveModel }); }
                else if (result.type === 'error') fail(result.error?.message || '实时同传服务返回错误。');
                else if (result.type === 'session.finished') {
                  ended = true; clearTimeout(timer); transcript.finish(); send({ type: 'finished' }); client.close(1000); upstream.close();
                } else transcript.process(result);
              } catch (error) { fail(error.message); }
            });
            return;
          }
          if (event.type === 'playback') {
            // Older pages send playback messages. Only filter outgoing audio;
            // never send another session.update, including while draining.
            playbackEnabled = event.enabled === true; return;
          }
          if (event.type === 'finish' && ready && !finishing) {
            finishing = true; sendUpstream({ type: 'session.finish' });
            timer = setTimeout(() => fail('结束同传超时，已保留收到的文字，请核对最后一段。'), 20000); return;
          }
          throw new Error('实时会话状态已变化，请重新接入音频。');
        } catch (error) { fail(error.message); }
      });
      client.on('close', () => { ended = true; clearTimeout(timer); closeUpstream(); });
      client.on('error', () => { ended = true; clearTimeout(timer); closeUpstream(); });
    });
  };
  upgrade.close = () => { for (const client of wss.clients) client.terminate(); wss.close(); };
  return upgrade;
}
