'use strict';
// The only calls a page in the remote desktop app can make to the app. The app checks
// which page sent each one: the session calls are taken only from the configured server,
// the server choice only from the app's own connect page (remote.cjs).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('MimiDesktop', {
  remote: true,
  /** After sign-in: the app keeps the token in the OS keychain, or nowhere when `remember` is false. */
  signedIn: (session) =>
    ipcRenderer.invoke('mimi:signed-in', {
      token: String(session?.token ?? ''),
      username: String(session?.username ?? ''),
      remember: session?.remember !== false,
    }),
  /** After sign-out or an expired session: the app wipes what it kept and restarts at the sign-in page. */
  signedOut: (reason) => ipcRenderer.invoke('mimi:signed-out', String(reason ?? 'logout')),
  /** Connect page: checks a server address and opens it. */
  setServer: (url) => ipcRenderer.invoke('mimi:set-server', String(url ?? '')),
  server: () => ipcRenderer.invoke('mimi:server'),
  /** Opens the built-in browser window (its own profile keeps sites signed in). */
  openBrowser: () => ipcRenderer.invoke('mimi:open-browser'),
  /** Opens the separate Workspace window with browser, files and terminal. */
  openWorkspace: () => ipcRenderer.invoke('mimi:open-workspace'),
});
