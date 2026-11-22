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
  const { createSettingsStore } = await import(pathToFileURL(path.join(root, 'server/settings-store.mjs')));
  const settingsStore = process.platform === 'win32' ? createSettingsStore(path.join(out, `settings-${process.pid}.dpapi`)) : undefined;
  handler = createHandler({ testMode: true, settingsStore, config: initialConfig({ DASHSCOPE_API_KEY: 'ui-fixture-only' }), liveSocketFactory: () => {
    const socket = new EventEmitter(); socket.readyState = 1; socket.bufferedAmount = 0; socket.frames = 0;
    socket.feed = value => socket.emit('message', JSON.stringify(value));
    socket.close = socket.terminate = () => { if (socket.readyState === 3) return; socket.readyState = 3; socket.emit('close'); };
    socket.send = data => {
      const event = JSON.parse(data);
      if (event.type === 'session.update') {
        socket.updates = (socket.updates || 0) + 1;
        if (socket.frames > 0) {
          socket.feed({ type: 'error', error: { message: 'Session update error: session already started or finished or failed.' } }); return;
        }
        if (event.session.translation) socket.targetLanguage = event.session.translation.language;
        socket.modalities = event.session.output_modalities || socket.modalities;
        queueMicrotask(() => socket.feed({ type: 'session.updated' }));
      }
      if (event.type === 'input_audio_buffer.append' && ++socket.frames === 2) {
        socket.feed({ type: 'conversation.item.created', previous_item_id: null, item: { id: 'source', role: 'assistant', content: [{ type: 'input_audio' }] } });
        socket.feed({ type: 'conversation.item.created', previous_item_id: null, item: { id: 'translation', role: 'assistant', content: [] } });
        socket.feed({ type: 'input_audio_buffer.speech_started', item_id: 'source', speaker_id: 3 });
        socket.feed({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'source', delta: socket.targetLanguage === 'zh' ? 'This API' : '这个 API' });
        socket.feed({ type: 'conversation.item.created', previous_item_id: 'source', item: { id: 'translation', role: 'assistant' } });
        setTimeout(() => {
          if (socket.readyState !== 1) return;
          socket.feed({ type: socket.targetLanguage === 'zh' ? 'response.text.delta' : 'response.audio_transcript.delta', response_id: 'response', item_id: 'translation', delta: socket.targetLanguage === 'zh' ? '这个 API' : 'This API' });
          if (socket.modalities.includes('audio')) { socket.audioSent = true; socket.feed({ type: 'response.audio.delta', item_id: 'translation', delta: Buffer.alloc(4800).toString('base64') }); }
        }, 500);
      }
      if (event.type === 'session.finish') {
        socket.feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'source', transcript: socket.targetLanguage === 'zh' ? 'This API needs a retry.' : '这个 API 需要重试。' });
        socket.feed({ type: 'response.done', response: { id: 'response', status: 'completed', output: [{ id: 'translation', content: [{ transcript: socket.targetLanguage === 'zh' ? '这个 API 需要重试。' : 'This API needs a retry.' }] }] } });
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
  const view = (script, gesture = false) => win.webContents.executeJavaScript(script, gesture);
  const click = selector => view(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
  const entries = () => view("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries");
  await win.webContents.executeJavaScript(`
    globalThis.fixtureAudioContexts = []; globalThis.fixtureMicStreams = []; globalThis.fixtureSystemStreams = [];
    globalThis.fixturePlaybackSinks = [];
    const createInput = async streams => {
      const context = new AudioContext(); const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      fixtureAudioContexts.push(context); streams.push(destination.stream); await context.resume(); return destination.stream;
    };
    navigator.mediaDevices.getUserMedia = () => createInput(fixtureMicStreams);
    navigator.mediaDevices.getDisplayMedia = () => createInput(fixtureSystemStreams);
    globalThis.fixtureDevices = [
      { kind: 'audiooutput', deviceId: 'default', groupId: 'headset', label: 'Default headphones' },
      { kind: 'audiooutput', deviceId: 'fixture-cable', groupId: 'cable', label: 'CABLE Input (fixture)' },
    ];
    navigator.mediaDevices.enumerateDevices = async () => fixtureDevices;
    AudioContext.prototype.setSinkId = async function(id) { this.fixtureSinkId = id; };
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) {
      fixturePlaybackSinks.push(this.context.fixtureSinkId || 'default');
      return originalStart.apply(this, args);
    };
    document.querySelector('#mic-button').click();
  `, true);
  await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#transcript').textContent.includes('This API')"), 'live captions while input remains open');
  assert.equal(await view("document.querySelector('[name=scenario]:checked').value"), 'translation');
  assert.equal(await view("document.querySelector('#system-button').hidden && document.querySelector('#voice-panel').hidden"), true);
  assert.equal(await view("document.querySelector('#scenario-picker').disabled"), true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#transcript').textContent.includes('中文翻译正在跟进')"), true, 'English must appear before the delayed Chinese result');
  await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#transcript .chinese').textContent === '这个 API'"), 'Chinese follows English during capture');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#transcript .english').textContent"), 'This API');
  assert.equal(upstreams[0].targetLanguage, 'zh'); assert.deepEqual(upstreams[0].modalities, ['text']);
  assert.equal(await view("document.querySelector('#mic-button').textContent"), '停止麦克风翻译');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#queue-status').textContent.includes('实时同传中')"), true);
  await waitFor(() => win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries.length > 0"), 'interim persistence');
  assert.equal(await win.webContents.executeJavaScript("JSON.parse(localStorage.getItem('bridge.meetings'))[0].entries[0].status"), 'live');
  win.setSize(1441, 1000);
  await delay(150);
  fs.writeFileSync(path.join(out, 'streaming.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#stop-audio').click()", true);
  await waitFor(() => win.webContents.executeJavaScript("document.querySelector('#transcript').textContent.includes('This API needs a retry.') && document.querySelector('#queue-status').textContent === '等待接入音频'"), 'stop drains final transcript');
  const [firstEntry] = await entries();
  assert.equal(firstEntry.status, 'done'); assert.equal(firstEntry.original, 'This API needs a retry.');
  assert.equal(firstEntry.chinese, '这个 API 需要重试。'); assert.equal(firstEntry.english, 'This API needs a retry.');
  assert.equal(firstEntry.targetLanguage, 'zh'); assert.equal(firstEntry.source, 'remote'); assert.equal(firstEntry.audioSource, 'mic');
  assert.equal(upstreams[0].audioSent, undefined);
  assert.ok(upstreams[0].frames >= 2); assert.equal(upstreams[0].readyState, 3);
  assert.equal(await view("fixtureMicStreams[0].getTracks().every(track => track.readyState === 'ended')"), true);
  assert.deepEqual(rendererErrors, []);
  await click('[name=scenario][value=meeting]');
  assert.equal(await view("document.querySelector('#autoplay').checked || fixtureMicStreams.length !== 1"), false, 'switching scenario does not activate the microphone');
  await click('#autoplay');
  await waitFor(() => view("document.querySelector('#playback-status').textContent.includes('独立的会议英文输出')"), 'missing virtual output explains recovery');
  assert.equal(await view("document.querySelector('#autoplay').checked || fixtureMicStreams.length !== 1"), false, 'failed output validation leaves the microphone off');
  await click('#output-settings');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#capture-mode').value"), 'realtime');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#qwen-liveModel').value"), 'qwen3.8-livetranslate-flash-realtime');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#qwen-liveVoice').value"), 'Aiden');
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#qwen-voice').value"), 'Aiden');
  await waitFor(() => view("Boolean(document.querySelector('#output-device [value=fixture-cable]'))"), 'virtual output device listed');
  await view("document.querySelector('#output-device').value = 'fixture-cable'");
  if (settingsStore) {
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('#settings-storage-note').textContent.includes('重启自动恢复')"), true);
  }
  await click('#settings-form button[type=submit]');
  await waitFor(() => view("!document.querySelector('#settings-dialog').open"), 'persist settings from UI');
  if (settingsStore) assert.equal((await settingsStore.load(initialConfig({}))).providers.qwen.key, 'ui-fixture-only');

  await click('#system-button');
  await waitFor(() => upstreams[1]?.frames >= 2, 'meeting audio connected');
  const systemAudio = upstreams[1];
  assert.equal(systemAudio.targetLanguage, 'zh'); assert.deepEqual(systemAudio.modalities, ['text']);
  await click('#autoplay');
  await waitFor(() => upstreams[2]?.audioSent === true, 'turning on English output opens a separate microphone and streams audio');
  const microphone = upstreams[2];
  assert.equal(microphone.targetLanguage, 'en'); assert.deepEqual(microphone.modalities, ['text', 'audio']);
  await waitFor(() => view("document.querySelector('#autoplay').checked && fixturePlaybackSinks.includes('fixture-cable')"), 'English frames use the dedicated sink');
  assert.deepEqual(await view("[...new Set(fixturePlaybackSinks)]"), ['fixture-cable']);
  const currentEntries = await entries();
  assert.equal(currentEntries.find(entry => entry.audioSource === 'system').source, 'remote');
  assert.equal(currentEntries.find(entry => entry.targetLanguage === 'en').source, 'me');
  assert.equal(await view("document.querySelector('#mic-button').textContent"), '关闭我的麦克风');
  assert.equal(await view("document.querySelector('#system-button').textContent"), '断开会议音频');
  win.setSize(1442, 1000);
  await delay(150);
  fs.writeFileSync(path.join(out, 'meeting.png'), (await win.webContents.capturePage()).toPNG());

  const english = 'I can take the next question.';
  const played = await view('fixturePlaybackSinks.length');
  microphone.feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'english-source', transcript: english, language: 'en' });
  microphone.feed({ type: 'conversation.item.created', previous_item_id: 'english-source', item: { id: 'english-result', role: 'assistant' } });
  microphone.feed({ type: 'response.audio.delta', item_id: 'english-result', delta: Buffer.alloc(4800).toString('base64') });
  microphone.feed({ type: 'response.done', response: { id: 'english-response', status: 'completed', output: [{ id: 'english-result', content: [{ transcript: english }] }] } });
  await waitFor(async () => (await entries()).some(entry => entry.original === english && entry.status === 'done'), 'same-language English output and original persisted');
  const englishEntry = (await entries()).find(entry => entry.original === english);
  assert.equal(englishEntry.english, english); assert.equal(englishEntry.chinese, '');
  assert.ok(await view(`fixturePlaybackSinks.length > ${played}`));
  assert.equal(await view("document.querySelector('.entry.me .caption-label').textContent"), '麦克风原文');

  for (const enabled of [false, true, false, true]) {
    await click('#autoplay');
    await waitFor(() => view(`!document.querySelector('#autoplay').disabled && document.querySelector('#autoplay').checked === ${enabled}`), 'English mute or resume settled');
    assert.equal(await view("document.querySelector('#mic-button').textContent"), '关闭我的麦克风');
    assert.equal(microphone.updates, 1, 'playback must never reconfigure a running provider session');
  }
  microphone.feed({ type: 'response.audio.delta', item_id: 'translation', delta: Buffer.alloc(24000 * 2 * 9).toString('base64') });
  await waitFor(() => view("!document.querySelector('#autoplay').checked && document.querySelector('#playback-status').textContent.includes('积压')"), 'backlog automatically mutes playback');
  assert.equal(microphone.updates, 1, 'automatic backlog pause must also preserve the session');
  await click('#autoplay');
  await waitFor(() => view("document.querySelector('#autoplay').checked && !document.querySelector('#autoplay').disabled"), 'resumed English output');
  await view("fixtureDevices[0].groupId = 'cable'; navigator.mediaDevices.dispatchEvent(new Event('devicechange'))");
  await waitFor(() => view("!document.querySelector('#autoplay').checked && document.querySelector('#playback-status').textContent.includes('需要分开')"), 'English output mutes if the cable becomes the default playback device');
  microphone.feed({ type: 'response.audio_transcript.delta', item_id: 'translation', delta: ' continues' });
  await waitFor(() => view("document.querySelector('.entry.me .english').textContent === 'This API continues'"), 'captions continue after stopping speech');
  assert.equal(microphone.updates, 1);
  const systemFrames = systemAudio.frames;
  microphone.feed({ type: 'error', error: { message: 'Fixture connection dropped' } });
  await waitFor(() => view("fixtureMicStreams[1].getTracks().every(track => track.readyState === 'ended')"), 'error releases microphone');
  const partial = (await entries()).find(entry => entry.english === 'This API continues');
  assert.equal(partial.status, 'error'); assert.equal(partial.english, 'This API continues'); assert.equal(partial.originalConfirmed, false);
  assert.equal(microphone.readyState, 3);
  await waitFor(() => systemAudio.frames > systemFrames, 'incoming captions stay connected after microphone failure');
  await click('#stop-audio');
  await waitFor(() => view("!document.querySelector('#scenario-picker').disabled"), 'stop drains incoming captions');
  assert.equal((await entries()).find(entry => entry.audioSource === 'system').status, 'done');
  assert.equal(await view("fixtureSystemStreams[0].getTracks().every(track => track.readyState === 'ended')"), true);
  assert.equal(await view("JSON.parse(localStorage.getItem('bridge.preferences')).scenario"), 'meeting');

  await click('[name=scenario][value=translation]');
  win.setSize(390, 844);
  await delay(150);
  fs.writeFileSync(path.join(out, 'complete.png'), (await win.webContents.capturePage()).toPNG());
  const viewport = await view("({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth })");
  assert.equal(viewport.content, viewport.width, 'no horizontal overflow on a phone viewport');
  assert.deepEqual(rendererErrors, []);
  await win.webContents.executeJavaScript("Promise.all(fixtureAudioContexts.map(context => context.close()))");
  console.log('Realtime UI verified listening, concurrent meeting capture and English output, same-language output, muting, routing failure, and caption recovery.');
  console.log(`Screenshots: ${out}`);
}).catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  win?.destroy(); handler?.upgrade.close(); server?.closeAllConnections(); server?.close(); app.exit(process.exitCode || 0);
});
