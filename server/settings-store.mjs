import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateConfig } from './config.mjs';

// Pass secrets through stdin, never process arguments, console output or logs.
// Windows DPAPI binds the encrypted file to the current Windows account.
export function windowsProtect(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('本机密钥加密保存目前需要 Windows；其他系统可通过 .env 配置。');
  const script = `$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; `
    + `$value = [Console]::In.ReadToEnd(); `
    + (decrypt
      ? `[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))`
      : `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))`);
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const message = () => new Error(decrypt ? '无法解密已保存的服务设置，请使用保存时的 Windows 账户。' : '无法加密保存服务设置，请重试。');
    const timer = setTimeout(() => { child.kill(); finish(message()); }, 10000);
    child.on('error', () => finish(message()));
    child.stdin.on('error', () => finish(message()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 200000) { child.kill(); finish(message()); } });
    child.on('close', code => finish(code === 0 && output ? null : message(), output));
    child.stdin.end(value, 'utf8');
  });
}

export function createSettingsStore(file, { crypt = windowsProtect } = {}) {
  return {
    async load(defaults) {
      let data;
      try { data = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return defaults; throw new Error('无法读取本机服务设置，请检查文件权限。'); }
      try {
        if (data.length > 200000) throw new Error('Invalid settings size');
        const envelope = JSON.parse(data);
        if (envelope.version !== 1 || envelope.protection !== 'windows-dpapi-current-user' || typeof envelope.data !== 'string') throw new Error('Invalid settings format');
        const saved = JSON.parse(await crypt(envelope.data, true));
        if (!saved?.providers || !saved.routing) throw new Error('Invalid settings');
        // Persist an explicit empty key too: clearing it must survive a restart,
        // even when an older value is still present in the environment.
        for (const name of ['openai', 'qwen']) {
          if (typeof saved.providers[name]?.key !== 'string') throw new Error('Invalid key');
          saved.providers[name].clearKey = saved.providers[name].key === '';
        }
        return updateConfig(defaults, saved);
      } catch { throw new Error('已保存的服务设置无法读取或解密，请使用原 Windows 账户，或移走数据目录中的 service-settings.dpapi 后重新配置。'); }
    },
    async save(config) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const data = await crypt(JSON.stringify(config));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', data }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch { throw new Error('服务设置未保存成功，请检查本机加密服务及数据目录的写入权限后重试。'); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    },
  };
}
