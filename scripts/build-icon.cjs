const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '..');
  const svg = await fs.readFile(path.join(root, 'public/icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 256, height: 256, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>Build icon</title>');
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(`data:image/svg+xml,${encodeURIComponent(svg)}`)};
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(image, 0, 0, 256, 256);
    return canvas.toDataURL('image/png');
  })()`);
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  // A Windows icon can contain a PNG-compressed 256px image directly.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, 'build/icon.png'), png);
  await fs.writeFile(path.join(root, 'build/icon.ico'), Buffer.concat([header, png]));
  console.log('Windows icon generated from public/icon.svg.');
  win.destroy(); app.quit();
}).catch(error => { console.error(error.message); app.exit(1); });
