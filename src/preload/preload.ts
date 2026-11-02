import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, LoginRequest, LoginResult, Settings } from '../shared/types';

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
  onState: (cb: (s: AppState) => void) => {
    const handler = (_e: unknown, s: AppState) => cb(s);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.off('state', handler);
  },
  refresh: () => ipcRenderer.send('refresh'),
  login: (req: LoginRequest): Promise<LoginResult> => ipcRenderer.invoke('login', req),
  logout: (origin: string): Promise<void> => ipcRenderer.invoke('logout', origin),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch),
  setDemo: (on: boolean): Promise<void> => ipcRenderer.invoke('demo:set', on),
  togglePanel: () => ipcRenderer.send('panel:toggle'),
  hidePanel: () => ipcRenderer.send('panel:hide'),
  resizePanel: (height: number) => ipcRenderer.send('panel:resize', height),
  resizePet: (width: number, height: number) => ipcRenderer.send('pet:resize', width, height),
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send('pet:ignore-mouse', ignore),
  drag: (phase: 'start' | 'move' | 'end', x: number, y: number) => ipcRenderer.send('pet:drag', phase, x, y),
  petMenu: () => ipcRenderer.send('pet:menu'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
};

export type QuotaBuddiesApi = typeof api;

contextBridge.exposeInMainWorld('qb', api);
