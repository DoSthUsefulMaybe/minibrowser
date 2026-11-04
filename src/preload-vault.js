'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vault', {
  root: () => ipcRenderer.invoke('vault:root'),
  chooseRoot: () => ipcRenderer.invoke('vault:choose-root'),
  tree: () => ipcRenderer.invoke('vault:tree'),
  read: (rel) => ipcRenderer.invoke('vault:read', rel),
  write: (rel, content) => ipcRenderer.invoke('vault:write', rel, content),
  create: (name, dirRel) => ipcRenderer.invoke('vault:create', name, dirRel),
  remove: (rel) => ipcRenderer.invoke('vault:remove', rel),
  rename: (rel, name) => ipcRenderer.invoke('vault:rename', rel, name),
  backlinks: (title) => ipcRenderer.invoke('vault:backlinks', title),
  missing: () => ipcRenderer.invoke('vault:missing'),
  search: (q) => ipcRenderer.invoke('vault:search', q),
  reveal: (rel) => ipcRenderer.invoke('vault:reveal', rel),
  close: () => ipcRenderer.invoke('win:close-self'),
});
