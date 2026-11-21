export const providerNames = ['openai', 'qwen'];

export function initialConfig(env = process.env) {
  const preferred = env.DASHSCOPE_API_KEY ? 'qwen' : 'openai';
  return {
    providers: {
      openai: {
        key: env.OPENAI_API_KEY || '', baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        textModel: env.OPENAI_TEXT_MODEL || 'gpt-6.1-sol', asrModel: env.OPENAI_ASR_MODEL || 'gpt-transcribe',
        speechModel: env.OPENAI_SPEECH_MODEL || 'gpt-realtime-2.1-mini', voice: 'marin',
      },
      qwen: {
        key: env.DASHSCOPE_API_KEY || '', baseUrl: env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        ttsUrl: env.QWEN_TTS_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        textModel: env.QWEN_TEXT_MODEL || 'qwen-plus', asrModel: env.QWEN_ASR_MODEL || 'qwen3-asr-flash',
        speechModel: env.QWEN_SPEECH_MODEL || 'qwen3-tts-flash', voice: 'Cherry',
      },
    },
    routing: { asr: preferred, text: preferred, speech: preferred },
  };
}

export function publicConfig(config) {
  return {
    routing: { ...config.routing },
    providers: Object.fromEntries(providerNames.map(name => {
      const { key, ...rest } = config.providers[name];
      return [name, { ...rest, configured: Boolean(key) }];
    })),
  };
}

function secureUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址必须是没有密码、查询参数的 HTTPS 地址。');
  }
  return value.replace(/\/+$/, '');
}

export function updateConfig(current, input) {
  if (!input || typeof input !== 'object') throw new Error('设置格式不正确。');
  const next = structuredClone(current);
  for (const stage of ['asr', 'text', 'speech']) {
    if (input.routing?.[stage] !== undefined) {
      if (!providerNames.includes(input.routing[stage])) throw new Error('请选择 OpenAI 或 Qwen。');
      next.routing[stage] = input.routing[stage];
    }
  }
  for (const name of providerNames) {
    const source = input.providers?.[name];
    if (!source) continue;
    // Blank passwords mean retain; removal is a separate explicit operation.
    if (source.clearKey === true) next.providers[name].key = '';
    if (source.key) {
      if (typeof source.key !== 'string' || source.key.length > 4096 || /\s/.test(source.key)) throw new Error('API Key 格式不正确。');
      next.providers[name].key = source.key;
    }
    for (const field of ['baseUrl', 'ttsUrl', 'textModel', 'asrModel', 'speechModel', 'voice']) {
      if (source[field] === undefined || !(field in next.providers[name])) continue;
      if (typeof source[field] !== 'string' || !source[field].trim() || source[field].length > 500) throw new Error('模型或服务地址格式不正确。');
      next.providers[name][field] = field.endsWith('Url') ? secureUrl(source[field].trim()) : source[field].trim();
    }
  }
  return next;
}
