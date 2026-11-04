'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// UI 是无状态的：只渲染主进程推来的快照，所有动作回传主进程
contextBridge.exposeInMainWorld('browser', {
  snapshot: () => ipcRenderer.invoke('ui:snapshot'),
  createTab: (url) => ipcRenderer.send('tabs:create', url),
  closeTab: (id) => ipcRenderer.send('tabs:close', id),
  activateTab: (id) => ipcRenderer.send('tabs:activate', id),
  cycleGrid: () => ipcRenderer.send('view:cycle-grid'),
  setGrid: (index) => ipcRenderer.send('view:set-grid', index),
  showAccountMenu: () => ipcRenderer.send('account:menu'),
  showToolsMenu: () => ipcRenderer.send('tools:menu'),
  go: (input) => ipcRenderer.send('nav:go', input),
  action: (action) => ipcRenderer.send('nav:action', action),
  onState: (cb) => ipcRenderer.on('ui:state', (_e, state) => cb(state)),
  onFocusAddress: (cb) => ipcRenderer.on('ui:focus-address', () => cb()),
});
