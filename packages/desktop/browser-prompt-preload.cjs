'use strict';
// The address bar window only: send what was typed back to browser-shell.cjs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('MimiAddress', {
  submit: (value) => ipcRenderer.send('mimi-browser:address', String(value ?? '')),
  cancel: () => ipcRenderer.send('mimi-browser:address-cancel'),
});
