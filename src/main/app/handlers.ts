/**
 * App-level IPC handlers (About dialog metadata + safe external link opener).
 *
 * Centralises third-party attribution metadata in one place so the renderer
 * can render an About panel without hardcoding licensing text. The list is
 * deliberately hand-maintained — automating it via license-checker would pull
 * in another transitive dep tree we'd rather not ship.
 */

import { app, shell, BrowserWindow } from 'electron';
import path from 'node:path';

export function handleAppAbout() {
  return {
    productName: 'PLC-Sheets',
    version: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    platform: `${process.platform} ${process.arch}`,
    attributions: [
      {
        name: 'HyperFormula',
        license: 'GPL-3.0 (community key)',
        url: 'https://hyperformula.handsontable.com/',
      },
      { name: 'ExcelJS', license: 'MIT', url: 'https://github.com/exceljs/exceljs' },
      { name: 'SheetJS (xlsx)', license: 'Apache-2.0', url: 'https://sheetjs.com/' },
      { name: 'modbus-serial', license: 'MIT', url: 'https://github.com/yaacov/node-modbus-serial' },
      { name: 'w2ui', license: 'MIT', url: 'https://w2ui.com/' },
      { name: 'Electron', license: 'MIT', url: 'https://www.electronjs.org/' },
      { name: 'electron-store', license: 'MIT', url: 'https://github.com/sindresorhus/electron-store' },
      { name: 'Zod', license: 'MIT', url: 'https://zod.dev/' },
    ],
  };
}

/**
 * Open a URL in the user's default browser.
 *
 * Allowlist to https/http only — never let the renderer launch arbitrary
 * file:// or shell-handler URIs. This keeps the About dialog's "learn more"
 * links from being abusable as a code-exec primitive.
 */
export async function handleOpenExternal(url: string): Promise<{ ok: true }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs may be opened');
  }
  await shell.openExternal(parsed.toString());
  return { ok: true };
}

/** Singleton trend viewer window. */
let trendViewerWin: BrowserWindow | null = null;

export function handleOpenTrendViewer(): { ok: true } {
  if (trendViewerWin && !trendViewerWin.isDestroyed()) {
    trendViewerWin.focus();
    return { ok: true };
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 600,
    minWidth: 600,
    minHeight: 400,
    title: 'PLC-Sheets — Trend Viewer',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL + 'trend-viewer.html');
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', '..', 'dist', 'trend-viewer.html'));
  }

  win.on('closed', () => {
    trendViewerWin = null;
  });

  trendViewerWin = win;
  return { ok: true };
}
