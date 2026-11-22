import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { listPackage } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const artifact = path.join(root, 'release', `译桥-免安装-${version}-x64.exe`);
const files = listPackage(path.join(root, 'release/win-unpacked/resources/app.asar'));
assert.equal(files.some(file => /(?:^|[\\/])(?:\.env(?:\..*)?|\.local|\.git|tests|service-settings\.dpapi)(?:[\\/]|$)/.test(file)), false);
await mkdir(path.join(root, '.local'), { recursive: true });
const temporary = await mkdtemp(path.join(root, '.local', 'portable-check-'));
const directory = path.join(temporary, '中文 便携目录');
await mkdir(directory);
const executable = path.join(directory, path.basename(artifact));
await copyFile(artifact, executable);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = async () => {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return value;
};
const servicePort = await port(), debugPort = await port();
const origin = `http://127.0.0.1:${servicePort}`;
async function waitFor(check, description, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const value = await check(); if (value) return value; } catch { }
    await delay(250);
  }
  throw new Error(`Timed out: ${description}`);
}
const bootstrap = async () => (await fetch(`${origin}/api/bootstrap`, { signal: AbortSignal.timeout(1000) })).json();
function launch(debug = true) {
  const child = spawn(executable, debug ? [`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'] : [], {
    cwd: directory, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, DESKTOP_PORT: String(servicePort), OPENAI_API_KEY: '', DASHSCOPE_API_KEY: '' },
  });
  child.on('error', error => { child.launchError = error; });
  return child;
}
async function connect() {
  const page = await waitFor(async () => {
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
    return pages.find(item => item.type === 'page' && item.url.startsWith(origin));
  }, 'packaged renderer');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let nextId = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const event = JSON.parse(raw);
    const request = pending.get(event.id);
    if (request) { pending.delete(event.id); event.error ? request.reject(new Error(event.error.message)) : request.resolve(event.result); }
  });
  socket.on('close', () => { for (const request of pending.values()) request.reject(new Error('Browser closed')); pending.clear(); });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  return { command, async evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Packaged renderer evaluation failed');
    return result.result.value;
  } };
}

let child, browser;
async function close() {
  if (browser) { await browser.command('Browser.close').catch(() => {}); browser = null; }
  if (child) {
    await waitFor(() => child.exitCode !== null || child.launchError, 'portable launcher cleanup', 30000);
    assert.ifError(child.launchError); assert.equal(child.exitCode, 0);
    child = null;
  }
}
try {
  child = launch();
  const fresh = await waitFor(bootstrap, 'first portable launch');
  assert.equal(fresh.config.providers.qwen.configured, false, 'EXE must not contain a personal key');
  assert.equal(fresh.capabilities.persistentSettings, true);
  browser = await connect();
  await waitFor(() => browser.evaluate("document.querySelector('[name=scenario]:checked')?.value === 'translation' && document.querySelector('#system-button')?.hidden"), 'default translation mode');
  await browser.evaluate("document.querySelector('[name=scenario][value=meeting]').click()");
  assert.equal(await browser.evaluate("!document.querySelector('#system-button').hidden && !document.querySelector('#autoplay').checked"), true);
  await browser.evaluate("document.querySelector('#meeting-title').value = '便携版重启检查'; document.querySelector('#meeting-title').dispatchEvent(new Event('input')); document.querySelector('#meeting-title').dispatchEvent(new Event('change'));");
  const fakeKey = 'portable-test-key-not-a-real-key';
  const saved = await fetch(`${origin}/api/settings`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': fresh.csrf },
    body: JSON.stringify({ providers: { qwen: { key: fakeKey, liveVoice: 'Aiden' } } }),
  });
  assert.equal(saved.status, 200);
  const stored = await readFile(path.join(directory, '译桥数据/service-settings.dpapi'), 'utf8');
  assert.equal(stored.includes(fakeKey), false);
  await close();

  child = launch();
  const resumed = await waitFor(bootstrap, 'portable restart');
  assert.equal(resumed.config.providers.qwen.configured, true);
  assert.equal(resumed.config.providers.qwen.liveVoice, 'Aiden');
  browser = await connect();
  await waitFor(() => browser.evaluate("document.querySelector('#meeting-title')?.value === '便携版重启检查'"), 'meeting history after restart');
  assert.equal(await browser.evaluate("document.querySelector('[name=scenario]:checked').value === 'meeting' && !document.querySelector('#autoplay').checked"), true);
  const second = launch(false);
  await waitFor(() => second.exitCode !== null || second.launchError, 'second instance', 60000);
  assert.ifError(second.launchError); assert.equal(second.exitCode, 0);
  assert.equal((await bootstrap()).config.providers.qwen.configured, true);
  assert.equal(await browser.evaluate("document.querySelector('#meeting-title').value"), '便携版重启检查');
  await close();
  const report = { freshLaunch: true, noEmbeddedKey: true, encryptedSettingsSurviveRestart: true,
    historySurvivesRestart: true, scenarioSurvivesRestartWithVoiceOff: true, duplicateLaunchKeepsOriginalWindow: true, testedFromChinesePathWithSpaces: true };
  await writeFile(path.join(temporary, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log(`Isolated test output: ${temporary}`);
} finally { await close(); }
