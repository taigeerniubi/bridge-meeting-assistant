// Explicitly labelled, isolated UI integration fixture. No external API calls.
// Run manually: node tests/ui-fixture.mjs ; http://127.0.0.1:4321
import http from 'node:http';
import { createHandler } from '../server/index.mjs';
import { initialConfig } from '../server/config.mjs';
import { pcmToWav } from '../public/audio-core.mjs';

const chinese = '这个 API 的超时时间是 3 秒，我们需要增加重试机制。';
const english = 'The timeout for this API is 3 seconds. We need to add a retry mechanism.';
const samples = Float32Array.from({ length: 8000 }, (_, i) => Math.sin(2 * Math.PI * 440 * i / 16000) * .035);
const server = http.createServer(createHandler({
  config: initialConfig({ DASHSCOPE_API_KEY: 'local-fixture-placeholder' }), testMode: true,
  services: {
    transcribe: async () => ({ text: chinese }),
    synthesize: async () => Buffer.from(pcmToWav(samples)),
    generateJson: async (config, messages, kind) => {
      const content = JSON.parse(messages.at(-1).content);
      if (kind === 'translation') {
        await new Promise(resolve => setTimeout(resolve, 150));
        return { chinese, english, uncertain: false };
      }
      return { overview: '本机测试：讨论 API 超时与重试机制。', decisions: [], actions: [{ task: '评估重试机制', owner: '待确认', due: '待确认', sourceIds: [content.transcript[0].id] }], questions: [] };
    },
  },
}));
server.listen(4321, '127.0.0.1', () => console.log('UI fixture (simulated responses only): http://127.0.0.1:4321'));
