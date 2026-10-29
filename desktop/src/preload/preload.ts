/**
 * Preload: exposes exactly the OcApi of src/shared/ipc.ts as `window.oc`. Only plain JSON crosses the bridge;
 * the renderer never receives Node or Electron objects. Compiled to CommonJS (dist/preload/preload.cjs).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { INVOKE_CHANNELS, PUSH_CHANNELS, type OcApi, type Settings, type Status } from '../shared/ipc';

const api: OcApi = {
  getStatus: () => ipcRenderer.invoke(INVOKE_CHANNELS.getStatus) as Promise<Status>,
  onStatus: (cb) => {
    const listener = (_event: IpcRendererEvent, status: Status) => cb(status);
    ipcRenderer.on(PUSH_CHANNELS.status, listener);
    return () => {
      ipcRenderer.removeListener(PUSH_CHANNELS.status, listener);
    };
  },
  start: () => ipcRenderer.invoke(INVOKE_CHANNELS.start) as Promise<void>,
  stop: () => ipcRenderer.invoke(INVOKE_CHANNELS.stop) as Promise<void>,
  restart: () => ipcRenderer.invoke(INVOKE_CHANNELS.restart) as Promise<void>,
  saveSettings: (patch: Partial<Omit<Settings, 'jwtSecret'>>) =>
    ipcRenderer.invoke(INVOKE_CHANNELS.saveSettings, patch) as Promise<Status>,
  selectAddress: (address: string) => ipcRenderer.invoke(INVOKE_CHANNELS.selectAddress, address) as Promise<Status>,
  copy: (text: string) => ipcRenderer.invoke(INVOKE_CHANNELS.copy, text) as Promise<void>,
  openExternal: (url: string) => ipcRenderer.invoke(INVOKE_CHANNELS.openExternal, url) as Promise<void>,
  openDataDir: () => ipcRenderer.invoke(INVOKE_CHANNELS.openDataDir) as Promise<void>,
  allowFirewall: () => ipcRenderer.invoke(INVOKE_CHANNELS.allowFirewall) as Promise<{ ok: boolean; message: string }>,
  getLog: () => ipcRenderer.invoke(INVOKE_CHANNELS.getLog) as Promise<string[]>,
  onLog: (cb) => {
    const listener = (_event: IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on(PUSH_CHANNELS.log, listener);
    return () => {
      ipcRenderer.removeListener(PUSH_CHANNELS.log, listener);
    };
  },
};

contextBridge.exposeInMainWorld('oc', api);
