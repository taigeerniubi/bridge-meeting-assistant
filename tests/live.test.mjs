import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { initialConfig } from '../server/config.mjs';
import { createHandler } from '../server/index.mjs';
import { liveSession, LiveTranscript } from '../server/live-translation.mjs';
import { PcmStreamEncoder } from '../public/audio-core.mjs';
import { PcmStreamPlayer } from '../public/live.mjs';

test('live translation uses the correct protocol, language direction and terminology', () => {
  const provider = initialConfig({}).providers.qwen;
  const glossary = [{ en: 'retry', zh: '重试' }];
  const session = liveSession(provider, { source: 'me', audio: true, glossary });
  assert.deepEqual(session.output_modalities, ['text', 'audio']);
  assert.equal(session.audio.input.format.sample_rate, 16000);
  assert.equal(session.audio.output.voice, 'Aiden');
  assert.equal(provider.voice, 'Aiden');
  assert.equal(session.audio.input.turn_detection.type, 'speaker_detection');
  assert.equal(session.enable_voice_clone, false);
  assert.deepEqual(session.translation, { language: 'en', corpus: { phrases: { 重试: 'retry' } } });
  const remote = liveSession(provider, { source: 'remote', audio: true, glossary });
  assert.deepEqual(remote.output_modalities, ['text']);
  assert.equal(remote.translation.language, 'zh');
  assert.deepEqual(remote.translation.corpus.phrases, { retry: '重试' });
  const legacy = liveSession({ ...provider, liveModel: 'qwen3.5-livetranslate-flash-realtime' }, { source: 'me', audio: true });
  assert.deepEqual(legacy.modalities, ['text', 'audio']);
  assert.equal(legacy.voice, 'Aiden');
  assert.equal(legacy.input_audio_transcription.model, 'qwen3-asr-flash-realtime');
  assert.equal(legacy.input_audio_transcription.language, undefined);
  assert.equal(legacy.turn_detection.type, 'server_vad');
  assert.throws(() => liveSession({ ...provider, liveModel: 'qwen3-asr-flash' }, { source: 'me' }), /LiveTranslate/);
});

test('interleaved speakers and translations are joined by item IDs and only confirmed together', () => {
  const events = [], state = new LiveTranscript(event => events.push(event));
  state.process({ type: 'input_audio_buffer.speech_started', item_id: 'source-A', speaker_id: 7 });
  state.process({ type: 'input_audio_buffer.speech_started', item_id: 'source-B', speaker_id: 9 });
  state.process({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'source-A', delta: '不要' });
  state.process({ type: 'conversation.item.created', previous_item_id: 'source-A', item: { id: 'translation-A', role: 'assistant' } });
  state.process({ type: 'conversation.item.created', previous_item_id: 'source-B', item: { id: 'translation-B', role: 'assistant' } });
  state.process({ type: 'response.audio_transcript.delta', item_id: 'translation-A', delta: 'Do not ' });
  state.process({ type: 'response.text.delta', item_id: 'translation-B', delta: 'Other speaker' });
  state.process({ type: 'response.audio_transcript.delta', item_id: 'translation-A', delta: 'deploy.' });
  state.process({ type: 'response.audio.delta', item_id: 'translation-A', delta: 'AAAA' });
  assert.equal(events.at(-1).type, 'audio');
  assert.equal(events.at(-1).id, 'source-A', 'audio must be available before sentence completion');
  const draft = events.findLast(event => event.type === 'transcript' && event.id === 'source-A');
  assert.equal(draft.original, '不要'); assert.equal(draft.translated, 'Do not deploy.'); assert.equal(draft.final, false); assert.equal(draft.speakerId, 7);
  state.process({ type: 'response.done', response: { status: 'completed', output: [{ id: 'translation-A', content: [{ transcript: 'Do not deploy.' }] }] } });
  assert.equal(events.at(-1).final, false);
  state.process({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source-A', transcript: '不要发布。' });
  assert.equal(events.at(-1).final, true);
  assert.equal(state.items.get('source-B').translated, 'Other speaker');
  state.finish();
  assert.equal(events.at(-1).id, 'source-B'); assert.equal(events.at(-1).final, false); assert.match(events.at(-1).error, /未完整/);
});

test('3.5 draft revisions replace stash and out-of-order translation events wait for their source', () => {
  const events = [], state = new LiveTranscript(event => events.push(event));
  state.process({ type: 'response.text.text', item_id: 'out', text: 'Do', stash: ' deploy' });
  assert.equal(events.length, 0);
  state.process({ type: 'conversation.item.created', previous_item_id: 'in', item: { id: 'out', role: 'assistant' } });
  state.process({ type: 'response.text.text', item_id: 'out', text: 'Do not', stash: ' deploy' });
  assert.equal(events.at(-1).translated, 'Do not deploy');
  state.process({ type: 'conversation.item.input_audio_transcription.text', item_id: 'in', text: '不要', stash: '发部' });
  state.process({ type: 'conversation.item.input_audio_transcription.text', item_id: 'in', text: '不要', stash: '发布' });
  assert.equal(events.at(-1).original, '不要发布');
  state.process({ type: 'response.done', response: { status: 'cancelled', output: [{ id: 'out', content: [] }] } });
  assert.equal(events.at(-1).final, false); assert.match(events.at(-1).error, /未完整/);
});

test('source-audio and unlinked creation events do not disconnect or mispair live translation', () => {
  const events = [], state = new LiveTranscript(event => events.push(event));
  state.process({ type: 'conversation.item.created', previous_item_id: null, item: { id: 'source', role: 'assistant', content: [{ type: 'input_audio' }] } });
  state.process({ type: 'conversation.item.created', previous_item_id: 'earlier-turn', item: { id: 'source', role: 'assistant', content: [{ type: 'input_audio' }] } });
  assert.equal(state.translations.has('source'), false);
  for (const previous_item_id of [undefined, null, '']) state.process({ type: 'conversation.item.created', previous_item_id, item: { id: 'translation', role: 'assistant', content: [] } });
  assert.equal(state.items.size, 0); assert.equal(events.length, 0);
  state.process({ type: 'response.audio_transcript.delta', item_id: 'translation', delta: 'Do not deploy.' });
  state.process({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'source', delta: '不要发布。' });
  state.process({ type: 'conversation.item.created', previous_item_id: 'source', item: { id: 'translation', role: 'assistant', content: [] } });
  assert.equal(events.at(-1).original, '不要发布。'); assert.equal(events.at(-1).translated, 'Do not deploy.');
  assert.equal(events.at(-1).final, false);
  state.process({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source', transcript: '不要发布。' });
  state.process({ type: 'response.done', response: { status: 'completed', output: [{ id: 'translation', content: [{ transcript: 'Do not deploy.' }] }] } });
  assert.equal(events.at(-1).final, true); assert.equal(state.waitingCount, 0);
});

test('cancelled responses with empty output retain drafts and empty final text is never confirmed', () => {
  const events = [], state = new LiveTranscript(event => events.push(event));
  state.process({ type: 'conversation.item.created', previous_item_id: 'in', item: { id: 'out', role: 'assistant' } });
  state.process({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'in', transcript: '不要发布' });
  state.process({ type: 'response.text.delta', response_id: 'response', item_id: 'out', delta: 'Do not' });
  state.process({ type: 'response.done', response: { id: 'response', status: 'cancelled', output: [] } });
  assert.equal(events.at(-1).translated, 'Do not');
  assert.equal(events.at(-1).final, false); assert.match(events.at(-1).error, /未完整/);
  state.process({ type: 'conversation.item.created', previous_item_id: 'empty', item: { id: 'empty-out', role: 'assistant' } });
  state.process({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'empty', transcript: '' });
  state.process({ type: 'response.done', response: { status: 'completed', output: [{ id: 'empty-out', content: [{ text: 'Unmatched' }] }] } });
  assert.equal(events.at(-1).final, false); assert.match(events.at(-1).error, /未返回完整/);
});

test('streaming PCM retains fractional samples and emits before a pause at both device rates', () => {
  for (const sampleRate of [44100, 48000]) {
    const frames = [], encoder = new PcmStreamEncoder({ sampleRate, onFrame: frame => frames.push(Buffer.from(frame)) });
    const samples = new Float32Array(sampleRate * 3).fill(0.25);
    for (let offset = 0; offset < samples.length; offset += 2048) encoder.push(samples.subarray(offset, offset + 2048));
    assert.ok(frames.length >= 29, 'frames must be emitted during continuous speech, without flush or silence');
    encoder.flush(); const pcm = Buffer.concat(frames);
    assert.equal(pcm.length, 16000 * 3 * 2);
    assert.equal(pcm.readInt16LE(0), 8192); assert.equal(pcm.readInt16LE(pcm.length - 2), 8192);
  }
  const frames = [], encoder = new PcmStreamEncoder({ sampleRate: 16000, onFrame: frame => frames.push(Buffer.from(frame)) });
  encoder.push(new Float32Array(800).fill(.5)); encoder.push(new Float32Array(800).fill(.5), true); encoder.flush();
  assert.equal(frames.length, 1); assert.equal(frames[0].readInt16LE(0), 16384); assert.equal(frames[0].readInt16LE(2000), 0);
});

test('PCM playback schedules incoming fragments immediately and bounds accumulated delay', async t => {
  const original = globalThis.AudioContext, scheduled = [], activity = [];
  globalThis.AudioContext = class {
    currentTime = 1; state = 'running'; destination = {};
    async resume() {} async setSinkId(id) { this.sink = id; }
    createBuffer(channels, size, rate) { return { duration: size / rate, getChannelData: () => new Float32Array(size) }; }
    createBufferSource() { const source = { connect() {}, disconnect() {}, start(time) { scheduled.push({ source, time }); }, stop() { this.stopped = true; } }; return source; }
  };
  t.after(() => { globalThis.AudioContext = original; });
  const player = new PcmStreamPlayer({ onActivity: value => activity.push(value) });
  await player.prepare('virtual-output');
  player.push(Buffer.alloc(4800).toString('base64'));
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].time, 1.06);
  player.push(Buffer.alloc(4800).toString('base64'));
  assert.ok(Math.abs(scheduled[1].time - 1.16) < 1e-9);
  assert.throws(() => player.push(Buffer.alloc(24000 * 2 * 9).toString('base64')), /积压/);
  player.stop(); assert.ok(scheduled.every(item => item.source.stopped)); assert.equal(activity.at(-1), false);
});

async function fixture(t, options = {}) {
  const upstreams = [];
  const handler = createHandler({ config: initialConfig({ DASHSCOPE_API_KEY: 'private-live-test-key' }), ...options, liveSocketFactory: (url, connection) => {
    const upstream = new EventEmitter(); upstream.readyState = WebSocket.OPEN; upstream.bufferedAmount = 0; upstream.sent = [];
    assert.equal(new URL(url).protocol, 'wss:'); assert.equal(connection.headers.Authorization, 'Bearer private-live-test-key');
    upstream.send = text => {
      const event = JSON.parse(text); upstream.sent.push(event);
      if (event.type === 'session.update') queueMicrotask(() => upstream.emit('message', JSON.stringify({ type: 'session.updated' })));
      if (event.type === 'session.finish') queueMicrotask(() => upstream.emit('message', JSON.stringify({ type: 'session.finished' })));
    };
    upstream.close = upstream.terminate = () => { if (upstream.readyState === WebSocket.CLOSED) return; upstream.readyState = WebSocket.CLOSED; upstream.emit('close'); };
    upstream.feed = event => upstream.emit('message', JSON.stringify(event)); upstreams.push(upstream);
    queueMicrotask(() => upstream.feed({ type: 'session.created' })); return upstream;
  } });
  const server = http.createServer(handler); server.on('upgrade', handler.upgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { handler.upgrade.close(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  return { origin, url: origin.replace('http:', 'ws:') + `/api/live?csrf=${bootstrap.csrf}`, upstreams };
}

function observe(socket) {
  const events = [], waiters = [];
  socket.on('message', data => { const event = JSON.parse(data); events.push(event); for (const waiter of [...waiters]) if (waiter.match(event)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); } });
  return { events, wait: match => events.find(match) ? Promise.resolve(events.find(match)) : new Promise((resolve, reject) => {
    const waiter = { match, resolve }; waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Expected live event was not received')); }, 2000); waiters.push(waiter);
  }) };
}

test('WebSocket streams captions and audio before finish, then closes upstream cleanly', async t => {
  const f = await fixture(t), client = new WebSocket(f.url, { origin: f.origin }), received = observe(client);
  t.after(() => client.terminate()); await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', source: 'me', audio: true, glossary: [] }));
  await received.wait(event => event.type === 'ready');
  const upstream = f.upstreams[0]; client.send(Buffer.alloc(3200));
  for (let i = 0; i < 20 && !upstream.sent.some(event => event.type === 'input_audio_buffer.append'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(Buffer.from(upstream.sent.find(event => event.type === 'input_audio_buffer.append').audio, 'base64').length, 3200);
  upstream.feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'src', delta: '测试' });
  upstream.feed({ type: 'conversation.item.created', previous_item_id: 'src', item: { id: 'dst', role: 'assistant' } });
  upstream.feed({ type: 'response.audio_transcript.delta', item_id: 'dst', delta: 'Testing' });
  upstream.feed({ type: 'response.audio.delta', item_id: 'dst', delta: 'AAAA' });
  await received.wait(event => event.type === 'audio');
  assert.ok(received.events.some(event => event.type === 'transcript' && event.translated === 'Testing' && !event.final));
  assert.equal(upstream.sent.some(event => event.type === 'session.finish'), false);
  upstream.feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'src', transcript: '测试。' });
  upstream.feed({ type: 'response.done', response: { status: 'completed', output: [{ id: 'dst', content: [{ transcript: 'Testing.' }] }] } });
  await received.wait(event => event.final === true);
  client.send(JSON.stringify({ type: 'finish' })); await received.wait(event => event.type === 'finished');
  assert.equal(upstream.readyState, WebSocket.CLOSED);
  assert.equal(JSON.stringify(received.events).includes('private-live-test-key'), false);
});

test('WebSocket requires matching origin, CSRF and access-password authentication before connecting upstream', async t => {
  const f = await fixture(t);
  for (const [url, origin] of [[f.url, 'https://evil.example'], [f.url.replace(/csrf=.*/, 'csrf=wrong'), f.origin], [f.url, undefined]]) {
    const status = await new Promise((resolve, reject) => {
      const client = new WebSocket(url, { origin }); client.on('error', () => {});
      client.on('unexpected-response', (request, response) => { response.resume(); client.terminate(); resolve(response.statusCode); });
      client.on('open', () => { client.terminate(); reject(new Error('Unauthorized socket opened')); });
    });
    assert.equal(status, 403);
  }
  const locked = await fixture(t, { accessToken: 'password' });
  const denied = await new Promise(resolve => { const client = new WebSocket(locked.url, { origin: locked.origin }); client.on('error', () => {}); client.on('unexpected-response', (request, response) => { response.resume(); client.terminate(); resolve(response.statusCode); }); });
  assert.equal(denied, 403); assert.equal(f.upstreams.length, 0); assert.equal(locked.upstreams.length, 0);
});

test('provider errors redact credentials and preserve partial captions', async t => {
  const f = await fixture(t), client = new WebSocket(f.url, { origin: f.origin }), received = observe(client);
  t.after(() => client.terminate()); await once(client, 'open'); client.send(JSON.stringify({ type: 'start', source: 'remote', glossary: [] }));
  await received.wait(event => event.type === 'ready');
  f.upstreams[0].feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'src', delta: 'Partial' });
  f.upstreams[0].feed({ type: 'error', error: { message: 'failure private-live-test-key' } });
  await received.wait(event => event.type === 'error');
  assert.equal(JSON.stringify(received.events).includes('private-live-test-key'), false);
  assert.ok(received.events.some(event => event.original === 'Partial' && event.error && !event.final));
});

test('malformed oversized provider captions still close both sides without crashing the server', async t => {
  const f = await fixture(t), client = new WebSocket(f.url, { origin: f.origin }), received = observe(client);
  t.after(() => client.terminate()); await once(client, 'open'); client.send(JSON.stringify({ type: 'start', source: 'me' }));
  await received.wait(event => event.type === 'ready');
  const closed = once(client, 'close');
  f.upstreams[0].feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'src', delta: 'x'.repeat(24001) });
  assert.match((await received.wait(event => event.type === 'error')).error, /过长/);
  await closed;
  assert.equal(f.upstreams[0].readyState, WebSocket.CLOSED);
  assert.equal((await fetch(`${f.origin}/api/bootstrap`)).status, 200);
});
