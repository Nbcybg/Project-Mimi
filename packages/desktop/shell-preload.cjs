'use strict';
// What the local Mimi window (main.cjs) may ask of Electron. The remote app has its own
// preload.cjs; both expose the same small MimiShell object to the web client.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('MimiShell', {
  /** Whether Mimi starts with the computer, and whether this platform/build supports it. */
  openAtLogin: () => ipcRenderer.invoke('mimi:open-at-login'),
  /** Turns "start with the computer" on or off; returns the new state. */
  setOpenAtLogin: (open) => ipcRenderer.invoke('mimi:set-open-at-login', open === true),
});
