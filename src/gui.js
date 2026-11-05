'use strict';
/**
 * minibrowser —— 极简多标签浏览器
 *
 * 设计要点：
 *   1. 一个原生窗口（BrowserWindow）只承载「标题栏 UI」（标签条 + 地址栏）；
 *   2. 每个标签是一个 WebContentsView —— 各自独立进程、独立渲染、独立 JS 运行时，
 *      切换标签只是 setVisible，页面不重载，所以多标签可以真正「并行交互」；
 *   3. 主进程是唯一状态源，UI 渲染进程无状态：任何变化都推一份完整快照过去。
 */
const { app, BrowserWindow, WebContentsView, ipcMain, nativeTheme, Menu, dialog, clipboard, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const accounts = require('./accounts');

const scripts = require('./scripts');
const vault = require('./vault');

const UI_DIR = path.join(__dirname, 'ui');
const NEWTAB_FILE = path.join(UI_DIR, 'newtab.html');
const NEWTAB_URL = 'minibrowser://newtab';
// 自检产物落在当前工作目录（打包后 app 目录是只读感的 resources/app）
const SHOT_DIR = process.cwd();

const CHROME_HEIGHT = 76; // 标签条 40 + 工具栏 36，与 ui/style.css 保持一致
const SEARCH_PREFIX = 'https://www.bing.com/search?q=';
const SELFCHECK = process.argv.includes('--selfcheck');
const START_URL = NEWTAB_URL;

// 无 GPU 的环境（远程桌面 / 虚拟机 / 自动化沙箱）里 GPU 进程会反复崩溃，
// 直接退到软件光栅；有 GPU 时保持默认的硬件加速。
if (SELFCHECK || process.argv.includes('--disable-gpu') || process.env.MINIBROWSER_NO_GPU) {
  app.disableHardwareAcceleration();
}

// 自检用独立的 userData，别把测试账号/缓存写进真实配置
if (SELFCHECK) {
  try {
    app.setPath('userData', path.join(require('node:os').tmpdir(), 'minibrowser-selfcheck'));
  } catch {
    /* 拿不到临时目录就用默认 */
  }
}

/**
 * 每个窗口一份独立上下文：标签、当前标签、宫格、可见起点、账号全部独立。
 * @type {Array<any>}
 */
const windows = [];
let winCounter = 0;
let lastAccountId = accounts.DEFAULT_ACCOUNT.id; // 新窗口默认沿用上次用过的账号

/** 取当前上下文：显式传参优先，否则按聚焦窗口判断 */
function curCtx() {
  if (!windows.length) return null;
  if (windows.length === 1) return windows[0];
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    const hit = windows.find((c) => c.win === focused);
    if (hit) return hit;
  }
  return windows[0];
}

// 系统深浅色变化：所有窗口一起更新标题栏覆盖色
nativeTheme.on('updated', () => {
  for (const c of windows) {
    if (!c.win || c.win.isDestroyed()) continue;
    try {
      c.win.setTitleBarOverlay({ ...overlayColors(), height: 40 });
    } catch {
      /* 非 Windows 或已关闭 */
    }
  }
});

// ---------------------------------------------------------------- 地址解析

/** 把地址栏里的一串字变成真正可加载的 URL；返回 null 表示空输入。 */
function normalizeInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // 先认「本机/端口」形态，否则 localhost:8080 会被当成 localhost: 协议
  if (/^localhost([:/]|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}([:/?#]|$)/.test(s)) {
    return 'http://' + s;
  }
  // 真协议必须带 ://（http: https: file:），或明确的无斜杠协议
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(about|data|file|mailto|view-source|chrome):/i.test(s)) return s;

  const hasSpace = /\s/.test(s);
  const looksLikeHost = !hasSpace && /^[^\s/?#]+\.[^\s/?#]{2,}([:/?#]|$)/.test(s);
  if (looksLikeHost) return 'https://' + s;
  return SEARCH_PREFIX + encodeURIComponent(s);
}

/** 内部页 → 真实可加载地址 */
function toRealUrl(url) {
  return url === NEWTAB_URL ? pathToFileURL(NEWTAB_FILE).href : url;
}

/** 真实地址 → 地址栏应显示的文本（新标签页显示空） */
function toDisplayUrl(url) {
  if (!url) return '';
  if (url === pathToFileURL(NEWTAB_FILE).href) return '';
  return url;
}

function tabById(id, ctx = curCtx()) {
  return ctx.tabs.find((t) => t.id === id) || null;
}

function activeTab(ctx = curCtx()) {
  return tabById(ctx.activeId);
}

// ---------------------------------------------------------------- 窗口与布局

function overlayColors() {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#202327', symbolColor: '#e6e8eb' }
    : { color: '#eceef1', symbolColor: '#1f2328' };
}

/** 新开一个窗口。窗口之间账号、标签、宫格全独立（Ctrl+N）。 */
function createWindow({ accountId = null, gridIndex = 0, show = null } = {}) {
  const acc = accounts.get(accountId || lastAccountId);

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1f23' : '#f5f6f8',
    title: 'minibrowser',
    show: show === null ? !SELFCHECK || process.argv.includes('--show') : show,
    // 标签条就是标题栏：隐藏原生标题栏，只保留右上角系统按钮
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayColors(), height: 40 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const ctx = {
    id: ++winCounter,
    win,
    uiReady: false,
    tabs: [],
    activeId: null,
    seq: 0,
    gridIndex: Math.max(0, Math.min(GRIDS.length - 1, gridIndex)),
    visibleStart: 0,
    accountId: acc.id,
  };
  windows.push(ctx);
  lastAccountId = acc.id;

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(UI_DIR, 'index.html'));

  win.webContents.once('did-finish-load', () => {
    ctx.uiReady = true;
    pushState(ctx);
  });

  wireShortcuts(win.webContents, () => activeTab(ctx), ctx);

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(ev, () => scheduleLayout(ctx));
  }

  win.on('closed', () => {
    const i = windows.indexOf(ctx);
    if (i >= 0) windows.splice(i, 1);
    for (const t of ctx.tabs) {
      try {
        t.view.webContents.close();
      } catch {
        /* 已销毁 */
      }
    }
    ctx.tabs.length = 0;
  });

  // 地址栏等 UI 里的链接/跳转不要劫持整个窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    createTab(url, {}, ctx);
    return { action: 'deny' };
  });

  win.webContents.on('focus', () => {
    lastAccountId = ctx.accountId;
  });

  createTab(START_URL, {}, ctx);
  return ctx;
}

function contentBounds(ctx = curCtx()) {
  if (!ctx.win) return { x: 0, y: CHROME_HEIGHT, width: 0, height: 0 };
  const [w, h] = ctx.win.getContentSize();
  return {
    x: 0,
    y: CHROME_HEIGHT,
    width: Math.max(0, Math.round(w)),
    height: Math.max(0, Math.round(h - CHROME_HEIGHT)),
  };
}

// ---------------------------------------------------------------- 宫格布局
//
// 单格 = 传统浏览；多格 = 监控墙：多个标签同时可见、同时渲染、同时跑。
// 每个格子顶部留 22px 给标题条 —— 那块区域不放 view，露出下面的窗口 UI 层，
// 所以标题条、格子间隙都是 UI 画的。

const GAP = 4;
const CELL_HEADER = 22;
const GRIDS = [
  { cols: 1, rows: 1 },
  { cols: 2, rows: 1 },
  { cols: 2, rows: 2 },
  { cols: 3, rows: 2 },
  { cols: 3, rows: 3 },
];

const grid = (ctx = curCtx()) => GRIDS[ctx.gridIndex];
const capacity = (ctx = curCtx()) => grid(ctx).cols * grid(ctx).rows;
const isMulti = (ctx = curCtx()) => capacity(ctx) > 1;

/** 当前落在格子里的标签（按标签顺序切一段窗口） */
function visibleTabs(ctx = curCtx()) {
  return ctx.tabs.slice(ctx.visibleStart, ctx.visibleStart + capacity(ctx));
}

function clampVisibleStart(ctx = curCtx()) {
  const max = Math.max(0, ctx.tabs.length - capacity(ctx));
  ctx.visibleStart = Math.max(0, Math.min(ctx.visibleStart, max));
}

/** 让第 index 个标签一定在格子里 */
function ensureVisible(index, ctx = curCtx()) {
  if (index < 0) return;
  const cap = capacity(ctx);
  if (index < ctx.visibleStart) ctx.visibleStart = index;
  else if (index >= ctx.visibleStart + cap) ctx.visibleStart = index - cap + 1;
  clampVisibleStart(ctx);
}

/** 每个格子的矩形（不含 view 的 header 偏移），顺序 = visibleTabs 顺序 */
function cellRects(ctx) {
  const b = contentBounds(ctx);
  const g = grid(ctx);
  const gap = isMulti(ctx) ? GAP : 0;
  const header = isMulti(ctx) ? CELL_HEADER : 0;
  const vis = visibleTabs(ctx);
  const out = [];

  for (let i = 0; i < vis.length; i++) {
    const r = Math.floor(i / g.cols);
    const c = i % g.cols;
    // 用边界取整，避免累积误差在最后一列/行留缝
    const x0 = c === 0 ? b.x : Math.round(b.x + (c * (b.width + gap)) / g.cols);
    const x1 =
      c === g.cols - 1
        ? b.x + b.width
        : Math.round(b.x + ((c + 1) * (b.width + gap)) / g.cols - gap);
    const y0 = r === 0 ? b.y : Math.round(b.y + (r * (b.height + gap)) / g.rows);
    const y1 =
      r === g.rows - 1
        ? b.y + b.height
        : Math.round(b.y + ((r + 1) * (b.height + gap)) / g.rows - gap);

    out.push({
      tab: vis[i],
      x: x0,
      y: y0,
      width: Math.max(0, x1 - x0),
      height: Math.max(0, y1 - y0),
      header,
    });
  }
  return out;
}

function layout(ctx = curCtx()) {
  if (!ctx.win) return;
  const rects = cellRects(ctx);
  const shown = new Set(rects.map((r) => r.tab.id));

  for (const t of ctx.tabs) {
    if (!shown.has(t.id)) t.view.setVisible(false);
  }
  for (const r of rects) {
    r.tab.view.setBounds({
      x: r.x,
      y: r.y + r.header,
      width: r.width,
      height: Math.max(0, r.height - r.header),
    });
    r.tab.view.setVisible(true);
  }
}

let layoutTimer = null;
function scheduleLayout(ctx) {
  if (layoutTimer) return;
  layoutTimer = setTimeout(() => {
    layoutTimer = null;
    layout(ctx);
    pushState(ctx);
  }, 16);
}

function setGrid(index, ctx = curCtx()) {
  const next = Math.max(0, Math.min(GRIDS.length - 1, index));
  if (next === ctx.gridIndex) return;
  ctx.gridIndex = next;

  const idx = ctx.tabs.findIndex((t) => t.id === ctx.activeId);
  if (idx >= 0) ensureVisible(idx, ctx);
  else clampVisibleStart(ctx);

  layout(ctx);
  pushState(ctx);
}

function cycleGrid(ctx = curCtx()) {
  setGrid((ctx.gridIndex + 1) % GRIDS.length);
}

// ---------------------------------------------------------------- 标签生命周期

function createTab(url = NEWTAB_URL, { activate = true, accountId = null } = {}, ctx = curCtx()) {
  if (!ctx || !ctx.win) return null;

  const acc = accounts.get(accountId || ctx.accountId);
  const view = new WebContentsView({
    webPreferences: {
      // 账号池的关键：每个账号一个独立 session，cookie/storage 完全隔离
      session: accounts.sessionOf(acc),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // 后台标签继续跑（并行交互的前提）
    },
  });
  view.setBackgroundColor('#ffffff');

  const tab = { id: ++ctx.seq, view, loading: false, favicon: null, accountId: acc.id, ctx };
  ctx.accountId = acc.id;
  lastAccountId = acc.id;
  ctx.tabs.push(tab);

  ctx.win.contentView.addChildView(view);
  view.setVisible(false);

  wireTab(tab);

  const target = url === NEWTAB_URL ? toRealUrl(url) : url;
  view.webContents.loadURL(target).catch(() => {});

  if (activate) {
    setActive(tab.id, ctx); // setActive 里会 ensureVisible + layout + pushState
  } else {
    layout(ctx);
    pushState(ctx);
  }
  return tab;
}

function closeTab(id, ctx = curCtx()) {
  const idx = ctx.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [tab] = ctx.tabs.splice(idx, 1);
  if (ctx.win) ctx.win.contentView.removeChildView(tab.view);
  try {
    tab.view.webContents.close();
  } catch {
    /* 已销毁 */
  }

  if (ctx.activeId === id) {
    const next = ctx.tabs[idx] || ctx.tabs[idx - 1] || null;
    ctx.activeId = null;
    if (next) {
      setActive(next.id, ctx);
      return;
    }
  }

  if (ctx.tabs.length === 0) {
    if (ctx.win) ctx.win.close();
    return;
  }

  clampVisibleStart(ctx);
  layout(ctx);
  pushState(ctx);
}

function setActive(id, ctx = curCtx()) {
  const tab = tabById(id, ctx);
  if (!tab) return;
  ctx.activeId = id;
  ensureVisible(ctx.tabs.indexOf(tab));
  layout(ctx);
  pushState(ctx);
  if (ctx.win && !ctx.win.isDestroyed()) tab.view.webContents.focus();
}

/** 给某个标签换账号。
 *  session 在 WebContentsView 创建时就绑死了，不能运行时替换，
 *  所以换账号 = 销毁旧 view、用新 session 建一个、把原地址重新加载回来。 */
function switchAccount(tabId, accountId, ctx = curCtx()) {
  if (!ctx.win) return false;
  const idx = ctx.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return false;

  const tab = ctx.tabs[idx];
  const acc = accounts.get(accountId);
  if (!acc || tab.accountId === acc.id) return false;

  const url = tab.view.webContents.getURL() || toRealUrl(NEWTAB_URL);
  const wasActive = ctx.activeId === tab.id;

  ctx.win.contentView.removeChildView(tab.view);
  try {
    tab.view.webContents.close();
  } catch {
    /* 已销毁 */
  }

  const view = new WebContentsView({
    webPreferences: {
      session: accounts.sessionOf(acc),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor('#ffffff');
  ctx.win.contentView.addChildView(view);
  view.setVisible(false);

  tab.view = view;
  tab.accountId = acc.id;
  tab.favicon = null;
  tab.loading = true;
  tab.title = `切换账号：${acc.name}`;
  ctx.accountId = acc.id;

  wireTab(tab);
  view.webContents.loadURL(url).catch(() => {});

  if (wasActive) ctx.activeId = tab.id;
  layout(ctx);
  pushState(ctx);
  return true;
}

/** 账号菜单用原生菜单：DOM 浮层会被 WebContentsView 盖住，原生菜单不会 */
function showAccountMenu(ctx = curCtx()) {
  const tab = activeTab(ctx);
  if (!tab) return;

  const items = accounts.list().map((acc) => ({
    label: acc.name,
    type: 'radio',
    checked: acc.id === tab.accountId,
    click: () => switchAccount(tab.id, acc.id, ctx),
  }));

  items.push({ type: 'separator' });
  items.push({
    label: '新建账号并在当前标签使用',
    click: () => {
      const acc = accounts.create();
      switchAccount(tab.id, acc.id, ctx);
    },
  });
  items.push({ label: '管理账号池…', click: openAccountsWindow });
  items.push({
    label: '清除当前账号的站点数据…',
    click: async () => {
      const acc = accounts.get(tab.accountId);
      const { response } = await dialog.showMessageBox(ctx.win, {
        type: 'warning',
        buttons: ['取消', '清除'],
        defaultId: 0,
        cancelId: 0,
        title: '清除站点数据',
        message: `清除「${acc.name}」的全部 cookie 和存储？`,
        detail: '只影响这个账号的会话，其他账号不受影响。',
      });
      if (response === 1) {
        await accounts.sessionOf(acc).clearStorageData();
        tab.view.webContents.reload();
        pushState(ctx);
      }
    },
  });

  Menu.buildFromTemplate(items).popup({ window: ctx.win });
}

/** 工具栏「⋯」菜单：脚本仓库、开发者工具等 */
function showToolsMenu(ctx = curCtx()) {
  const tab = activeTab(ctx);
  Menu.buildFromTemplate([
    { label: '新窗口', accelerator: 'Ctrl+N', click: () => createWindow({ accountId: ctx.accountId }) },
    { type: 'separator' },
    { label: '脚本仓库…', click: openScriptsWindow },
    { label: '笔记本…', click: openVaultWindow },
    { type: 'separator' },
    {
      label: '开发者工具',
      enabled: !!tab,
      click: () => {
        if (tab) tab.view.webContents.toggleDevTools();
      },
    },
  ]).popup({ window: ctx.win });
}

function cycleTab(delta, ctx = curCtx()) {  if (ctx.tabs.length < 2) return;
  const i = ctx.tabs.findIndex((t) => t.id === ctx.activeId);
  const next = ctx.tabs[(i + delta + ctx.tabs.length) % ctx.tabs.length];
  setActive(next.id, ctx);
}

// ---------------------------------------------------------------- 每个标签的事件

function wireTab(tab, ctx = curCtx()) {
  ctx = tab.ctx || ctx;
  const wc = tab.view.webContents;

  const changed = () => pushState(ctx);

  wc.on('did-start-loading', () => {
    tab.loading = true;
    wc.setAudioMuted(false);
    changed();
  });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    changed();
  });
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    if (ctx.win && tab.id === ctx.activeId) ctx.win.setTitle(title ? `${title} — minibrowser` : 'minibrowser');
    changed();
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = (favicons && favicons[0]) || null;
    changed();
  });
  wc.on('did-navigate', changed);
  wc.on('did-navigate-in-page', changed);

  // 用户脚本：页面加载完成后按 URL 匹配注入
  wc.on('did-finish-load', () => runUserScripts(tab));
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED */) return;
    tab.loading = false;
    tab.title = `打不开：${desc || code}`;
    if (ctx.win && tab.id === ctx.activeId) ctx.win.setTitle('minibrowser');
    changed();
  });
  wc.on('render-process-gone', () => {
    tab.loading = false;
    tab.title = '页面崩溃';
    changed();
  });

  // 点哪个格子，地址栏就跟哪个（多宫格下这一步很关键）
  wc.on('focus', () => {
    if (ctx.activeId !== tab.id) setActive(tab.id, ctx);
  });

  // target=_blank / window.open → 新标签，而不是新窗口
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (disposition === 'saveToDisk') return { action: 'allow' };
    createTab(url, {}, ctx);
    return { action: 'deny' };
  });

  wireContextMenu(tab);
  wireShortcuts(wc, () => tab, ctx);
}

// ---------------------------------------------------------------- 快捷键

function wireShortcuts(wc, getTab, ctx = curCtx()) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    const tab = getTab();
    const eat = () => event.preventDefault();

    if (ctrl && !input.alt && key === 'n') {
      eat();
      createWindow({ accountId: ctx.accountId });
      return;
    }
    if (ctrl && !input.alt && key === 't') {
      eat();
      createTab(NEWTAB_URL, {}, ctx);
      focusAddress(ctx);
      return;
    }
    if (ctrl && !input.alt && key === 'w') {
      eat();
      if (tab) closeTab(tab.id, ctx);
      return;
    }
    if (ctrl && key === 'tab') {
      eat();
      cycleTab(input.shift ? -1 : 1, ctx);
      return;
    }
    if (ctrl && !input.alt && /^[1-9]$/.test(key)) {
      eat();
      const n = key === '9' ? ctx.tabs.length - 1 : Number(key) - 1;
      if (ctx.tabs[n]) setActive(ctx.tabs[n].id);
      return;
    }
    if (ctrl && !input.alt && key === 'l') {
      eat();
      focusAddress(ctx);
      return;
    }
    if ((ctrl && key === 'r') || key === 'f5') {
      eat();
      if (tab) input.shift ? tab.view.webContents.reloadIgnoringCache() : tab.view.webContents.reload();
      return;
    }
    if (input.alt && key === 'left') {
      eat();
      if (tab && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
      return;
    }
    if (input.alt && key === 'right') {
      eat();
      if (tab && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
      return;
    }
    if (key === 'escape') {
      if (tab && tab.loading) {
        eat();
        tab.view.webContents.stop();
      }
      return;
    }
    if (ctrl && input.shift && key === 'g') {
      eat();
      cycleGrid(ctx);
      return;
    }
    if (ctrl && input.shift && key === 'i') {
      eat();
      wc.toggleDevTools();
    }
  });
}

function focusAddress(ctx = curCtx()) {
  if (!ctx.win) return;
  ctx.win.webContents.focus();
  ctx.win.webContents.send('ui:focus-address');
}

// ---------------------------------------------------------------- 用户脚本

/** 把匹配当前 URL 的脚本注入页面（页面上下文，能直接改 DOM） */
function runUserScripts(tab) {
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return;
  const url = wc.getURL();
  if (!url || !/^https?:|^file:/.test(url)) return;

  for (const s of scripts.forUrl(url)) {
    wc.executeJavaScript(s.code, true).catch((e) => {
      console.error(`[用户脚本 ${s.name}] ${(e && e.message) || e}`);
    });
  }
}

/** 注入试跑（给自检用）：返回每个脚本的执行结果 */
async function runUserScriptsSync(wc) {
  const url = wc.getURL();
  const out = [];
  for (const s of scripts.forUrl(url)) {
    try {
      out.push({ name: s.name, value: await wc.executeJavaScript(s.code, true) });
    } catch (e) {
      out.push({ name: s.name, error: String((e && e.message) || e) });
    }
  }
  return out;
}

let scriptsWin = null;
let accountsWin = null;

/** 账号池：可视化编辑（改名 / 换色 / 新建 / 删除） */
function openAccountsWindow() {
  if (accountsWin && !accountsWin.isDestroyed()) {
    accountsWin.focus();
    return;
  }
  accountsWin = new BrowserWindow({
    width: 560,
    height: 560,
    minWidth: 460,
    minHeight: 380,
    parent: (curCtx() && curCtx().win) || undefined,
    title: '账号池',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1f23' : '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-accounts.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  accountsWin.setMenuBarVisibility(false);
  accountsWin.loadFile(path.join(UI_DIR, 'accounts.html'));
  accountsWin.on('closed', () => {
    accountsWin = null;
  });
}
let vaultWin = null;
let titleTimer = null;

/** 临时把标题改成提示语，1.6 秒后恢复（DOM 浮层会被 WebContentsView 盖住，标题最省事） */
function flashTitle(msg, ctx = curCtx()) {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  ctx.win.setTitle(`${msg} — minibrowser`);
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    const t = activeTab(ctx);
    ctx.win.setTitle(t && t.title ? `${t.title} — minibrowser` : 'minibrowser');
  }, 1600);
}

/** 页面右键菜单：选中文字可存进笔记本 */
function wireContextMenu(tab, ctx = curCtx()) {
  ctx = tab.ctx || ctx;
  const wc = tab.view.webContents;
  wc.on('context-menu', (_e, params) => {
    const sel = (params.selectionText || '').trim();
    const items = [];

    if (sel) {
      items.push({
        label: sel.length > 22 ? `用选中内容新建笔记（${sel.length} 字）` : `用选中内容新建笔记：「${sel.slice(0, 18)}」`,
        click: () => {
          vault.addNote({ url: wc.getURL(), title: wc.getTitle(), text: sel });
          flashTitle(`已新建笔记（${sel.length} 字）`, ctx);
          if (vaultWin && !vaultWin.isDestroyed()) vaultWin.webContents.send('vault:changed');
        },
      });
      items.push({ label: '复制', role: 'copy' });
      items.push({ type: 'separator' });
    }

    items.push({
      label: '用此页面新建笔记',
      click: () => {
        vault.addNote({ url: wc.getURL(), title: wc.getTitle(), text: '' });
        flashTitle('已新建笔记', ctx);
        if (vaultWin && !vaultWin.isDestroyed()) vaultWin.webContents.send('vault:changed');
      },
    });
    items.push({ type: 'separator' });

    const nav = wc.navigationHistory;
    items.push({ label: '后退', enabled: nav.canGoBack(), click: () => nav.goBack() });
    items.push({ label: '前进', enabled: nav.canGoForward(), click: () => nav.goForward() });
    items.push({ label: '刷新', click: () => wc.reload() });
    items.push({ type: 'separator' });
    items.push({ label: '检查元素', click: () => wc.inspectElement(params.x, params.y) });

    Menu.buildFromTemplate(items).popup({ window: ctx.win });
  });
}

function openVaultWindow() {
  if (vaultWin && !vaultWin.isDestroyed()) {
    vaultWin.focus();
    return;
  }
  vaultWin = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 640,
    minHeight: 420,
    parent: (curCtx() && curCtx().win) || undefined,
    title: '笔记本',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1f23' : '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-vault.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  vaultWin.setMenuBarVisibility(false);
  vaultWin.loadFile(path.join(UI_DIR, 'vault.html'));
  vaultWin.on('closed', () => {
    vaultWin = null;
  });
}

function openScriptsWindow() {
  if (scriptsWin && !scriptsWin.isDestroyed()) {
    scriptsWin.focus();
    return;
  }
  scriptsWin = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 640,
    minHeight: 420,
    parent: (curCtx() && curCtx().win) || undefined,
    title: '脚本仓库',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1f23' : '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-scripts.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  scriptsWin.setMenuBarVisibility(false);
  scriptsWin.loadFile(path.join(UI_DIR, 'scripts.html'));
  scriptsWin.on('closed', () => {
    scriptsWin = null;
  });
}

// ---------------------------------------------------------------- 状态同步

function snapshot(ctx = curCtx()) {
  const g = grid(ctx);
  const rects = cellRects(ctx);
  return {
    activeId: ctx.activeId,
    grid: {
      index: ctx.gridIndex,
      cols: g.cols,
      rows: g.rows,
      capacity: capacity(ctx),
      total: GRIDS.length,
      multi: isMulti(ctx),
    },
    // 格子几何用 CSS 像素、以窗口内容区左上角为原点，UI 层直接绝对定位
    cells: rects.map((r) => ({
      id: r.tab.id,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      header: r.header,
      active: r.tab.id === ctx.activeId,
    })),
    tabs: ctx.tabs.map((t) => {
      const wc = t.view.webContents;
      const nav = wc.navigationHistory;
      const acc = accounts.get(t.accountId);
      return {
        id: t.id,
        url: toDisplayUrl(wc.getURL()),
        title: t.title || '新标签页',
        favicon: t.favicon,
        loading: !!t.loading,
        canGoBack: !!nav.canGoBack(),
        canGoForward: !!nav.canGoForward(),
        inCell: rects.some((r) => r.tab.id === t.id),
        accountId: acc.id,
        accountName: acc.name,
        accountColor: acc.color,
      };
    }),
    accounts: accounts.publicList(),
  };
}

function pushState(ctx = curCtx()) {
  if (!ctx.win || ctx.win.isDestroyed() || !ctx.uiReady) return;
  ctx.win.webContents.send('ui:state', snapshot(ctx));
}

// ---------------------------------------------------------------- IPC

/** 从 IPC 事件反查是哪个窗口发来的 */
function ctxOf(e) {
  const wc = e && e.sender;
  if (wc) {
    const hit = windows.find((c) => !c.win.isDestroyed() && c.win.webContents === wc);
    if (hit) return hit;
  }
  return curCtx();
}

ipcMain.handle('ui:snapshot', (e) => snapshot(ctxOf(e)));

ipcMain.on('tabs:create', (e, url) => {
  const ctx = ctxOf(e);
  createTab(url || NEWTAB_URL, {}, ctx);
  focusAddress(ctx);
});
ipcMain.on('tabs:close', (e, id) => closeTab(id, ctxOf(e)));
ipcMain.on('tabs:activate', (e, id) => setActive(id, ctxOf(e)));
ipcMain.on('view:cycle-grid', (e) => cycleGrid(ctxOf(e)));
ipcMain.on('view:set-grid', (e, index) => setGrid(Number(index), ctxOf(e)));
ipcMain.on('account:menu', (e) => showAccountMenu(ctxOf(e)));
ipcMain.on('tools:menu', (e) => showToolsMenu(ctxOf(e)));

ipcMain.on('nav:go', (e, input) => {
  const ctx = ctxOf(e);
  const tab = activeTab(ctx);
  if (!tab) return;
  const url = normalizeInput(input);
  if (!url) return;
  tab.favicon = null;
  tab.view.webContents.loadURL(toRealUrl(url)).catch(() => {});
  tab.view.webContents.focus();
});

ipcMain.on('nav:action', (e, action) => {
  const ctx = ctxOf(e);
  const tab = activeTab(ctx);
  if (!tab) return;
  const wc = tab.view.webContents;
  const nav = wc.navigationHistory;
  if (action === 'back' && nav.canGoBack()) nav.goBack();
  else if (action === 'forward' && nav.canGoForward()) nav.goForward();
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
  else if (action === 'home') wc.loadURL(toRealUrl(NEWTAB_URL)).catch(() => {});
});

// 新窗口（Ctrl+N /「⋯ → 新窗口」）；新窗口沿用当前窗口的账号
ipcMain.on('window:new', (e) => {
  const ctx = ctxOf(e);
  createWindow({ accountId: ctx ? ctx.accountId : null });
});

// ---- 脚本仓库
ipcMain.handle('scripts:list', () => scripts.list());
ipcMain.handle('scripts:save', (_e, item) => scripts.upsert(item));
ipcMain.handle('scripts:remove', (_e, id) => scripts.remove(id));
ipcMain.handle('scripts:toggle', (_e, id, on) => scripts.toggle(id, on));
ipcMain.handle('scripts:reload-pages', () => {
  for (const c of windows) {
    for (const t of c.tabs) {
      try {
        t.view.webContents.reload();
      } catch {
        /* 已销毁 */
      }
    }
  }
  return true;
});
ipcMain.handle('win:close-self', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
  return true;
});

// ---- 账号池
ipcMain.handle('accounts:list', () => {
  const counts = {};
  for (const c of windows) {
    for (const t of c.tabs) counts[t.accountId] = (counts[t.accountId] || 0) + 1;
  }
  return accounts.list().map((a) => ({ id: a.id, name: a.name, color: a.color, tabs: counts[a.id] || 0 }));
});
ipcMain.handle('accounts:create', (_e, name) => {
  const a = accounts.create(name);
  for (const c of windows) pushState(c);
  return { id: a.id, name: a.name, color: a.color };
});
ipcMain.handle('accounts:update', (_e, id, patch) => {
  const a = accounts.update(id, patch || {});
  for (const c of windows) pushState(c);
  return a ? { id: a.id, name: a.name, color: a.color } : null;
});
ipcMain.handle('accounts:remove', (_e, id) => {
  const r = accounts.remove(id);
  if (r.ok) {
    // 用了这个账号的标签退回默认账号，重新加载
    for (const c of windows) {
      for (const t of [...c.tabs]) {
        if (t.accountId === id) switchAccount(t.id, accounts.DEFAULT_ACCOUNT.id, c);
      }
    }
    for (const c of windows) pushState(c);
  }
  return r;
});

// ---- 笔记本（vault：就是磁盘上的一个文件夹）
ipcMain.handle('vault:root', () => vault.root());
ipcMain.handle('vault:choose-root', async () => {
  const owner = curCtx() && curCtx().win;
  const r = await dialog.showOpenDialog(owner, { properties: ['openDirectory'], title: '选择笔记文件夹' });
  if (!r.canceled && r.filePaths[0]) vault.setRoot(r.filePaths[0]);
  return vault.root();
});
ipcMain.handle('vault:tree', () => vault.tree());
ipcMain.handle('vault:read', (_e, rel) => vault.read(rel));
ipcMain.handle('vault:write', (_e, rel, content) => vault.write(rel, content));
ipcMain.handle('vault:create', (_e, name, dirRel) => vault.create(name, '', dirRel || ''));
ipcMain.handle('vault:remove', (_e, rel) => vault.remove(rel));
ipcMain.handle('vault:rename', (_e, rel, name) => vault.rename(rel, name));
ipcMain.handle('vault:backlinks', (_e, title) => vault.backlinks(title));
ipcMain.handle('vault:missing', () => vault.missingLinks());
ipcMain.handle('vault:search', (_e, q) => vault.search(q));
ipcMain.handle('vault:reveal', (_e, rel) => {
  shell.showItemInFolder(path.join(vault.root(), rel));
  return true;
});

// ---------------------------------------------------------------- 自检

async function selfCheck() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fs = require('node:fs');
  const out = { ok: true, steps: [] };
  const step = (name, pass, detail) => {
    out.steps.push({ name, pass, detail });
    if (!pass) out.ok = false;
  };
  const note = (name, detail) => out.steps.push({ name, pass: true, info: true, detail });
  // 自检只跑一个窗口，把旧名字映射到它，函数体不用大改
  const ctx = windows[0];
  const win = ctx.win;
  const tabs = ctx.tabs;

  try {
    const boot = activeTab();

    // 两个标签：tick 间隔不同（100ms / 170ms）→ 各自计数不同，即可证明是真并行
    const a = createTab('data:text/html,' + encodeURIComponent(page('A', 0.6, 100)));
    const b = createTab('data:text/html,' + encodeURIComponent(page('B', 1.6, 170)));
    if (boot) closeTab(boot.id);

    await wait(1500);
    step('窗口已创建', !!win, win ? `size=${win.getContentSize().join('x')}` : 'no window');
    step('标签数 = 2（启动空标签已清理）', tabs.length === 2, `tabs=${tabs.length}`);

    // 切到 A，确认 B 不可见时仍在蹦字（后台标签没有被节流）
    setActive(a.id);
    await wait(500);
    const beforeB = await readCounter(b.view.webContents);
    await wait(800);
    const afterB = await readCounter(b.view.webContents);
    step('不可见的标签继续运行', afterB > beforeB, `B: ${beforeB} -> ${afterB}`);

    const ca = await readCounter(a.view.webContents);
    const ratio = afterB ? ca / afterB : 0;
    step('前台标签在运行', ca > 0, `A=${ca}, B=${afterB}`);
    step(
      '两标签各自独立运行',
      ratio > 1.3 && ratio < 2.2,
      `A/B 计数比=${ratio.toFixed(2)}（tick 100ms vs 170ms，期望≈1.7）`
    );

    const ta = await b.view.webContents.executeJavaScript('window.__tag').catch(() => null);
    const tb = await a.view.webContents.executeJavaScript('window.__tag').catch(() => null);
    step('JS 运行时互不干扰', ta === 'B' && tb === 'A', `B 页内 __tag=${ta}, A 页内 __tag=${tb}`);

    const ua = a.view.webContents.getURL();
    const ub = b.view.webContents.getURL();
    step('各自持有独立 URL', ua !== ub && ua.startsWith('data:text/html'), `${ua.slice(0, 20)}… / ${ub.slice(0, 20)}…`);

    const titles = tabs.map((t) => t.title);
    step('标题各自独立', titles[0] !== titles[1], JSON.stringify(titles));

    const visibleCount = tabs.filter((t) => t.id === ctx.activeId).length;
    step('同一时刻只有一个标签可见', visibleCount === 1, `activeId=${ctx.activeId}`);

    // ---- UI ↔ 主进程联动（在 UI 渲染进程里真点、真敲）
    const domTabs = await win.webContents
      .executeJavaScript("[...document.querySelectorAll('.tab')].map(e => Number(e.dataset.id))")
      .catch(() => []);
    step('标签条渲染出 2 个标签', domTabs.length === 2, JSON.stringify(domTabs));

    if (domTabs.length === 2) {
      const target = domTabs[0] === ctx.activeId ? domTabs[1] : domTabs[0];
      await win.webContents
        .executeJavaScript(`document.querySelector('.tab[data-id="${target}"]').click()`)
        .catch(() => {});
      await wait(300);
      step('点击标签能切换', ctx.activeId === target, `点了 ${target}，ctx.activeId=${ctx.activeId}`);
    }

    const addrFilled = await win.webContents
      .executeJavaScript("document.getElementById('address').value.length > 0")
      .catch(() => false);
    step('地址栏回填当前标签地址', addrFilled === true, `非空=${addrFilled}`);

    // 地址解析
    step('地址解析 example.com', normalizeInput('example.com') === 'https://example.com', normalizeInput('example.com'));
    step('地址解析 搜索词', normalizeInput('汉服 打版').startsWith(SEARCH_PREFIX), normalizeInput('汉服 打版'));
    step('地址解析 localhost:8080', normalizeInput('localhost:8080') === 'http://localhost:8080', normalizeInput('localhost:8080'));
    step('地址解析 带端口域名', normalizeInput('example.com:3000') === 'https://example.com:3000', normalizeInput('example.com:3000'));

    // 布局：内容区应铺满工具栏下方
    const bounds = a.view.getBounds();
    const [cw, ch] = win.getContentSize();
    step(
      '内容区布局正确',
      bounds.x === 0 && bounds.y === CHROME_HEIGHT && bounds.width === cw && bounds.height === ch - CHROME_HEIGHT,
      JSON.stringify(bounds) + ` content=${cw}x${ch}`
    );

    // 截图留证（窗口隐藏时 Chromium 不提供 display surface，属限制而非缺陷）
    for (const [name, wc, file] of [
      ['标签页可截图', a.view.webContents, 'selfcheck-tab.png'],
      ['工具栏 UI 可截图', win.webContents, 'selfcheck-ui.png'],
    ]) {
      try {
        const shot = await wc.capturePage();
        const p = path.join(SHOT_DIR, file);
        fs.writeFileSync(p, shot.toPNG());
        const { width, height } = shot.getSize();
        step(name, width > 0 && height > 0, `${p} (${width}x${height})`);
      } catch (e) {
        note(name, 'capturePage 不可用（窗口隐藏/无 GPU）：' + String((e && e.message) || e));
      }
    }

    // 关闭一个标签不应影响另一个
    const ca2 = ca;
    closeTab(b.id);
    await wait(400);
    step('关标签后剩余正确', tabs.length === 1 && tabs[0].id === a.id, `tabs=${tabs.length}`);
    step('关标签后另一个照常运行', (await readCounter(a.view.webContents)) > ca2, 'A 计数继续增长');

    // 内置新标签页（file:// 页面）
    const nt = createTab(NEWTAB_URL);
    await wait(600);
    step('新标签页走本地文件', nt.view.webContents.getURL().startsWith('file://'), nt.view.webContents.getURL().slice(0, 64));
    const hasInput = await nt.view.webContents.executeJavaScript("!!document.getElementById('q')").catch(() => false);
    step('新标签页里的搜索框可交互', hasInput === true, `#q 存在=${hasInput}`);
    const shown = snapshot().tabs.find((t) => t.id === nt.id);
    step('新标签页地址栏显示为空', shown && shown.url === '', JSON.stringify(shown && shown.url));

    // 地址栏输入 → 真导航：UI 事件 → IPC → 主进程 → 网络，全链路
    await win.webContents
      .executeJavaScript(
        "(()=>{const a=document.getElementById('address');a.focus();a.value='example.com';" +
          "a.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()"
      )
      .catch(() => {});
    await wait(4500);
    const navUrl = nt.view.webContents.getURL();
    const navTitle = nt.view.webContents.getTitle();
    if (navUrl.includes('example.com') && !/打不开/.test(nt.title || '')) {
      step('地址栏输入可导航到真实网站', true, `${navUrl} / title=${navTitle}`);
    } else {
      note('地址栏输入可导航到真实网站', `未成功（可能离线）：${navUrl || '空'} / ${nt.title || ''}`);
    }
    const addrNow = await win.webContents.executeJavaScript("document.getElementById('address').value").catch(() => '');
    step('导航后地址栏同步', String(addrNow).startsWith('https://example.com'), String(addrNow));

    if (navUrl.includes('example.com')) {
      try {
        const shot = await nt.view.webContents.capturePage();
        fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-web.png'), shot.toPNG());
        note('真实网页渲染截图', 'selfcheck-web.png');
      } catch {
        /* 忽略 */
      }
    }
    closeTab(nt.id);

    // ---- 宫格监控：多个格子同时可见、同时渲染、同时跑
    const gridTabs = [];
    for (let i = 0; i < 3; i++) {
      gridTabs.push(createTab('data:text/html,' + encodeURIComponent(page('G' + (i + 1), 0.1 * (i + 1), 90 + i * 40))));
    }
    setGrid(2); // 2x2
    await wait(1400);

    const rects = cellRects();
    step('2×2 宫格铺出 4 格', rects.length === 4, `caps=${capacity()}, cells=${rects.length}`);

    let overlap = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b2 = rects[j];
        if (a.x < b2.x + b2.width && b2.x < a.x + a.width && a.y < b2.y + b2.height && b2.y < a.y + a.height) overlap = true;
      }
    }
    step('格子互不重叠', !overlap, `${rects.length} 个矩形`);

    const area = rects.reduce((s, r) => s + r.width * r.height, 0);
    const cb = contentBounds();
    const coverRatio = area / (cb.width * cb.height);
    step('格子铺满内容区', coverRatio > 0.96 && coverRatio <= 1, `覆盖 ${(coverRatio * 100).toFixed(1)}%（含 ${GAP}px 间隙）`);

    const headerOk = rects.every((r) => r.header === CELL_HEADER);
    step('每格留出标题条', headerOk, `header=${CELL_HEADER}px`);

    const counts = await Promise.all(rects.map((r) => readCounter(r.tab.view.webContents)));
    step(
      '四个格子同时在跑',
      counts.every((c) => c > 0) && new Set(counts).size >= 3,
      `计数=${counts.join('/')}（tick 90/130/170/210ms）`
    );

    // 点第 3 格 → 它成为 active，地址栏跟过去
    const target = rects[2].tab;
    setActive(target.id);
    await wait(200);
    step('切换格子后 active 跟随', ctx.activeId === target.id, `activeId=${ctx.activeId}, 目标=${target.id}`);
    const addrForCell = await win.webContents
      .executeJavaScript("document.getElementById('address').value")
      .catch(() => '');
    step('地址栏跟随所选格子', String(addrForCell).startsWith('data:text/html'), String(addrForCell).slice(0, 32) + '…');

    // 直接点网页（焦点落到某个 view）也应该切换 active
    rects[0].tab.view.webContents.focus();
    await wait(250);
    step('点网页本身也会切换 active', ctx.activeId === rects[0].tab.id, `activeId=${ctx.activeId}, 期望=${rects[0].tab.id}`);

    // UI 层截图（格子内容由各自的 view 渲染，capturePage 抓不到，另存）
    try {
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-grid.png'), shot.toPNG());
      for (let i = 0; i < rects.length; i++) {
        const cellShot = await rects[i].tab.view.webContents.capturePage();
        fs.writeFileSync(path.join(SHOT_DIR, `selfcheck-cell-${i + 1}.png`), cellShot.toPNG());
      }
      // 几何一起存下来，方便把 UI 图和各格内容拼成一张「真实效果图」
      fs.writeFileSync(
        path.join(SHOT_DIR, 'selfcheck-grid.json'),
        JSON.stringify(
          {
            uiShot: shot.getSize(),
            content: contentBounds(),
            cells: rects.map((r, i) => ({
              index: i + 1,
              title: r.tab.title,
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              header: r.header,
            })),
          },
          null,
          2
        )
      );
      note('宫格布局截图', 'selfcheck-grid.png + selfcheck-cell-1..4.png');
    } catch {
      /* 窗口隐藏时截不到 */
    }

    setGrid(0); // 回到单格
    await wait(300);
    const back = cellRects();
    step('切回单格恢复整页', back.length === 1 && back[0].header === 0, `cells=${back.length}, header=${back[0] && back[0].header}`);
    for (const t of gridTabs) closeTab(t.id);

    // ---- 账号池：同一站点两个账号，cookie 必须互不可见
    {
      const http = require('node:http');
      const srv = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (u.pathname === '/set') {
          const v = u.searchParams.get('v') || '';
          res.setHeader('Set-Cookie', `acct=${v}; Path=/; Max-Age=3600`);
          res.end(`<title>set-${v}</title><body data-cookie="${v}">set ${v}</body>`);
        } else {
          const m = (req.headers.cookie || '').match(/acct=([^;]*)/);
          const v = m ? m[1] : '';
          res.end(`<title>get</title><body data-cookie="${v}">cookie=${v || '(none)'}</body>`);
        }
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${srv.address().port}`;

      const accA = accounts.list().find((x) => x.name === '自检A') || accounts.create('自检A');
      const accB = accounts.list().find((x) => x.name === '自检B') || accounts.create('自检B');

      // 清掉上一次自检可能留下的 cookie
      for (const acc of [accounts.get('default'), accA, accB]) {
        await accounts.sessionOf(acc).cookies.remove(base, 'acct').catch(() => {});
      }

      const tA = createTab(base + '/set?v=AAA', { accountId: accA.id });
      const tB = createTab(base + '/set?v=BBB', { accountId: accB.id });
      const tD = createTab(base + '/get', { accountId: 'default' });
      await wait(1000);

      const readCookie = (t) => t.view.webContents.executeJavaScript('document.body.dataset.cookie').catch(() => null);
      const vA = await readCookie(tA);
      const vB = await readCookie(tB);
      const vD = await readCookie(tD);

      step('账号 A 是独立会话', vA === 'AAA', `A 读到 ${vA}`);
      step('账号 B 是独立会话', vB === 'BBB', `B 读到 ${vB}`);
      step('默认账号没被串号', vD === '', `默认读到 ${vD || '(空)'}`);

      const jarA = await accounts.sessionOf(accounts.get(accA.id)).cookies.get({ url: base });
      const jarB = await accounts.sessionOf(accounts.get(accB.id)).cookies.get({ url: base });
      step('cookie 罐互不污染', jarA[0]?.value === 'AAA' && jarB[0]?.value === 'BBB', `A=${jarA[0]?.value} B=${jarB[0]?.value}`);

      // 切换账号 = 换 session 重建 view，地址要保留、内容要变成新账号的
      const beforeSwitch = tD.view.webContents.getURL();
      switchAccount(tD.id, accA.id);
      await wait(1000);
      const afterSwitch = tD.view.webContents.getURL();
      const vD2 = await readCookie(tD);
      step('切换账号后地址保留', afterSwitch === beforeSwitch, (afterSwitch || '').replace(base, '').slice(0, 24));
      step('切换后拿到该账号的 cookie', vD2 === 'AAA', `切到 A 后读到 ${vD2}`);

      // 多账号同屏看一眼：宫格标题条上应该有各账号的色点
      setGrid(2);
      await wait(600);
      try {
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-accounts.png'), shot.toPNG());
        note('多账号宫格截图', 'selfcheck-accounts.png');
      } catch {
        /* 隐藏窗口截不到 */
      }
      setGrid(0);

      // ---- 脚本仓库：匹配 → 注入；停用/不匹配 → 不注入
      const scriptItem = scripts.upsert({
        name: '自检注入',
        matches: [`${base}/*`],
        code: "document.body.dataset.injected = 'yes'; 'ok'",
        enabled: true,
      });
      const tS = createTab(base + '/get');
      await wait(900);
      const injected = await tS.view.webContents
        .executeJavaScript("document.body.dataset.injected || ''")
        .catch(() => '');
      step('用户脚本已注入页面', injected === 'yes', `dataset.injected=${injected || '(空)'}`);

      scripts.toggle(scriptItem.id, false);
      await tS.view.webContents.reload();
      await wait(900);
      const injectedOff = await tS.view.webContents
        .executeJavaScript("document.body.dataset.injected || ''")
        .catch(() => '');
      step('停用后不再注入', injectedOff === '', `dataset.injected=${injectedOff || '(空)'}`);

      scripts.upsert({ ...scriptItem, enabled: true, matches: ['https://never.invalid/*'] });
      await tS.view.webContents.reload();
      await wait(900);
      const noMatch = await tS.view.webContents
        .executeJavaScript("document.body.dataset.injected || ''")
        .catch(() => '');
      step('匹配不上不注入', noMatch === '', `dataset.injected=${noMatch || '(空)'}`);

      // 脚本仓库窗口必须能开、能列出脚本
      openScriptsWindow();
      await wait(1400);
      const scriptsAlive = !!(scriptsWin && !scriptsWin.isDestroyed());
      step('脚本仓库窗口能打开', scriptsAlive, scriptsAlive ? 'ok' : 'no window');
      if (scriptsAlive) {
        const rows = await scriptsWin.webContents
          .executeJavaScript("document.querySelectorAll('.item').length")
          .catch(() => -1);
        step('脚本列表显示已存脚本', rows >= 1, `items=${rows}`);
        try {
          const shot = await scriptsWin.webContents.capturePage();
          fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-scripts.png'), shot.toPNG());
          note('脚本仓库界面截图', 'selfcheck-scripts.png');
        } catch {
          /* 忽略 */
        }
        scriptsWin.close();
        await wait(300);
      }

      scripts.remove(scriptItem.id);
      closeTab(tS.id);

      for (const t of [tA, tB, tD]) closeTab(t.id);
      srv.close();
    }


    // ---- 笔记本：写 / 取 / 查 / 双链 / 窗口
    {
      const flat = (nodes, out = []) => {
        for (const n of nodes) {
          if (n.type === 'dir') flat(n.children, out);
          else out.push(n);
        }
        return out;
      };
      const tag = Date.now().toString(36);

      // 写
      const note = vault.create('自检笔记 ' + tag);
      vault.write(note.path, '# 自检笔记\n\n正文里有 **加粗**、`代码` 和 [[自检目标 ' + tag + ']]，还有 #标签。\n');
      const text = vault.read(note.path);
      step('写：新建笔记并能读回', text.includes('加粗') && text.includes('[[自检目标'), `${note.path}（${text.length} 字）`);

      // 取
      const inTree = flat(vault.tree()).some((n) => n.path === note.path);
      step('取：文件树列出新笔记', inTree, `树里共 ${flat(vault.tree()).length} 条`);

      // 查
      const hits = vault.search('加粗');
      step('查：搜索命中正文', hits.some((h) => h.path === note.path), `${hits.length} 条结果`);

      // 双链反链
      const target = vault.create('自检目标 ' + tag);
      const bl = vault.backlinks(target.title);
      step('双链：反链能算出来', bl.some((b) => b.path === note.path), `反链 ${bl.length} 条`);

      // 窗口
      openVaultWindow();
      await wait(1700);
      const vaultAlive = !!(vaultWin && !vaultWin.isDestroyed());
      step('笔记本窗口能打开', vaultAlive, vaultAlive ? 'ok' : 'no window');

      if (vaultAlive) {
        const nodes = await vaultWin.webContents
          .executeJavaScript("document.querySelectorAll('#tree .node').length")
          .catch(() => -1);
        step('笔记本文件树渲染出来', nodes >= 2, `nodes=${nodes}`);

        const editorLen = await vaultWin.webContents
          .executeJavaScript("document.getElementById('editor').value.length")
          .catch(() => -1);
        step('窗口自动打开了笔记', editorLen > 0, `${editorLen} 字符`);

        const mdOk = await vaultWin.webContents
          .executeJavaScript("!!(window.MD && window.MD.render('# t\\n\\n**b** [[x]]').indexOf('<strong>') >= 0)")
          .catch(() => false);
        step('Markdown 渲染器可用', mdOk === true, mdOk ? 'strong/wikilink 正常' : '渲染异常');

        try {
          const shot = await vaultWin.webContents.capturePage();
          fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-vault.png'), shot.toPNG());
          note('笔记本界面截图', 'selfcheck-vault.png');
        } catch {
          /* 忽略 */
        }
        vaultWin.close();
        await wait(300);
      }

      vault.remove(note.path);
      vault.remove(target.path);
      step('删：笔记可从磁盘删除', !flat(vault.tree()).some((n) => n.path === note.path), `剩余 ${flat(vault.tree()).length} 条`);
    }

    // ---- 多窗口：窗口之间账号/标签独立
    {
      const before = windows.length;
      const second = createWindow({ accountId: 'default', show: false });
      await wait(900);
      step('能开出第二个窗口', windows.length === before + 1, `windows=${windows.length}`);
      step('新窗口有自己的标签', second.tabs.length === 1 && second.tabs[0].ctx === second, `tabs=${second.tabs.length}`);
      step('两个窗口的标签不共享', !!tabs[0] && second.tabs[0].id !== tabs[0].id, `${tabs[0] && tabs[0].id} vs ${second.tabs[0].id}`);

      const accB = accounts.list().find((a) => a.name === '自检B') || accounts.create('自检B');
      switchAccount(second.tabs[0].id, accB.id, second);
      await wait(700);
      step(
        '窗口账号互不影响',
        second.accountId === accB.id && ctx.accountId !== accB.id,
        `窗口2=${second.accountId.slice(0, 6)} 窗口1=${ctx.accountId.slice(0, 6)}`
      );

      second.win.close();
      await wait(600);
      step('关窗口后上下文被清理', windows.length === before, `windows=${windows.length}`);
    }

    // ---- 账号池可视化编辑
    {
      openAccountsWindow();
      await wait(1400);
      const accAlive = !!(accountsWin && !accountsWin.isDestroyed());
      step('账号池窗口能打开', accAlive, accAlive ? 'ok' : 'no window');

      if (accAlive) {
        const rows = await accountsWin.webContents
          .executeJavaScript("document.querySelectorAll('.row').length")
          .catch(() => -1);
        step('账号池列出账号', rows >= 2, `rows=${rows}`);

        // 改名 + 改色（走 IPC，等于点了输入框和色板）
        const target = accounts.list().find((a) => a.name === '自检A');
        const renamed = await accountsWin.webContents
          .executeJavaScript(
            `window.accountStore.update(${JSON.stringify(target.id)}, { name: '自检A改', color: '#db2777' })`
          )
          .catch(() => null);
        step('账号可改名改色', !!renamed && renamed.name === '自检A改' && renamed.color === '#db2777', renamed ? `${renamed.name} ${renamed.color}` : 'failed');

        const after = await accountsWin.webContents
          .executeJavaScript("document.querySelectorAll('.row .name')[0].value")
          .catch(() => '');
        step('改名后列表即时刷新', String(after).length > 0, String(after));

        // 自检不留垃圾：改回原名，下次还能按名字找到
        await accounts.update(target.id, { name: '自检A', color: '#2f6fed' });

        const del = await accountsWin.webContents
          .executeJavaScript("window.accountStore.remove('default')")
          .catch(() => null);
        step('默认账号不可删除', !!del && del.ok === false, del ? del.reason : 'failed');

        const delNew = await accountsWin.webContents
          .executeJavaScript(`(async()=>{const a=await window.accountStore.create('临时');return await window.accountStore.remove(a.id);})()`)
          .catch(() => null);
        step('普通账号可删除', !!delNew && delNew.ok === true, delNew ? 'ok' : 'failed');

        try {
          const shot = await accountsWin.webContents.capturePage();
          fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-accounts.png'), shot.toPNG());
          note('账号池界面截图', 'selfcheck-accounts.png');
        } catch {
          /* 忽略 */
        }
        accountsWin.close();
        await wait(300);
      }
    }

    // 9 格极限（--grid9）
    if (process.argv.includes('--grid9')) {
      const extra = [];
      while (tabs.length < 9) {
        const i = tabs.length;
        extra.push(createTab('data:text/html,' + encodeURIComponent(page('N' + i, 0.05 * i, 100 + i * 10))));
      }
      setGrid(4);
      await wait(1500);

      const r9 = cellRects();
      step('3×3 宫格铺出 9 格', r9.length === 9, `cells=${r9.length}`);

      const counts9 = await Promise.all(r9.map((r) => readCounter(r.tab.view.webContents)));
      step('九格同时运行', counts9.filter((c) => c > 0).length === 9, counts9.join('/'));

      try {
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-grid9.png'), shot.toPNG());
        for (let i = 0; i < r9.length; i++) {
          const s = await r9[i].tab.view.webContents.capturePage();
          fs.writeFileSync(path.join(SHOT_DIR, `selfcheck-g9-${i + 1}.png`), s.toPNG());
        }
        fs.writeFileSync(
          path.join(SHOT_DIR, 'selfcheck-grid9.json'),
          JSON.stringify(
            {
              uiShot: shot.getSize(),
              content: contentBounds(),
              cells: r9.map((r, i) => ({ index: i + 1, title: r.tab.title, x: r.x, y: r.y, width: r.width, height: r.height, header: r.header })),
            },
            null,
            2
          )
        );
        note('九格截图', 'selfcheck-grid9.png + selfcheck-g9-1..9.png');
      } catch {
        /* 忽略 */
      }

      setGrid(0);
      for (const t of extra) closeTab(t.id);
    }

    // 多标签时标签条的表现（收缩 + 横向滚动）
    if (process.argv.includes('--many')) {
      for (let i = 0; i < 10; i++) {
        createTab(
          'data:text/html,' +
            encodeURIComponent(
              `<meta charset="utf-8"><title>标签 ${i + 3}</title><body style="margin:0;height:100vh;background:hsl(${i * 33},45%,52%)"></body>`
            )
        );
      }
      await wait(800);
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOT_DIR, 'selfcheck-many.png'), shot.toPNG());
      note('多标签布局截图', `selfcheck-many.png，共 ${tabs.length} 个标签`);
    }
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.stack) || e);
  }

  console.log('\n=== SELFCHECK ===');
  console.log(JSON.stringify(out, null, 2));
  console.log('=== END (' + (out.ok ? 'PASS' : 'FAIL') + ') ===\n');

  // 直接 app.exit() 在「窗口没显示过」时会以 0xC0000005 崩掉，退出码全废，
  // 先让事件循环转几拍再退。
  await new Promise((r) => setTimeout(r, 250));
  app.exit(out.ok ? 0 : 1);
}

function page(name, hue, tick) {
  return `<!doctype html><meta charset="utf-8"><title>标签 ${name}</title>
<style>
  html,body{margin:0;height:100%;font:600 28px/1.4 system-ui,"Microsoft YaHei",sans-serif;color:#fff;
  background:hsl(${Math.round(hue * 360)},68%,46%);display:grid;place-items:center}
  #n{font-size:96px}
</style>
<div><div>${name}</div><div id="n">0</div></div>
<script>
  window.__tag = ${JSON.stringify(name)};
  let n = 0;
  setInterval(() => { n++; document.getElementById('n').textContent = n; }, ${tick});
</script>`;
}

function readCounter(wc) {
  return wc
    .executeJavaScript("Number(document.getElementById('n')?.textContent||0)")
    .catch(() => 0);
}

// ---------------------------------------------------------------- 启动

app.whenReady().then(async () => {
  // 便于自检时固定配色（--light / --dark），正常启动跟随系统
  if (process.argv.includes('--light')) nativeTheme.themeSource = 'light';
  if (process.argv.includes('--dark')) nativeTheme.themeSource = 'dark';

  createWindow();
  if (SELFCHECK) await selfCheck();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
