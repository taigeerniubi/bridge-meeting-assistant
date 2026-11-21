import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { initialConfig } from '../server/config.mjs';
import { generateJson, transcribe, synthesize, realtimeSpeech } from '../server/providers.mjs';
import { pcmToWav } from '../public/audio-core.mjs';

const config = initialConfig({ OPENAI_API_KEY: 'fake-openai', DASHSCOPE_API_KEY: 'fake-qwen' });
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
test('Qwen recognition sends original WAV and code-switching without forcing one language', async () => {
  const wav = Buffer.from(pcmToWav(new Float32Array(16000))).toString('base64');
  const result = await transcribe(config, wav, [{ en: 'API', zh: '应用程序接口' }], { fetchImpl: async (url, options) => {
    assert.match(url, /compatible-mode\/v1\/chat\/completions$/);
    const body = JSON.parse(options.body); assert.equal(body.model, 'qwen3-asr-flash');
    assert.equal(body.asr_options.language, undefined);
    assert.equal(body.messages[1].content[0].input_audio.data, `data:audio/wav;base64,${wav}`);
    return json({ choices: [{ message: { content: '这个 API timeout 是 3 秒。' } }] });
  } });
  assert.equal(result.text, '这个 API timeout 是 3 秒。');
});

const unsupportedAsrInput = () => new Response(JSON.stringify({ error: {
  code: 'InvalidParameter',
  message: '<400> InternalError.Algo.InvalidParameter: The dedicated task `asr` corresponding to the current service does not support this input.',
} }), { status: 400, headers: { 'Content-Type': 'application/json' } });

test('Qwen ASR retries rejected terminology context once and remembers audio-only mode', async () => {
  const current = structuredClone(config);
  const wav = Buffer.from(pcmToWav(new Float32Array(16000))).toString('base64');
  const glossary = [{ en: 'API', zh: '应用程序接口' }];
  let calls = 0;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls++;
    if (calls === 1) {
      assert.equal(body.messages[0].role, 'system');
      return unsupportedAsrInput();
    }
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav}` } }] }]);
    assert.equal(body.asr_options.language, undefined);
    return json({ choices: [{ message: { content: 'The API timeout is three seconds.' } }] });
  };
  const result = await transcribe(current, wav, glossary, { fetchImpl });
  assert.equal(result.text, 'The API timeout is three seconds.');
  assert.equal(calls, 2);
  await transcribe(current, wav, glossary, { fetchImpl });
  assert.equal(calls, 3, 'later utterances must not repeatedly send rejected context');

  const updated = structuredClone(current);
  await transcribe(updated, wav, glossary, { fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).messages[0].role, 'system', 'saving provider settings should allow context support to be checked again');
    return json({ choices: [{ message: { content: 'API' } }] });
  } });
});

test('Qwen ASR does not retry unrelated provider errors or audio-only input errors', async () => {
  const wav = Buffer.from(pcmToWav(new Float32Array(16000))).toString('base64');
  for (const status of [400, 401, 429]) {
    let calls = 0;
    await assert.rejects(transcribe(structuredClone(config), wav, [{ en: 'API', zh: '接口' }], { fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Invalid audio or credentials' } }), { status });
    } }), /Invalid audio or credentials/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(transcribe(structuredClone(config), wav, [], { fetchImpl: async () => {
    calls++;
    return unsupportedAsrInput();
  } }), /does not support this input/);
  assert.equal(calls, 1);
});

test('Qwen ASR reports a failed audio-only retry and does not cache it as success', async () => {
  const current = structuredClone(config);
  const wav = Buffer.from(pcmToWav(new Float32Array(16000))).toString('base64');
  const glossary = [{ en: 'API', zh: '接口' }];
  let calls = 0;
  await assert.rejects(transcribe(current, wav, glossary, { fetchImpl: async () => {
    calls++;
    return unsupportedAsrInput();
  } }), /does not support this input/);
  assert.equal(calls, 2);
  await transcribe(current, wav, glossary, { fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).messages[0].role, 'system');
    return json({ choices: [{ message: { content: 'API' } }] });
  } });
});

test('OpenAI transcription uses multipart file transcription endpoint', async () => {
  const current = structuredClone(config); current.routing.asr = 'openai';
  const wav = Buffer.from(pcmToWav(new Float32Array(1000))).toString('base64');
  const result = await transcribe(current, wav, [], { fetchImpl: async (url, options) => {
    assert.match(url, /\/audio\/transcriptions$/); assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get('model'), 'gpt-transcribe'); assert.equal(options.body.get('file').type, 'audio/wav');
    return json({ text: 'Review the API.' });
  } });
  assert.equal(result.text, 'Review the API.');
});
test('translation handles Qwen JSON output and rejects truncation', async () => {
  const value = { chinese: '不要发布。', english: 'Do not deploy.', uncertain: false };
  const result = await generateJson(config, [{ role: 'user', content: 'JSON' }], 'translation', { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); assert.equal(body.enable_thinking, false);
    return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
  } });
  assert.deepEqual(result, value);
  await assert.rejects(generateJson(config, [], 'translation', { fetchImpl: async () => json({ choices: [{ finish_reason: 'length' }] }) }), /未完整/);
});
test('OpenAI Responses requests structured output and rejects incomplete generations', async () => {
  const current = structuredClone(config); current.routing.text = 'openai';
  const result = await generateJson(current, [], 'translation', { fetchImpl: async (url, options) => {
    assert.match(url, /\/responses$/); const body = JSON.parse(options.body); assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
    return json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"chinese":"测试","english":"Test","uncertain":false}' }] }] });
  } });
  assert.equal(result.english, 'Test');
  await assert.rejects(generateJson(current, [], 'translation', { fetchImpl: async () => json({ status: 'incomplete' }) }), /未完整/);
});
test('Qwen speech download validates host and never sends API key to audio storage', async () => {
  let calls = 0;
  const wav = Buffer.from(pcmToWav(new Float32Array(1000)));
  const audio = await synthesize(config, 'Hello.', 'en-US', { fetchImpl: async (url, options) => {
    calls++;
    if (calls === 1) { assert.equal(JSON.parse(options.body).input.language_type, 'English'); return json({ output: { audio: { url: 'http://result.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=test' } } }); }
    assert.match(url.toString(), /^https:\/\//); assert.equal(options.headers, undefined); return new Response(wav);
  } });
  assert.deepEqual(audio, wav);
  await assert.rejects(synthesize(config, 'Hello', 'en-US', { fetchImpl: async () => json({ output: { audio: { url: 'https://untrusted.example/audio' } } }) }), /来源/);
});

function fakeSocket(transcript) {
  const socket = new EventEmitter(); socket.readyState = 1;
  socket.close = () => { socket.readyState = 3; socket.emit('close'); }; socket.terminate = socket.close;
  socket.send = message => {
    const event = JSON.parse(message);
    if (event.type === 'session.update') queueMicrotask(() => socket.emit('message', JSON.stringify({ type: 'session.updated' })));
    if (event.type === 'response.create') queueMicrotask(() => {
      socket.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.alloc(4800).toString('base64') }));
      socket.emit('message', JSON.stringify({ type: 'response.output_audio_transcript.done', transcript }));
      socket.emit('message', JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
    });
  };
  queueMicrotask(() => socket.emit('message', JSON.stringify({ type: 'session.created' })));
  return socket;
}
test('OpenAI Realtime assembles audio only after matching spoken transcript', async () => {
  const audio = await realtimeSpeech(config.providers.openai, 'Do not deploy.', 'en-GB', { socketFactory: () => fakeSocket('Do not deploy.') });
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF'); assert.equal(audio.readUInt32LE(24), 24000);
  await assert.rejects(realtimeSpeech(config.providers.openai, 'Do not deploy.', 'en-US', { socketFactory: () => fakeSocket('Deploy now.') }), /不一致/);
});
