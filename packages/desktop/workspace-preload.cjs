'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mimiWorkspace', {
  platform: process.platform,
  root: () => ipcRenderer.invoke('workspace:root'),
  chooseRoot: () => ipcRenderer.invoke('workspace:choose-root'),
  list: (rel) => ipcRenderer.invoke('workspace:list', rel),
  read: (rel) => ipcRenderer.invoke('workspace:read', rel),
  write: (rel, text) => ipcRenderer.invoke('workspace:write', rel, text),
  terminalStart: (cwd) => ipcRenderer.invoke('workspace:terminal-start', cwd),
  terminalStop: () => ipcRenderer.invoke('workspace:terminal-stop'),
  terminalInput: (text) => ipcRenderer.send('workspace:terminal-input', text),
  openExternal: (url) => ipcRenderer.invoke('workspace:open-external', url),
  onTerminalData: (callback) => ipcRenderer.on('workspace:terminal-data', (_event, text) => callback(text)),
  onTerminalExit: (callback) => ipcRenderer.on('workspace:terminal-exit', (_event, code) => callback(code)),
  onOpenUrl: (callback) => ipcRenderer.on('workspace:open-url', (_event, url) => callback(url)),
});
