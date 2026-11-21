import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSegmenter, pcmToWav, downsample } from '../public/audio-core.mjs';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('WAV is mono 16-bit PCM with consistent lengths and clipped samples', () => {
  const result = pcmToWav(new Float32Array([-2, -1, 0, 1, 2, NaN]));
  const b = Buffer.from(result);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(34), 16); assert.equal(b.readUInt32LE(40), 12);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => b.readInt16LE(44 + i * 2)), [-32768, -32768, 0, 32767, 32767, 0]);
});
test('downsampling preserves constant signal and duration', () => {
  const output = downsample(new Float32Array(48000).fill(.25), 48000);
  assert.equal(output.length, 16000); assert.ok(output.every(v => v === .25));
});
test('silence and isolated clicks do not create billable utterances', () => {
  const segments = [];
  const segmenter = new SpeechSegmenter({ sampleRate: 16000, onSegment: s => segments.push(s) });
  for (let i = 0; i < 40; i++) segmenter.push(new Float32Array(1600));
  segmenter.push(new Float32Array(160).fill(.5));
  for (let i = 0; i < 10; i++) segmenter.push(new Float32Array(1600));
  segmenter.flush(); assert.equal(segments.length, 0);
});
test('short utterance preserves pre-roll and flushes once on trailing silence', () => {
  const segments = [];
  const segmenter = new SpeechSegmenter({ sampleRate: 16000, onSegment: s => segments.push(s) });
  for (let i = 0; i < 2; i++) segmenter.push(new Float32Array(1600));
  for (let i = 0; i < 6; i++) segmenter.push(new Float32Array(1600).fill(.2));
  for (let i = 0; i < 8; i++) segmenter.push(new Float32Array(1600));
  segmenter.flush(); assert.equal(segments.length, 1);
  assert.ok(segments[0].length >= 16000); assert.ok(segments[0].some(v => v > .19));
});
test('continuous speech is bounded and stopping preserves the last partial sentence', () => {
  const segments = [];
  const segmenter = new SpeechSegmenter({ sampleRate: 16000, maxMs: 1000, onSegment: s => segments.push(s) });
  for (let i = 0; i < 25; i++) segmenter.push(new Float32Array(1600).fill(.1));
  segmenter.flush(); assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(s => s.length), [16000, 16000, 8000]);
});
test('worklet flush returns the final partial audio frame before acknowledging stop', async () => {
  const source = await readFile(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
  const messages = []; let Processor;
  class Base { constructor() { this.port = { postMessage: message => messages.push(message) }; } }
  runInNewContext(source, { AudioWorkletProcessor: Base, Float32Array, registerProcessor: (name, value) => { Processor = value; } });
  const processor = new Processor();
  for (let i = 0; i < 5; i++) processor.process([[new Float32Array(128).fill(.25)]]);
  assert.equal(messages.length, 0);
  processor.port.onmessage({ data: 'flush' });
  assert.equal(messages[0].length, 640); assert.ok(messages[0].every(value => value === .25));
  assert.equal(messages[1], 'flushed');
  processor.port.onmessage({ data: 'flush' }); assert.equal(messages.length, 3);
  assert.equal(messages[2], 'flushed');
});
