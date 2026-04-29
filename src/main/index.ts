/**
 * Electron main entry point.
 *
 * Responsibilities for Phase 1:
 * - Create a single BrowserWindow with sandboxed renderer (contextIsolation,
 *   no node integration) and a preload that exposes `window.api`.
 * - Permanently suppress the default application menu (per outline: the
 *   "File Edit ..." Electron toolbar must never appear).
 * - Register the IPC ping handler so the renderer can verify the bridge.
 *
 * Subsequent phases extend this by registering workbook, config, modbus,
 * and log handlers via `src/main/ipc/registry.ts`.
 */

import { app, BrowserWindow, Menu } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc/registry';

const isDev = !app.isPackaged;

async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs ipcRenderer; still isolated from renderer JS
    },
  });

  // Belt and suspenders: also strip the menu entirely so accelerators can't summon it.
  win.setMenu(null);

  // DevTools: opened on demand via F12 or Ctrl+Shift+I.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isCtrlShiftI) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  return win;
}

app.whenReady().then(async () => {
  // Outline requirement: the default "File Edit ..." Electron menu is permanently hidden.
  Menu.setApplicationMenu(null);

  registerIpcHandlers();
  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
