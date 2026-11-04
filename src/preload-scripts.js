'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scriptStore', {
  list: () => ipcRenderer.invoke('scripts:list'),
  save: (item) => ipcRenderer.invoke('scripts:save', item),
  remove: (id) => ipcRenderer.invoke('scripts:remove', id),
  toggle: (id, enabled) => ipcRenderer.invoke('scripts:toggle', id, enabled),
  reloadPages: () => ipcRenderer.invoke('scripts:reload-pages'),
  close: () => ipcRenderer.invoke('win:close-self'),
});
