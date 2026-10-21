// Electron main process.
//
// The gateway already is an HTTP server with an SSE stream and a complete web client,
// so the desktop app is just: start it on a loopback port, point a BrowserWindow at it,
// and add the macOS shell (tray, dock, single instance). No IPC bridge, no bundled
// second runtime — the main process *is* the Node the backend needs.
//
// `node:sqlite` is the reason this works in-process: Electron 41+ bundles Node 24,
// where DatabaseSync is stable. See docs/DESKTOP.md.

import { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createHost } from '../src/host.mjs';

let win = null;
let tray = null;
let host = null;
let url = null;
let quitting = false;

// A second copy would fight over the same data root (host.lock, SQLite handles).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

// A tray-only app must not open a blank dock window on launch.
app.on('window-all-closed', (e) => {
  // Keep running: routines and queued turns need the process alive.
  e.preventDefault?.();
});

async function startGateway() {
  host = createHost({});
  const discovery = await host.listen({
    port: Number(process.env.MGB_DESKTOP_PORT ?? 0),
    host: '127.0.0.1',
  });
  const h = discovery.host === '0.0.0.0' ? '127.0.0.1' : discovery.host;
  return `http://${h}:${discovery.port}`;
}

function trayIcon() {
  // 16px template image drawn in code: no asset to ship, adapts to light/dark menu bar.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <rect x="2.5" y="3" width="11" height="8" rx="2.5" fill="none" stroke="#000" stroke-width="1.4"/>
    <circle cx="5.8" cy="7" r="0.95" fill="#000"/><circle cx="10.2" cy="7" r="0.95" fill="#000"/>
    <path d="M6 12.4 L8 14.6 L10 12.4" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>
  </svg>`;
  const img = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  );
  img.setTemplateImage(true);
  return img;
}

function buildMenu() {
  const items = [
    { label: '显示窗口', click: () => win?.show() },
    { type: 'separator' },
    { label: '刷新页面', click: () => win?.webContents.reload() },
    {
      label: '打开数据目录',
      click: () => { if (host) shell.openPath(host.p.root); },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { quitting = true; app.quit(); },
    },
  ];
  return Menu.buildFromTemplate(items);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'MyGrokbot',
    backgroundColor: '#dfe6ec',
    // Match the web client's own chrome; the page draws its own header.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      // The renderer is the existing web client talking to loopback — it needs no
      // Node integration and gets no preload surface.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.loadURL(url);

  // External links open in the real browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http')) shell.openExternal(target);
    return { action: 'deny' };
  });

  // Closing the window hides it; the tray keeps the app (and its routines) alive.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('MyGrokbot');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()));
}

app.whenReady().then(async () => {
  try {
    url = await startGateway();
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err?.stack ?? err));
    app.quit();
    return;
  }
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else win?.show();
  });
});

app.on('before-quit', async () => {
  quitting = true;
  try { await host?.close(); } catch { /* best effort on shutdown */ }
});
