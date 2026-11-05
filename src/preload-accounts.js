'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('accountStore', {
  list: () => ipcRenderer.invoke('accounts:list'),
  create: (name) => ipcRenderer.invoke('accounts:create', name),
  update: (id, patch) => ipcRenderer.invoke('accounts:update', id, patch),
  remove: (id) => ipcRenderer.invoke('accounts:remove', id),
  close: () => ipcRenderer.invoke('win:close-self'),
});
