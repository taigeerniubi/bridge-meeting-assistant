import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore } from '../server/settings-store.mjs';
import { initialConfig } from '../server/config.mjs';
import { startServer } from '../server/index.mjs';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-settings-'));
  t.after(async () => { for (const name of await readdir(directory)) await rm(join(directory, name), { force: true }); await rmdir(directory); });
  return { file: join(directory, 'service-settings.dpapi'), directory };
}

test('encrypted settings survive server restarts; blank keeps keys and explicit removal stays removed', { skip: process.platform !== 'win32' }, async t => {
  const { file } = await temporary(t);
  const secret = 'settings-regression-key-only';
  let server, origin;
  const stop = async () => { if (!server) return; const current = server; server = null; current.closeAllConnections(); await new Promise(resolve => current.close(resolve)); };
  t.after(stop);
  const start = async env => {
    const running = await startServer({ port: 0, host: '127.0.0.1', env: env || {}, settingsStore: createSettingsStore(file) });
    server = running.server; origin = running.url;
    return (await fetch(origin + '/api/bootstrap')).json();
  };
  const save = async body => {
    const bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
    const response = await fetch(origin + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': bootstrap.csrf }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.persistent, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
  };
  await start();
  await save({ routing: { asr: 'qwen', text: 'qwen', speech: 'qwen' }, providers: { qwen: { key: secret, liveVoice: 'Aiden', textModel: 'test-model-中文' } } });
  const encrypted = await readFile(file, 'utf8');
  assert.equal(encrypted.includes(secret), false); assert.equal(encrypted.includes('test-model-中文'), false);
  assert.equal(JSON.parse(encrypted).protection, 'windows-dpapi-current-user');
  await stop();
  const resumed = await start();
  assert.equal(resumed.capabilities.persistentSettings, true); assert.equal(resumed.config.providers.qwen.configured, true);
  assert.equal(resumed.config.routing.text, 'qwen'); assert.equal(resumed.config.providers.qwen.liveVoice, 'Aiden');
  assert.equal(resumed.config.providers.qwen.textModel, 'test-model-中文');
  assert.equal(JSON.stringify(resumed).includes(secret), false);
  await save({ providers: { qwen: { key: '', textModel: 'updated' } } });
  assert.equal((await createSettingsStore(file).load(initialConfig({}))).providers.qwen.key, secret);
  await save({ providers: { qwen: { clearKey: true } } });
  await stop();
  const cleared = await start({ DASHSCOPE_API_KEY: 'stale-environment-key' });
  assert.equal(cleared.config.providers.qwen.configured, false);
  assert.equal(cleared.config.providers.qwen.textModel, 'updated');
  await stop();
});

test('failed encryption leaves the previous saved file intact and corrupt files are not silently ignored', async t => {
  const { file, directory } = await temporary(t);
  await writeFile(file, 'existing encrypted snapshot');
  const failing = createSettingsStore(file, { crypt: async () => { throw new Error('private-key-must-not-appear'); } });
  await assert.rejects(failing.save(initialConfig({})), error => /未保存成功/.test(error.message) && !error.message.includes('private-key'));
  assert.equal(await readFile(file, 'utf8'), 'existing encrypted snapshot');
  assert.deepEqual(await readdir(directory), ['service-settings.dpapi']);
  await assert.rejects(failing.load(initialConfig({})), /无法读取或解密/);
});
