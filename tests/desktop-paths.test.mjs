import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { desktopPaths } from '../desktop/paths.cjs';

test('development keeps the existing profile and settings directory', () => {
  const root = path.resolve('project');
  const result = desktopPaths({ isPackaged: false, projectRoot: root, execPath: path.resolve('electron.exe') });
  assert.equal(result.profile, path.join(root, '.local', 'desktop-profile'));
  assert.equal(result.dataDirectory, path.join(root, '.local'));
  assert.equal(result.envFile, path.join(root, '.env'));
});

test('portable data stays beside the launcher across temporary extraction paths', () => {
  const portableDirectory = path.resolve('portable', '带空格的目录 with spaces');
  const resolvePortable = temp => desktopPaths({ isPackaged: true, projectRoot: path.resolve(temp, 'resources', 'app.asar'),
    execPath: path.resolve(temp, 'BridgeMeeting.exe'), portableDirectory });
  const first = resolvePortable('temp-first');
  assert.deepEqual(first, resolvePortable('temp-second'));
  assert.equal(first.profile, path.join(portableDirectory, '译桥数据', 'desktop-profile'));
  assert.equal(first.envFile, path.join(portableDirectory, '译桥数据', '.env'));
});

test('unpacked app also writes outside app.asar', () => {
  const executableDirectory = path.resolve('unpacked');
  const result = desktopPaths({ isPackaged: true, projectRoot: path.join(executableDirectory, 'resources', 'app.asar'),
    execPath: path.join(executableDirectory, 'BridgeMeeting.exe') });
  assert.equal(result.dataDirectory, path.join(executableDirectory, '译桥数据'));
});
