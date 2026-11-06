'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accountStore', {
  list: () => ipcRenderer.invoke('accounts:list'),
  create: (name) => ipcRenderer.invoke('accounts:create', name),
  update: (id, patch) => ipcRenderer.invoke('accounts:update', id, patch),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  storage: () => ipcRenderer.invoke('accounts:storage'),
  onChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('accounts:changed', handler);
    return () => ipcRenderer.removeListener('accounts:changed', handler);
  },
  close: () => ipcRenderer.invoke('win:close-self'),
});
