import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const roots = ['server', 'public', 'desktop', 'tests', 'scripts'];
let failed = false;
for (const root of roots) {
  for (const entry of await readdir(root, { recursive: true })) {
    if (!/\.(mjs|cjs|js)$/.test(entry)) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, entry)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exit(1);
console.log('JavaScript syntax checks passed.');
