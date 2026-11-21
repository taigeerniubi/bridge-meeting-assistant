import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { initialConfig, publicConfig, updateConfig } from './config.mjs';
import { generateJson, transcribe, synthesize, ServiceError } from './providers.mjs';
import { translationMessages, summaryMessages, validateSummary } from './prompts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const equals = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ServiceError('请求需要 JSON 格式。', 415);
  if (Number(req.headers['content-length']) > 8_000_000) throw new ServiceError('请求内容过大。', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8_000_000) throw new ServiceError('请求内容过大。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError('JSON 格式不正确。', 400); }
}

export function createHandler({ config = initialConfig(), accessToken = '', publicOrigin = '', services = {}, testMode = false } = {}) {
  let settings = config;
  const csrf = randomBytes(32).toString('hex');
  const authCookie = randomBytes(32).toString('hex');
  const service = { generateJson, transcribe, synthesize, ...services };
  let inFlight = 0;
  return async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    };
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    const send = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); } };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let counted = false;
    try {
      const host = req.headers.host || '';
      const scheme = req.socket.encrypted ? 'https' : 'http';
      const origin = `${scheme}://${host}`;
      const hostAllowed = publicOrigin ? origin === publicOrigin : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
      if (!hostAllowed || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '只允许从应用本身访问。' });
      const url = new URL(req.url, origin);
      if (url.pathname === '/api/unlock' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!equals(body.token, accessToken)) return send(401, { error: '访问密码不正确。' });
        res.setHeader('Set-Cookie', `bridge_auth=${authCookie}; HttpOnly; SameSite=Strict; Path=/${scheme === 'https' ? '; Secure' : ''}`);
        return send(200, { ok: true });
      }
      const authorized = !accessToken || req.headers.cookie?.split(';').some(item => item.trim() === `bridge_auth=${authCookie}`);
      if (url.pathname.startsWith('/api/')) {
        if (!authorized) return send(401, { error: '请先输入访问密码。', locked: true });
        if (req.method === 'GET' && url.pathname === '/api/bootstrap') return send(200, { csrf, config: publicConfig(settings), version: '0.1.0', testMode });
        if (req.method !== 'POST') return send(405, { error: '不支持此请求方式。' });
        if (!equals(req.headers['x-bridge-token'], csrf)) return send(403, { error: '页面会话已失效，请刷新后重试。' });
        const body = await jsonBody(req);
        if (url.pathname === '/api/settings') {
          try { settings = updateConfig(settings, body); } catch (error) { throw new ServiceError(error.message, 400); }
          return send(200, { config: publicConfig(settings) });
        }
        if (inFlight >= 6) return send(429, { error: '正在处理的请求较多，请稍后重试。' });
        inFlight++; counted = true;
        const options = { signal: controller.signal };
        if (url.pathname === '/api/transcribe') {
          if (typeof body.audio !== 'string') throw new ServiceError('缺少音频内容。', 400);
          return send(200, await service.transcribe(settings, body.audio, body.glossary, options));
        }
        if (url.pathname === '/api/translate') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 6000) throw new ServiceError('请输入 1–6000 字的内容。', 400);
          if (!Array.isArray(body.context || [])) throw new ServiceError('上下文格式不正确。', 400);
          const result = await service.generateJson(settings, translationMessages(body), 'translation', options);
          if (typeof result.chinese !== 'string' || typeof result.english !== 'string' || typeof result.uncertain !== 'boolean' || !result.chinese.trim() || !result.english.trim()) throw new ServiceError('翻译结果不完整，请重试。');
          return send(200, result);
        }
        if (url.pathname === '/api/summary') {
          if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 3000 || body.entries.some(e => !e || typeof e.id !== 'string' || typeof e.original !== 'string' || !['me', 'remote'].includes(e.source))) throw new ServiceError('请先添加有效会议记录（最多 3000 条）。', 400);
          if (JSON.stringify(body.entries).length > 350000) throw new ServiceError('会议记录过长，请分成多个会议再生成纪要。', 400);
          const result = await service.generateJson(settings, summaryMessages(body.entries, body.title), 'summary', options);
          return send(200, validateSummary(result, body.entries));
        }
        if (url.pathname === '/api/speech') {
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 3000) throw new ServiceError('每次播报需为 1–3000 字。', 400);
          const audio = await service.synthesize(settings, body.text, body.accent, options);
          if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length }); res.end(audio); }
          return;
        }
        return send(404, { error: '接口不存在。' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: '不支持此请求方式。' });
      const publicDir = resolve(root, 'public');
      const path = resolve(publicDir, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(publicDir + sep) || !types[extname(path)]) return send(404, { error: '文件不存在。' });
      const file = await readFile(path).catch(() => null);
      if (!file) return send(404, { error: '文件不存在。' });
      res.writeHead(200, { 'Content-Type': types[extname(path)] }); res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      let message = error.message || '处理失败，请重试。';
      for (const provider of Object.values(settings.providers)) if (provider.key) message = message.split(provider.key).join('[已隐藏]');
      send(error.status || 500, { error: message.slice(0, 500) });
    } finally { if (counted) inFlight--; }
  };
}

export async function startServer({ port, host, env = process.env, desktop = false } = {}) {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (desktop) env = { ...env, PUBLIC_ORIGIN: '', ACCESS_TOKEN: '', TLS_CERT: '', TLS_KEY: '' };
  host ??= env.HOST || '127.0.0.1';
  port ??= Number(env.PORT || 4318);
  const tls = Boolean(env.TLS_CERT && env.TLS_KEY);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!tls || !env.ACCESS_TOKEN || !env.PUBLIC_ORIGIN)) throw new Error('手机 / 局域网接入需要 TLS_CERT、TLS_KEY、ACCESS_TOKEN 和 PUBLIC_ORIGIN。');
  const handler = createHandler({ config: initialConfig(env), accessToken: env.ACCESS_TOKEN, publicOrigin: env.PUBLIC_ORIGIN });
  const server = tls ? https.createServer({ cert: await readFile(resolve(root, env.TLS_CERT)), key: await readFile(resolve(root, env.TLS_KEY)) }, handler) : http.createServer(handler);
  server.requestTimeout = 120000;
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, host, resolveReady); });
  const address = server.address();
  const url = env.PUBLIC_ORIGIN || `${tls ? 'https' : 'http'}://${host === '::1' ? '[::1]' : host}:${address.port}`;
  return { server, url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer().then(({ url }) => console.log(`会议助手已启动：${url}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
