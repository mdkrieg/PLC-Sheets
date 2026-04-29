/**
 * Preload script: bridges the sandboxed renderer to a tiny, typed IPC surface.
 *
 * The renderer never imports Node modules directly; it only sees `window.api`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcChannel, IpcEvent, IpcEventMap, IpcPayload, IpcResult } from '../shared/ipc';

const api = {
  invoke<C extends IpcChannel>(channel: C, payload?: IpcPayload<C>): Promise<IpcResult<C>> {
    return ipcRenderer.invoke(channel, payload);
  },
  on<E extends IpcEvent>(event: E, listener: (data: IpcEventMap[E]) => void): () => void {
    const wrapped = (_e: unknown, data: IpcEventMap[E]) => listener(data);
    ipcRenderer.on(event, wrapped);
    return () => ipcRenderer.off(event, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
