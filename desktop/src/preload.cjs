'use strict';

// Preload for the local splash/error pages. The GUI itself talks to the dsh
// host over HTTP and needs nothing here; this bridge only carries the
// splash status text and the error page actions.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  onStatus: (callback) => {
    ipcRenderer.on('desktop:status', (_event, text) => callback(text));
  },
  onError: (callback) => {
    ipcRenderer.on('desktop:error', (_event, payload) => callback(payload));
  },
  retry: () => ipcRenderer.send('desktop:retry'),
  revealLog: () => ipcRenderer.send('desktop:reveal-log'),
  openVCRedistDownload: () => ipcRenderer.send('desktop:open-vcredist-download'),
  quit: () => ipcRenderer.send('desktop:quit'),
});
