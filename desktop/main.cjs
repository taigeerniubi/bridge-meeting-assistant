const { app, BrowserWindow, session, desktopCapturer, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { desktopPaths } = require('./paths.cjs');

const { dataDirectory, profile, envFile } = desktopPaths({
  isPackaged: app.isPackaged, projectRoot: path.join(__dirname, '..'),
  execPath: process.execPath, portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
});
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setAppUserModelId('local.bridge.meeting-assistant');
let server, win;
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});
if (primaryInstance) {
app.whenReady().then(async () => {
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href);
  // A stable origin keeps meeting history available across desktop restarts.
  const result = await startServer({ port: Number(process.env.DESKTOP_PORT || 4319), host: '127.0.0.1', desktop: true, dataDirectory, envFile });
  server = result.server;
  const origin = new URL(result.url).origin;
  const trusted = value => { try { return new URL(value).origin === origin; } catch { return false; } };
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 860, minHeight: 640, title: '译桥 · IT 会议助手', backgroundColor: '#f6f8fb',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === win.webContents && trusted(details.requestingUrl || contents.getURL()) && ['media', 'display-capture', 'speaker-selection'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) => contents === win.webContents && trusted(requestingOrigin) && ['media', 'display-capture', 'speaker-selection'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trusted(request.securityOrigin) || !request.userGesture) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) return callback({});
      // Windows system output. The renderer never sends video frames to any service.
      callback({ video: sources[0], audio: 'loopback' });
    } catch { callback({}); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  await win.loadURL(result.url);
}).catch(error => { dialog.showErrorBox('启动失败', error.message); app.quit(); });
app.on('window-all-closed', () => { server?.close(); app.quit(); });
}
