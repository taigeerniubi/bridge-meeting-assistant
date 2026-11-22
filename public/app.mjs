import { AudioCapture, base64Audio } from './capture.mjs';
import { RealtimeCapture, PcmStreamPlayer } from './live.mjs';
import { createMeeting, demoMeeting, defaultGlossary, recoverMeeting, exportMarkdown } from './store.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
let meetings = read('bridge.meetings', []).map(recoverMeeting);
let glossary = read('bridge.glossary', defaultGlossary);
const preferences = read('bridge.preferences', {});
preferences.scenario ??= preferences.micTargetLanguage === 'en' ? 'meeting' : 'translation';
let meeting = meetings.find(m => m.id === read('bridge.active', '')) || meetings[0];
if (!meeting) { meeting = createMeeting(); meetings.unshift(meeting); }
let config, csrf, liveAvailable = false, persistentSettings = false, language = 'both', editingId, summaryBusy = false, ending = false;
let pending = 0, captureStops = 0, toastTimer, storageFailed = false;
const captures = new Map(), starting = new Set(), laneQueues = new Map(), audioBuffers = new Map();
const jobs = new Set();
let speechQueue = [], speaking = false, playbackActive = false, speechGeneration = 0, speechAbort, currentAudio, cancelPlayback, playbackGap;
let liveSpeaking = false, englishOutput = null, enablingEnglish = false, englishOutputError = '';
let liveRenderTimer, liveSaveTimer;
const liveMode = () => preferences.captureMode !== 'utterance';
const onlineMeeting = () => preferences.scenario === 'meeting';
const captureBusy = () => captures.size > 0 || starting.size > 0 || captureStops > 0 || enablingEnglish;
const meetingClosed = () => ending || meeting.demo || Boolean(meeting.endedAt);
const hasLiveDraft = () => meeting.entries.some(entry => entry.status === 'live');
const translatesToEnglish = entry => (entry.targetLanguage || (entry.source === 'me' ? 'en' : 'zh')) === 'en';
const audioSourceName = kind => kind === 'system' ? '会议音频' : '麦克风';
const livePlayer = new PcmStreamPlayer({ onActivity: active => {
  liveSpeaking = active;
  updateActivity();
} });

function updateLiveView(final = false) {
  if (final) {
    clearTimeout(liveRenderTimer); clearTimeout(liveSaveTimer); liveRenderTimer = liveSaveTimer = null;
    save(); renderTranscript(); renderSummary(); return;
  }
  liveRenderTimer ||= setTimeout(() => { liveRenderTimer = null; renderTranscript(); }, 100);
  liveSaveTimer ||= setTimeout(() => { liveSaveTimer = null; save(); }, 400);
}

function toast(message, error = false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, error ? 8500 : 4500);
}

function save() {
  try {
    localStorage.setItem('bridge.meetings', JSON.stringify(meetings));
    localStorage.setItem('bridge.active', JSON.stringify(meeting.id));
    localStorage.setItem('bridge.glossary', JSON.stringify(glossary));
    localStorage.setItem('bridge.preferences', JSON.stringify(preferences));
    storageFailed = false; $('#save-status').textContent = '会议文字已保存到当前浏览器';
  } catch {
    if (!storageFailed) toast('本机存储空间不足，当前记录尚未保存。请及时导出记录。', true);
    storageFailed = true; $('#save-status').textContent = '存储失败，请立即导出记录';
  }
}

async function api(path, body, options = {}) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': csrf || '' }, body: JSON.stringify(body),
    signal: AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(150000)]),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败（${response.status}）`);
  }
  return options.audio ? response.blob() : response.json();
}

function hasService(stage) { return config && config.providers[config.routing[stage]].configured; }
function requireService(stage) {
  if (!hasService(stage)) { openSettings(); throw new Error(`请先配置${stage === 'asr' ? '语音识别' : stage === 'speech' ? '英文语音' : '翻译'}服务的 API Key。`); }
}

async function bootstrap() {
  try {
    const response = await fetch('/api/bootstrap');
    const data = await response.json();
    if (data.locked) { $('#unlock-dialog').showModal(); return; }
    if (!response.ok) throw new Error(data.error || '无法连接本机服务。');
    config = data.config; csrf = data.csrf; liveAvailable = data.capabilities?.liveTranslation === true;
    persistentSettings = data.capabilities?.persistentSettings === true;
    $('#test-notice').hidden = !data.testMode;
    renderService();
  } catch (error) { $('#service-status').textContent = '服务未连接'; toast(error.message, true); }
}

function renderService() {
  const ready = liveMode() ? liveAvailable && config?.providers.qwen.configured : ['asr', 'text'].every(hasService);
  $('#service-status').textContent = ready ? '服务已配置' : '服务待配置';
  $('#service-status').classList.toggle('ready', ready);
  $('#setup-notice').hidden = ready || meeting.demo;
  const provider = config?.providers[liveMode() ? 'qwen' : config.routing.speech];
  const voice = liveMode() ? provider?.liveVoice : provider?.voice;
  $('#voice-description').textContent = voice === 'Aiden' ? 'Aiden · 艾登，美式男声。可在设置中更换音色。' : voice ? `当前音色：${voice}。Qwen 口音由音色决定；OpenAI 可提示英美口音。` : '可在服务设置中选择英文音色。';
}

function renderHistory() {
  $('#history-list').innerHTML = meetings.map(m => `<button class="history-item ${m.id === meeting.id ? 'active' : ''}" data-meeting="${esc(m.id)}"><b>${esc(m.title)}</b><span>${m.demo ? '示例会议' : new Date(m.createdAt).toLocaleDateString('zh-CN')} · ${m.entries.length} 条记录</span></button>`).join('');
  $('#mobile-history').innerHTML = meetings.map(m => `<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('');
  $('#mobile-history').value = meeting.id;
}

function realtimeContent(entry) {
  const toEnglish = translatesToEnglish(entry);
  const block = (className, label, value, placeholder, lang = '') => `<div class="caption-block"><div class="caption-label">${label}</div><div class="${className}"${lang ? ` lang="${lang}"` : ''}>${esc(value || placeholder)}</div></div>`;
  const english = block('english', toEnglish ? '英文输出' : '英文原文', entry.spokenText || entry.english, toEnglish ? '英文正在跟进…' : '正在识别英文…', 'en');
  const other = toEnglish ? block('chinese', '麦克风原文', entry.original, '正在识别麦克风…') : block('chinese', '中文翻译', entry.chinese, '中文翻译正在跟进，英文会继续显示…', 'zh');
  let captions = toEnglish ? other + english : english + other;
  if (language === 'zh') captions = toEnglish && !entry.chinese ? '' : other;
  const status = entry.status === 'live' ? '实时更新 · 暂定内容会继续修正' : entry.status === 'done' ? '同传已完成' : '同传中断 · 以下为已收到的内容';
  return `<div class="live-entry-status">${status}</div>${captions}${entry.error ? `<div class="entry-error">${esc(entry.error)}</div>` : ''}`;
}

function renderTranscript(scroll = false) {
  const container = $('#transcript');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
  if (!meeting.entries.length) {
    const instruction = onlineMeeting() ? '接入会议音频，查看对方的中文字幕。' : '开始麦克风翻译，查看对方的英文原文和中文字幕。';
    container.innerHTML = `<div class="empty-state"><div class="empty-visual" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><h3>等待发言</h3><p>${instruction}</p></div>`;
  } else {
    container.innerHTML = meeting.entries.map(e => {
      const successful = e.status === 'done';
      const status = { queued: '等待处理…', recognizing: '正在识别语音…', translating: '正在翻译…' }[e.status];
      const content = e.input === 'realtime' ? realtimeContent(e) : successful ? `<div class="chinese">${esc(e.chinese)}</div>${language === 'both' ? `<div class="english" lang="en">${esc(e.spokenText || e.english)}</div>` : ''}` : e.status === 'error' ? `<div class="entry-error">${esc(e.error)}</div>${e.original ? `<div class="original-text">${esc(e.original)}</div>` : ''}` : `<div class="pending">${status || '处理中…'}</div>${e.original ? `<div class="original-text">${esc(e.original)}</div>` : ''}`;
      const origin = meeting.demo ? '示例' : e.audioSource && e.input !== 'text' ? audioSourceName(e.audioSource) : e.input === 'realtime' ? '实时音频' : e.input === 'audio' ? '音频' : '文字';
      return `<article class="entry ${e.source === 'me' ? 'me' : 'remote'}" id="entry-${esc(e.id)}"><div class="speaker-avatar">${e.source === 'me' ? '我' : 'EN'}</div><div class="entry-content"><div class="entry-meta"><b>${e.source === 'me' ? '我的发言' : `对方${e.speakerLabel ? ` · ${esc(e.speakerLabel)}` : '发言'}`}</b><time>${time(e.time)}</time><span class="entry-origin">${origin}</span></div><div class="translation">${content}</div><div class="entry-tools">${successful && e.source === 'me' ? `<button class="text-button" data-play="${esc(e.id)}">▷ 本机播放英文</button><button class="text-button" data-edit="${esc(e.id)}">编辑后播放</button>` : ''}${successful ? `<button class="text-button" data-copy="${esc(e.id)}">复制${translatesToEnglish(e) ? '英文' : '中文'}</button><details><summary>原文</summary><div class="original-text">${esc(e.original)}</div></details>` : ''}${e.status === 'error' ? `<button class="text-button" data-retry="${esc(e.id)}">重试</button>` : ''}${e.uncertain ? '<span class="uncertain">有歧义，请核对原文</span>' : ''}${e.elapsed && !meeting.demo ? `<span>${e.elapsed.toFixed(1)}s 处理</span>` : ''}</div></div></article>`;
    }).join('');
  }
  $('#entry-count').textContent = `${meeting.entries.length} 条`;
  if (scroll || atBottom) container.scrollTop = container.scrollHeight;
  updateActivity();
}

function renderSummary() {
  const container = $('#summary-content');
  const value = meeting.summary;
  if (summaryBusy) { container.innerHTML = '<p class="pending">正在核对记录并整理纪要…</p>'; return; }
  if (!value) {
    container.innerHTML = '<div class="summary-empty"><b>讨论有记录，行动有方向。</b><p>结束会议后整理要点，也可以随时<br>生成当前进度的纪要。</p><div class="summary-tags"><span>技术结论</span><span>行动清单</span><span>待确认问题</span></div></div>'; return;
  }
  const references = item => item.sourceIds.map(id => `<button class="source-ref" data-reference="${esc(id)}">原文 ${meeting.entries.findIndex(e => e.id === id) + 1}</button>`).join('');
  const groups = [
    ['已确定事项', value.decisions, i => esc(i.text)],
    ['行动清单', value.actions, i => `${esc(i.task)}<small>${esc(i.owner)} · ${esc(i.due)}</small>`],
    ['待确认问题', value.questions, i => esc(i.text)],
  ];
  const count = meeting.entries.filter(e => e.status === 'done').length;
  container.innerHTML = `${meeting.summaryCount !== count ? '<p class="summary-stale">有新的发言，重新生成可更新纪要。</p>' : ''}${meeting.entries.some(e => e.status === 'error') ? '<p class="summary-stale">有处理失败的记录，尚未纳入本次纪要。</p>' : ''}<p class="summary-overview">${esc(value.overview)}</p>${groups.map(([title, items, content]) => `<div class="summary-group"><h3>${title} <span class="muted-count">${items.length}</span></h3>${items.length ? items.map(i => `<div class="summary-item">${content(i)}<div>${references(i)}</div></div>`).join('') : '<p class="fine-print">暂未记录</p>'}</div>`).join('')}`;
}

function renderMeeting() {
  $('#meeting-title').value = meeting.title;
  $('#meeting-date').textContent = new Date(meeting.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  $('#demo-notice').hidden = !meeting.demo;
  $('#text-source').value = onlineMeeting() ? 'me' : 'remote';
  renderService(); renderHistory(); renderTranscript(); renderSummary(); updateActivity();
}

function updateActivity() {
  const online = onlineMeeting();
  const locked = captureBusy() || pending > 0 || ending;
  const disabled = meetingClosed();
  const micActive = captures.has('mic');
  const systemActive = captures.has('system');
  $('#live-mark').classList.toggle('on', captures.size > 0);
  $('#queue-status').textContent = meeting.demo ? '预置示例 · 非实时识别' : starting.size ? '正在接入音频…' : captureStops ? '正在收取最后的字幕与译文…' : captures.size && liveMode() ? '实时同传中 · 可以连续说话' : pending ? `${pending} 条处理中` : speaking ? '语音生成 / 播报中' : captures.size ? '短句模式 · 停顿后翻译' : meeting.endedAt ? '会议已结束' : '等待接入音频';
  $(`#scenario-picker input[value="${online ? 'meeting' : 'translation'}"]`).checked = true;
  $('#scenario-picker').disabled = locked;
  $('#scenario-lock').hidden = !locked;
  $('#stop-audio').hidden = captures.size === 0;
  $('#stop-audio').disabled = starting.size > 0 || enablingEnglish || captureStops > 0;
  $('#mic-button').classList.toggle('active', micActive);
  const micLabel = online ? ['开启我的麦克风', '关闭我的麦克风'] : ['开始麦克风翻译', '停止麦克风翻译'];
  $('#mic-button').textContent = micActive ? micLabel[1] : micLabel[0];
  $('#mic-button').disabled = disabled || starting.has('mic') || enablingEnglish || captureStops > 0;
  $('#system-button').hidden = !online;
  $('#system-button').classList.toggle('active', systemActive);
  $('#system-button').textContent = systemActive ? '断开会议音频' : '接入会议音频';
  $('#system-button').disabled = disabled || starting.has('system') || captureStops > 0;
  $('#level-system').hidden = !online;
  $('#finish-button').disabled = disabled || summaryBusy || starting.size > 0 || captureStops > 0 || enablingEnglish;
  $('#summary-button').disabled = summaryBusy || ending || Boolean(pending) || hasLiveDraft() || !meeting.entries.some(e => e.status === 'done');
  $('#translate-button').disabled = disabled;
  $('#text-input').disabled = disabled;
  $('#new-meeting').disabled = ending || summaryBusy;
  $('#finish-button').textContent = ending ? '正在结束…' : meeting.endedAt ? '会议已结束' : '结束并总结';
  updateVoiceControls(online, disabled);
}

function updateVoiceControls(online, disabled) {
  $('#voice-panel').hidden = !online && !speaking;
  $('#meeting-voice-controls').hidden = !online;
  $('#autoplay-label').textContent = liveMode() ? '实时说话转英文' : '说话转英文';
  $('#autoplay').checked = Boolean(englishOutput);
  $('#autoplay').disabled = !online || disabled || enablingEnglish || starting.has('mic') || captureStops > 0;
  $('#stop-speech').disabled = !englishOutput && !speaking && !liveSpeaking;
  const status = $('#playback-status');
  status.classList.toggle('error', Boolean(englishOutputError));
  if (speaking && !englishOutputError && !enablingEnglish) return;
  let message = englishOutputError;
  if (!message) {
    if (enablingEnglish) message = '正在连接麦克风与英文输出…';
    else if (englishOutput) message = liveSpeaking ? `正在输出英文到 ${englishOutput.label}` : `英文输出已开启 · ${englishOutput.label}`;
    else message = captures.has('mic') ? '麦克风已开启 · 仅显示字幕' : '开启开关后接入麦克风并输出英文语音';
  }
  if (status.textContent !== message) status.textContent = message;
}

function addJob(entry, buffer, outputGeneration) {
  const target = meeting;
  const glossarySnapshot = structuredClone(glossary);
  if (buffer) audioBuffers.set(entry.id, buffer);
  entry.status = 'queued'; entry.error = null; pending++;
  if (!target.entries.includes(entry)) target.entries.push(entry);
  save(); renderTranscript(true); renderHistory(); renderSummary();
  const previous = laneQueues.get(entry.source) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const start = performance.now();
    try {
      if (!entry.original) {
        entry.status = 'recognizing'; renderTranscript();
        const audio = audioBuffers.get(entry.id);
        if (!audio) throw new Error('该音频未保存，请重新录入。');
        const result = await api('/api/transcribe', { audio: base64Audio(audio), glossary: glossarySnapshot });
        entry.original = result.text;
        if (!result.text.trim()) throw new Error('未识别到语音，请检查音量后重试。');
      }
      entry.status = 'translating'; renderTranscript(); save();
      const context = target.entries.slice(0, target.entries.indexOf(entry)).filter(e => e.status === 'done').slice(-8).map(e => ({ source: e.source, original: e.original }));
      const result = await api('/api/translate', { text: entry.original, source: entry.source, glossary: glossarySnapshot, context });
      Object.assign(entry, result, { status: 'done', elapsed: (performance.now() - start) / 1000 });
      audioBuffers.delete(entry.id);
      if (outputGeneration === speechGeneration && englishOutput && !result.uncertain && !ending && !target.endedAt && target === meeting) queueSpeech(entry, englishOutput.deviceId);
    } catch (error) { entry.status = 'error'; entry.error = error.message; }
    finally { pending--; save(); if (target === meeting) { renderTranscript(); renderSummary(); } }
  });
  jobs.add(job); laneQueues.set(entry.source, job);
  job.finally(() => { jobs.delete(job); if (laneQueues.get(entry.source) === job) laneQueues.delete(entry.source); });
}

async function toggleCapture(kind) {
  if (captureStops || starting.has(kind) || meetingClosed()) return;
  if ((kind === 'system' && !onlineMeeting()) || (kind === 'mic' && enablingEnglish)) return;
  if (captures.has(kind)) { await stopCapture(kind); return; }
  try {
    if (speaking && !englishOutput) stopSpeech();
    await startCapture(kind);
  } catch (error) { toast(error.message, true); }
}

async function startCapture(kind) {
  const ownMic = onlineMeeting() && kind === 'mic';
  const route = { source: ownMic ? 'me' : 'remote', targetLanguage: ownMic ? 'en' : 'zh', audioSource: kind };
  starting.add(kind); updateActivity();
  try {
    if (liveMode()) { await startLiveCapture(kind, route); return; }
    requireService('asr'); requireService('text');
    const target = meeting;
    const capture = new AudioCapture({
      onSegment: buffer => {
        if (target !== meeting || target.endedAt) return;
        const outputGeneration = ownMic && englishOutput ? speechGeneration : undefined;
        addJob({ id: crypto.randomUUID(), ...route, input: 'audio', time: new Date().toISOString(), original: '' }, buffer, outputGeneration);
        if (pending >= 10) { void stopCapture(); toast('处理速度暂时跟不上输入，已停止采集并继续处理现有片段。处理完成后可重新开启。', true); }
      },
      onLevel: rms => setAudioLevel(kind, rms),
      onEnded: () => { if (removeCapture(kind, capture)) toast(`${audioSourceName(kind)}已断开。`); },
      onError: error => { if (captures.get(kind) === capture) { toast(error.message, true); void stopCapture(kind); } },
    });
    await capture.start(kind, preferences.microphone);
    if (capture.stopping) throw new Error('音频接入已中断，请重新开启。');
    captures.set(kind, capture); setPlaybackGate(playbackActive);
    toast(`${audioSourceName(kind)}已接入，停顿后更新双语记录。`);
  } finally { starting.delete(kind); updateActivity(); }
}

function setAudioLevel(kind, rms) {
  $(`#level-${kind}`).style.height = `${Math.min(18, Math.max(3, rms * 150))}px`;
}

function removeCapture(kind, capture) {
  if (captures.get(kind) !== capture) return false;
  captures.delete(kind);
  if (kind === 'mic' && onlineMeeting()) stopSpeech();
  updateActivity();
  return true;
}

async function getEnglishOutput(deviceId) {
  if (!deviceId || deviceId === 'default' || deviceId === 'communications') throw new Error('请在音频设置选择独立的会议英文输出，例如 CABLE Input。');
  const devices = await navigator.mediaDevices?.enumerateDevices?.();
  const outputs = devices?.filter(device => device.kind === 'audiooutput') || [];
  const selected = outputs.find(device => device.deviceId === deviceId);
  if (!selected) throw new Error('找不到选定的会议英文输出，请检查连接并在音频设置刷新设备。');
  const defaultOutput = outputs.find(device => device.deviceId === 'default');
  if (defaultOutput?.groupId && defaultOutput.groupId === selected.groupId) throw new Error('会议英文输出和 Windows 默认播放设备需要分开。请选择 CABLE Input，并将默认播放设备设为耳机。');
  return selected;
}

async function enableEnglishOutput() {
  if (!onlineMeeting() || meetingClosed() || enablingEnglish || captureStops || starting.has('mic')) { updateActivity(); return; }
  stopSpeech();
  const generation = speechGeneration;
  enablingEnglish = true; updateActivity();
  try {
    const output = await getEnglishOutput(preferences.output);
    if (liveMode()) await livePlayer.prepare(output.deviceId);
    else {
      requireService('speech');
      const audio = new Audio();
      if (!audio.setSinkId) throw new Error('当前设备无法指定会议英文输出，请使用 Windows 桌面版。');
      await audio.setSinkId(output.deviceId);
    }
    if (generation !== speechGeneration) return;
    englishOutput = { deviceId: output.deviceId, label: output.label || '已选设备' };
    if (captures.has('mic')) captures.get('mic').setAudioEnabled?.(true);
    else await startCapture('mic');
  } catch (error) {
    if (generation === speechGeneration) failEnglishOutput(error);
  } finally { enablingEnglish = false; updateActivity(); }
}

function failEnglishOutput(error) {
  stopSpeech();
  englishOutputError = error.message;
  updateActivity(); toast(error.message, true);
}

async function startLiveCapture(kind, route) {
  const target = meeting, sessionId = crypto.randomUUID(), entries = new Map(), speakers = new Map();
  const { source, targetLanguage } = route;
  const markInterrupted = message => {
    for (const entry of entries.values()) if (entry.status === 'live') { entry.status = 'error'; entry.error = message; }
    save(); if (target === meeting) { renderTranscript(); renderSummary(); }
  };
  if (!liveAvailable) throw new Error('本机服务尚未启用实时同传，请关闭并重新启动会议助手。');
  if (!config?.providers.qwen.configured) { openSettings(); throw new Error('实时同传需要配置 Qwen / 百炼 API Key。'); }
  const capture = new RealtimeCapture({ csrf, source, targetLanguage, glossary: structuredClone(glossary), audio: targetLanguage === 'en',
    onTranscript: result => {
      if (target !== meeting || (!result.original && !result.translated)) return;
      let entry = entries.get(result.id);
      if (!entry) {
        entry = { id: `${sessionId}-${result.id}`, ...route, input: 'realtime', time: new Date().toISOString(), status: 'live', original: '' };
        entries.set(result.id, entry); target.entries.push(entry); renderHistory();
      }
      if (Number.isInteger(result.speakerId) && source === 'remote') {
        if (!speakers.has(result.speakerId)) speakers.set(result.speakerId, speakers.size + 1);
        entry.speakerLabel = `发言者 ${speakers.get(result.speakerId)}`;
      }
      Object.assign(entry, { original: result.original, originalConfirmed: result.originalDone,
        chinese: targetLanguage === 'zh' ? result.translated : /\p{Script=Han}/u.test(result.original) ? result.original : '',
        english: targetLanguage === 'zh' ? result.original : result.translated,
        status: result.error ? 'error' : result.final ? 'done' : 'live', error: result.error || null });
      updateLiveView(Boolean(result.final || result.error));
    },
    onAudio: result => {
      if (targetLanguage !== 'en' || !englishOutput || captures.get(kind) !== capture || target !== meeting || ending) return;
      try { livePlayer.push(result.data, result.sampleRate); }
      catch (error) { failEnglishOutput(error); }
    },
    onLevel: rms => setAudioLevel(kind, rms),
    onEnded: () => { removeCapture(kind, capture); markInterrupted('音频已结束，最后一段未完整确认，请核对。'); },
    onError: error => {
      if (starting.has(kind)) return;
      const outputInterrupted = kind === 'mic' && Boolean(englishOutput);
      if (captures.get(kind) === capture) {
        captureStops++;
        removeCapture(kind, capture);
        void capture.stop().finally(() => { captureStops--; updateActivity(); });
      }
      markInterrupted(error.message);
      const now = new Date().toISOString();
      target.gaps.push({ start: now, end: now, reason: `${audioSourceName(kind)}实时连接中断：${error.message}` });
      save();
      if (outputInterrupted) failEnglishOutput(error);
      else toast(error.message, true);
    },
  });
  capture.setAudioEnabled(targetLanguage === 'en' && Boolean(englishOutput));
  try {
    await capture.start(kind, preferences.microphone);
    if (capture.stopping || capture.failed) { await capture.stop(); throw new Error('音频接入已中断，请重新开启。'); }
  } catch (error) {
    markInterrupted(error.message); throw error;
  }
  captures.set(kind, capture);
  toast(`${audioSourceName(kind)}已接入，${targetLanguage === 'zh' ? '中文字幕持续更新' : '我的原文和英文持续更新'}。`);
}

async function stopCapture(kind) {
  const active = [...captures].filter(([source]) => !kind || source === kind);
  if ((!kind || kind === 'mic') && onlineMeeting()) stopSpeech();
  for (const [source] of active) captures.delete(source);
  captureStops += active.length; updateActivity();
  try { await Promise.allSettled(active.map(([, capture]) => capture.stop())); }
  finally { captureStops -= active.length; updateActivity(); }
}

function setPlaybackGate(blocked) {
  playbackActive = blocked;
  for (const capture of captures.values()) capture.setBlocked(blocked);
  if (blocked && captures.size && !playbackGap) playbackGap = { target: meeting, start: new Date().toISOString() };
  if (!blocked && playbackGap) {
    playbackGap.target.gaps.push({ start: playbackGap.start, end: new Date().toISOString(), reason: '英文播报期间暂停采集以避免回声；此时其他发言未被记录。' });
    playbackGap = null; save();
  }
  updateActivity();
}

function queueSpeech(entry, outputDeviceId = '') {
  if (liveMode() && captureBusy()) { toast('请先停止实时采集，再重播历史译文。'); return; }
  try { requireService('speech'); } catch (error) { toast(error.message, true); return; }
  if (speechQueue.length >= 8) { failEnglishOutput(new Error('待播报内容过多，已停止英文语音。')); return; }
  if (speechQueue.some(item => item.entryId === entry.id)) return;
  speechQueue.push({ entryId: entry.id, text: entry.spokenText || entry.english, targetId: meeting.id, outputDeviceId });
  void drainSpeech();
}

async function drainSpeech() {
  if (speaking || !speechQueue.length) return;
  speaking = true;
  const generation = speechGeneration;
  let item;
  updateActivity();
  try {
    while (speechQueue.length && generation === speechGeneration) {
      item = speechQueue.shift();
      if (item.targetId !== meeting.id) continue;
      $('#playback-status').textContent = `正在生成英文语音${speechQueue.length ? ` · 后面还有 ${speechQueue.length} 条` : ''}`;
      speechAbort = new AbortController();
      const blob = await api('/api/speech', { text: item.text, accent: preferences.accent }, { audio: true, signal: speechAbort.signal });
      if (generation !== speechGeneration) break;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url); currentAudio = audio;
      try {
        if (item.outputDeviceId) await audio.setSinkId(item.outputDeviceId);
        if (generation !== speechGeneration) break;
        setPlaybackGate(true);
        $('#playback-status').textContent = item.outputDeviceId ? `正在输出英文到 ${englishOutput.label}` : '正在本机播放英文';
        await new Promise((resolve, reject) => {
          const finish = error => { cancelPlayback = null; audio.onended = null; audio.onerror = null; error ? reject(error) : resolve(); };
          cancelPlayback = () => { audio.pause(); finish(); };
          audio.onended = () => finish(); audio.onerror = () => finish(new Error('音频播放失败，请检查输出设备。'));
          audio.play().catch(() => finish(new Error('浏览器阻止了播放，请再点击一次“播放英文”。')));
        });
      } finally { audio.pause(); URL.revokeObjectURL(url); currentAudio = null; setPlaybackGate(false); }
    }
  } catch (error) {
    if (generation === speechGeneration) {
      speechQueue = [];
      if (item?.outputDeviceId) failEnglishOutput(error);
      else toast(error.message, true);
    }
  } finally {
    speaking = false; speechAbort = null; setPlaybackGate(false);
    if (speechQueue.length) void drainSpeech();
  }
}

function stopSpeech() {
  englishOutput = null; englishOutputError = '';
  captures.get('mic')?.setAudioEnabled?.(false);
  speechGeneration++; speechQueue = []; speechAbort?.abort(); cancelPlayback?.(); currentAudio?.pause();
  livePlayer.stop(); setPlaybackGate(false);
}

async function generateSummary() {
  if (meeting.demo) { renderSummary(); toast('当前展示的是示例纪要。新建会议可生成真实纪要。'); return; }
  if (pending || hasLiveDraft()) { toast('请等待正在处理的发言完成，或先停止采集收取最后结果。'); return; }
  const entries = meeting.entries.filter(e => e.status === 'done');
  if (!entries.length) { toast('还没有可总结的有效发言。'); return; }
  requireService('text');
  summaryBusy = true; renderSummary(); updateActivity();
  try {
    const result = await api('/api/summary', { title: meeting.title, entries: entries.map(e => ({ id: e.id, source: e.source, time: e.time, original: e.original })) });
    meeting.summary = result; meeting.summaryCount = entries.length; save();
  } finally { summaryBusy = false; renderSummary(); updateActivity(); }
}

async function finishMeeting() {
  if (ending || starting.size || enablingEnglish) return;
  ending = true; stopSpeech(); updateActivity();
  try {
    await stopCapture();
    await Promise.allSettled([...jobs]);
    meeting.endedAt = new Date().toISOString(); save();
    await generateSummary();
    toast('会议已结束，记录已保存。');
  } catch (error) { toast(`记录已保留。${error.message}`, true); }
  finally { ending = false; updateActivity(); renderHistory(); }
}

async function switchMeeting(target) {
  if (ending || summaryBusy) { toast('请等待当前操作完成。'); return; }
  if (pending || captureBusy()) { toast('请先停止采集，并等待当前片段处理完成，再切换会议。'); return; }
  stopSpeech(); meeting = target; save(); renderMeeting(); switchView('meeting');
}

function switchView(view) {
  $('#meeting-view').hidden = view !== 'meeting'; $('#glossary-view').hidden = view !== 'glossary';
  $('#view-name').textContent = view === 'meeting' ? '会议工作台' : 'IT 术语库';
  $$('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'glossary') renderGlossary();
}

function renderGlossary() {
  $('#term-count').textContent = glossary.length;
  $('#glossary-list').innerHTML = glossary.map((term, i) => `<tr><td>${esc(term.en)}</td><td>${esc(term.zh)}</td><td><button class="text-button danger" data-delete-term="${i}">移除</button></td></tr>`).join('');
}

function renderProviderFields() {
  $('#provider-fields').innerHTML = ['openai', 'qwen'].map(name => {
    const provider = config.providers[name];
    const field = (key, title, wide = false) => `<div class="field ${wide ? 'wide' : ''}"><label for="${name}-${key}">${title}</label><input id="${name}-${key}" value="${esc(provider[key])}" autocomplete="off"></div>`;
    return `<section class="settings-section"><h3>${name === 'openai' ? 'OpenAI' : 'Qwen / 阿里云百炼'}<span class="key-status">${provider.configured ? '密钥已配置' : '尚未配置'}</span></h3><div class="field"><label for="${name}-key">API Key</label><input id="${name}-key" type="password" autocomplete="new-password" placeholder="${provider.configured ? '已配置；留空保留现有密钥' : '在本机填写你的 API Key'}"></div><details><summary>模型、音色和服务地址</summary><div class="advanced-fields">${field('baseUrl', 'API Base URL', true)}${name === 'qwen' ? field('ttsUrl', '语音合成完整 URL（与密钥地域一致）', true) : ''}${field('asrModel', '识别模型')}${field('textModel', '翻译模型')}${field('speechModel', '语音模型')}${field('voice', '短句语音音色')}${name === 'qwen' ? `${field('liveUrl', '实时同传 WebSocket 地址', true)}${field('liveModel', '实时同传模型', true)}${field('liveVoice', '实时同传音色')}` : ''}</div><button type="button" class="text-button danger" data-clear-key="${name}">清除这家的密钥</button></details></section>`;
  }).join('');
}

async function enumerateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const populate = (selector, kind, selected, defaultLabel) => {
    const list = devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    $(selector).innerHTML = `<option value="">${defaultLabel}</option>${list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `设备 ${i + 1}`)}</option>`).join('')}`;
    if (selected && !list.some(d => d.deviceId === selected)) $(selector).insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">之前选择的设备（请授权或检查连接）</option>`);
    $(selector).value = selected || '';
  };
  populate('#microphone', 'audioinput', preferences.microphone, '系统默认麦克风');
  populate('#output-device', 'audiooutput', preferences.output, '请选择独立输出设备');
}

function openSettings() {
  if (!config) { toast('本机服务尚未连接，请刷新页面后重试。', true); return; }
  renderProviderFields();
  $('#settings-storage-note').textContent = persistentSettings ? '保存后，API Key 和服务配置会加密保存在本机，重启自动恢复。留空保留已有 Key；清除密钥后重启也不会恢复。' : '当前服务仅在内存中保留设置；可在本机 .env 文件中配置密钥。';
  for (const stage of ['asr', 'text', 'speech']) $(`#route-${stage}`).value = config.routing[stage];
  $('#capture-mode').value = liveMode() ? 'realtime' : 'utterance';
  $('#accent').value = preferences.accent || 'en-US';
  $('#settings-error').textContent = '';
  void enumerateDevices().catch(() => {});
  if (!$('#settings-dialog').open) $('#settings-dialog').showModal();
}

async function saveSettings(close = true) {
  if (captureBusy()) throw new Error('请先停止音频采集，再修改服务或设备设置。');
  const payload = { routing: {}, providers: {} };
  for (const stage of ['asr', 'text', 'speech']) payload.routing[stage] = $(`#route-${stage}`).value;
  for (const name of ['openai', 'qwen']) {
    payload.providers[name] = {};
    for (const key of ['key', 'baseUrl', 'ttsUrl', 'textModel', 'asrModel', 'speechModel', 'voice', 'liveUrl', 'liveModel', 'liveVoice']) {
      const input = $(`#${name}-${key}`); if (input) payload.providers[name][key] = input.value.trim();
    }
  }
  const data = await api('/api/settings', payload); config = data.config;
  preferences.microphone = $('#microphone').value; preferences.output = $('#output-device').value;
  preferences.captureMode = $('#capture-mode').value; preferences.accent = $('#accent').value;
  englishOutputError = '';
  save(); renderService(); renderProviderFields(); renderTranscript();
  if (close) $('#settings-dialog').close();
}

$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { await saveSettings(); toast(persistentSettings ? '设置已加密保存到本机，重启后自动恢复。' : '设置已保存到当前服务内存。'); } catch (error) { $('#settings-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#test-service').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; $('#settings-error').textContent = '正在测试，将产生一次短文本翻译调用…';
  try { await saveSettings(false); const result = await api('/api/translate', { text: '这个 API 需要增加重试机制。', glossary, context: [] }); $('#settings-error').textContent = `翻译连接成功：${result.english}（语音识别与播报需分别测试）`; }
  catch (error) { $('#settings-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#refresh-devices').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => t.stop()); await enumerateDevices(); $('#settings-error').textContent = '设备列表已刷新。'; }
  catch { $('#settings-error').textContent = '未能获取设备权限。手机需要 HTTPS，电脑请允许麦克风访问。'; }
  finally { button.disabled = false; }
});
$('#provider-fields').addEventListener('click', async event => {
  const name = event.target.closest('[data-clear-key]')?.dataset.clearKey;
  if (!name) return;
  try { const result = await api('/api/settings', { providers: { [name]: { clearKey: true } } }); config = result.config; renderProviderFields(); renderService(); }
  catch (error) { $('#settings-error').textContent = error.message; }
});
for (const id of ['settings-button', 'mobile-settings', 'setup-button']) $(`#${id}`).addEventListener('click', openSettings);
$('#output-settings').addEventListener('click', () => {
  openSettings();
  if ($('#settings-dialog').open) $('#output-device').focus();
});
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('close', () => { $$('#provider-fields input[type=password]').forEach(input => { input.value = ''; }); });
$('#unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/api/unlock', { token: $('#access-token').value }); $('#access-token').value = ''; $('#unlock-dialog').close(); await bootstrap(); }
  catch (error) { $('#unlock-error').textContent = error.message; }
});

$('#text-form').addEventListener('submit', event => {
  event.preventDefault();
  if (meeting.demo || meeting.endedAt || ending) return;
  const text = $('#text-input').value.trim(); if (!text) return;
  try { requireService('text'); } catch (error) { toast(error.message, true); return; }
  if (pending >= 10) { toast('请等待当前片段处理完成再发送。'); return; }
  addJob({ id: crypto.randomUUID(), original: text, input: 'text', time: new Date().toISOString(), source: $('#text-source').value });
  $('#text-input').value = '';
});
$('#text-input').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#text-form').requestSubmit(); } });
$('#scenario-picker').addEventListener('change', event => {
  if (captureBusy() || pending || ending) { updateActivity(); return; }
  preferences.scenario = event.target.value;
  stopSpeech();
  $('#text-source').value = onlineMeeting() ? 'me' : 'remote';
  save(); renderTranscript();
});
$('#mic-button').addEventListener('click', () => void toggleCapture('mic'));
$('#system-button').addEventListener('click', () => void toggleCapture('system'));
$('#stop-audio').addEventListener('click', () => void stopCapture());
$('#stop-speech').addEventListener('click', stopSpeech);
$('#autoplay').addEventListener('change', event => {
  if (event.target.checked) void enableEnglishOutput();
  else stopSpeech();
});
navigator.mediaDevices?.addEventListener('devicechange', async () => {
  const output = englishOutput;
  if (!output) return;
  try { await getEnglishOutput(output.deviceId); }
  catch (error) { if (englishOutput === output) failEnglishOutput(error); }
});
$('#finish-button').addEventListener('click', () => void finishMeeting());
$('#summary-button').addEventListener('click', () => void generateSummary().catch(error => toast(error.message, true)));
let titleSaveTimer;
$('#meeting-title').addEventListener('input', event => {
  meeting.title = event.target.value.trim() || '新的技术会议'; renderHistory();
  clearTimeout(titleSaveTimer); titleSaveTimer = setTimeout(save, 250);
});
$('#meeting-title').addEventListener('change', event => { event.target.value = meeting.title; save(); });
function newMeeting() {
  if (captureBusy() || pending || ending || summaryBusy) { toast('请先停止采集，并等待当前片段处理完成。'); return; }
  const next = createMeeting(); meetings.unshift(next); void switchMeeting(next);
}
$('#new-meeting').addEventListener('click', newMeeting);
$('#new-mobile').addEventListener('click', newMeeting);
$('#mobile-history').addEventListener('change', event => { const target = meetings.find(m => m.id === event.target.value); if (target) void switchMeeting(target).then(() => { $('#mobile-history').value = meeting.id; }); });
$('#demo-button').addEventListener('click', () => {
  if (captureBusy() || pending || ending || summaryBusy) { toast('请先停止采集，并等待当前片段处理完成。'); return; }
  let demo = meetings.find(m => m.demo); if (!demo) { demo = demoMeeting(); meetings.push(demo); }
  void switchMeeting(demo);
});
$('#history-list').addEventListener('click', event => { const id = event.target.closest('[data-meeting]')?.dataset.meeting; const target = meetings.find(m => m.id === id); if (target && target !== meeting) void switchMeeting(target); });
$$('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-language]').forEach(button => button.addEventListener('click', () => { language = button.dataset.language; $$('[data-language]').forEach(b => b.classList.toggle('selected', b === button)); renderTranscript(); }));
$('#transcript').addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  const id = button.dataset.play || button.dataset.edit || button.dataset.copy || button.dataset.retry;
  const entry = meeting.entries.find(e => e.id === id); if (!entry) return;
  if (button.dataset.play) queueSpeech(entry);
  if (button.dataset.edit) { editingId = entry.id; $('#edit-english').value = entry.spokenText || entry.english; $('#edit-dialog').showModal(); }
  if (button.dataset.copy) { try { await navigator.clipboard.writeText(translatesToEnglish(entry) ? entry.spokenText || entry.english : entry.chinese); toast('已复制。'); } catch { toast('浏览器不允许自动复制，请选中文字后复制。', true); } }
  if (button.dataset.retry && entry.status === 'error') {
    if (ending) { toast('请等待会议结束操作完成。'); return; }
    if (!entry.original && !audioBuffers.has(entry.id)) { toast('音频未保存，请重新录入。', true); return; }
    if (entry.input === 'realtime' && !entry.originalConfirmed) { toast('这段同传原文尚未完整确认，请重新录入。', true); return; }
    if (entry.input === 'realtime') entry.input = 'text';
    addJob(entry);
  }
});
$('#edit-form').addEventListener('submit', event => {
  event.preventDefault(); const entry = meeting.entries.find(e => e.id === editingId); const text = $('#edit-english').value.trim();
  if (entry && text) { entry.spokenText = text; save(); renderTranscript(); $('#edit-dialog').close(); queueSpeech(entry); }
});
$('#close-edit').addEventListener('click', () => $('#edit-dialog').close());
$('#summary-content').addEventListener('click', event => {
  const id = event.target.closest('[data-reference]')?.dataset.reference; if (!id) return;
  const element = document.getElementById(`entry-${id}`); if (!element) return;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' }); element.classList.remove('flash'); requestAnimationFrame(() => element.classList.add('flash'));
});
$('#export-button').addEventListener('click', () => {
  const blob = new Blob(['\ufeff', exportMarkdown(meeting)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url;
  link.download = `${meeting.title.replace(/[<>:"/\\|?*]/g, '_')}-${new Date(meeting.createdAt).toLocaleDateString('sv-SE')}.md`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已导出纪要和双语原文。');
});
$('#glossary-form').addEventListener('submit', event => {
  event.preventDefault(); const en = $('#term-en').value.trim(), zh = $('#term-zh').value.trim(); if (!en || !zh) return;
  const existing = glossary.find(term => term.en.toLowerCase() === en.toLowerCase());
  if (existing) existing.zh = zh; else { if (glossary.length >= 120) { toast('术语库最多 120 条，请保留本次会议相关术语。'); return; } glossary.push({ en, zh }); }
  save(); renderGlossary(); event.target.reset(); toast(existing ? '术语已更新。' : '术语已加入。');
});
$('#glossary-list').addEventListener('click', event => { const button = event.target.closest('[data-delete-term]'); if (!button) return; glossary.splice(Number(button.dataset.deleteTerm), 1); save(); renderGlossary(); });
window.addEventListener('beforeunload', event => { if (captureBusy() || pending || speaking || liveSpeaking) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && captures.size && /Android|iPhone|iPad/.test(navigator.userAgent)) toast('手机切到后台或锁屏可能中断录音，请保持页面在前台。', true);
});
setInterval(() => {
  const elapsed = Math.max(0, Math.floor(((meeting.endedAt ? new Date(meeting.endedAt).getTime() : Date.now()) - new Date(meeting.createdAt).getTime()) / 1000));
  $('#meeting-clock').textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
}, 1000);
renderMeeting(); renderGlossary(); save(); void bootstrap();
