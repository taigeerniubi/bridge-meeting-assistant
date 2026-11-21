// Run with: node_modules/.bin/electron tests/realtime-ui.cjs
// Uses an isolated profile, synthetic input and an in-process fake provider.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.local', 'realtime-ui-check'); fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, `profile-${process.pid}`));
let win, server, handler;
const upstreams = [], rendererErrors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const { createHandler } = await import(pathToFileURL(path.join(root, 'server/index.mjs')));
  const { initialConfig } = await import(pathToFileURL(path.join(root, 'server/config.mjs')));
  handler = createHandler({ testMode: true, config: initialConfig({ DASHSCOPE_API_KEY: 'ui-fixture-only' }), liveSocketFactory: () => {
    const socket = new EventEmitter(); socket.readyState = 1; socket.bufferedAmount = 0; socket.frames = 0;
    socket.feed = value => socket.emit('message', JSON.stringify(value));
    socket.close = socket.terminate = () => { if (socket.readyState === 3) return; socket.readyState = 3; socket.emit('close'); };
    socket.send = data => {
      const event = JSON.parse(data);
      if (event.type === 'session.update') queueMicrotask(() => socket.feed({ type: 'session.updated' }));
      if (event.type === 'input_audio_buffer.append' && ++socket.frames === 2) {
        socket.feed({ type: 'conversation.item.created', previous_item_id: null, item: { id: 'source', role: 'assistant', content: [{ type: 'input_audio' }] } });
        socket.feed({ type: 'conversation.item.created', previous_item_id: null, item: { id: 'translation', role: 'assistant', content: [] } });
        socket.feed({ type: 'input_audio_buffer.speech_started', item_id: 'source', speaker_id: 3 });
        socket.feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'source', delta: '这个 API' });
        socket.feed({ type: 'conversation.item.created', previous_item_id: 'source', item: { id: 'translation', role: 'assistant' } });
        socket.feed({ type: 'response.audio_transcript.delta', response_id: 'response', item_id: 'translation', delta: 'This API' });
        socket.feed({ type: 'response.audio.delta', item_id: 'translation', delta: Buffer.alloc(4800).toString('base64') });
      }
      if (event.type === 'session.finish') {
        socket.feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source', transcript: '这个 API 需要重试。' });
        socket.feed({ type: 'response.done', response: { id: 'response', status: 'completed', output: [{ id: 'translation', content: [{ transcript: 'This API needs a retry.' }] }] } });
        socket.feed({ type: 'session.finished' });
      }
    };
    upstreams.push(socket); queueMicrotask(() => socket.feed({ type: 'session.created' })); return socket;
  } });
  server = http.createServer(handler); server.on('upgrade', handler.upgrade);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 3) rendererErrors.push(event.message); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#service-status').textContent === '服务已配置'"), 'bootstrap');
  await win.webContents.executeJavaScript(`
    globalThis.fixtureAudioContexts = []; globalThis.fixtureAudioStreams = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(); const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      fixtureAudioContexts.push(context); fixtureAudioStreams.push(destination.stream); await context.resume(); return destination.stream;
    };
    document.querySelector('#mic-button').click();
  `, true);
  await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#transcript').textContent.includes('This API')"), 'live captions while input remains open');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#mic-button').textContent.includes('关闭麦克风')"), true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#queue-status').textContent.includes('实时同传中')"), true);
  await waitFor(() => win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries.length > 0"), 'interim persistence');
  assert.equal(await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries[0].status"), 'live');
  win.setSize(1441, 1000);
  await delay(150);
  fs.writeFileSync(path.join(out, 'streaming.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#stop-audio').click()", true);
  await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#transcript').textContent.includes('This API needs a retry.') && document.querySelector('#queue-status').textContent === '等待接入音频'"), 'stop drains final transcript');
  const entries = await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries");
  assert.equal(entries.length, 1); assert.equal(entries[0].status, 'done'); assert.equal(entries[0].original, '这个 API 需要重试。');
  assert.ok(upstreams[0].frames >= 2); assert.equal(upstreams[0].readyState, 3);
  assert.equal(await win.webContents.executeJavaScript("fixtureAudioStreams[0].getTracks().every(track => track.readyState === 'ended')"), true);
  assert.deepEqual(rendererErrors, []);
  await win.webContents.executeJavaScript("document.querySelector('#settings-button').click()", true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#capture-mode').value"), 'realtime');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#qwen-liveModel').value"), 'qwen3.8-livetranslate-flash-realtime');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#qwen-liveVoice').value"), 'Aiden');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#qwen-voice').value"), 'Aiden');
  await win.webContents.executeJavaScript("document.querySelector('#close-settings').click()", true);
  win.setSize(1000, 760);
  await delay(100);
  fs.writeFileSync(path.join(out, 'complete.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#mic-button').click()", true);
  await waitFor(() => win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries.length === 2"), 'second live session');
  upstreams[1].feed({ type: 'error', error: { message: 'Fixture connection dropped' } });
  await waitFor(() => win.webContents.executeJavaScript("fixtureAudioStreams[1].getTracks().every(track => track.readyState === 'ended')"), 'error releases microphone');
  const partial = await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries[1]");
  assert.equal(partial.status, 'error'); assert.equal(partial.english, 'This API'); assert.equal(partial.originalConfirmed, false);
  assert.equal(upstreams[1].readyState, 3);
  assert.deepEqual(rendererErrors, []);
  await win.webContents.executeJavaScript("Promise.all(fixtureAudioContexts.map(context => context.close()))");
  console.log('Realtime UI check passed: interim captions during capture, streamed PCM, stop drains final result, male voice settings, persisted transcript and device cleanup after interruption.');
  console.log(`Screenshots: ${out}`);
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  win?.destroy(); handler?.upgrade.close(); server?.closeAllConnections(); server?.close(); app.exit(process.exitCode || 0);
});
