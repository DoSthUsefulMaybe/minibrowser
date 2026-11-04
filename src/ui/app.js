'use strict';

const tabsEl = document.getElementById('tabs');
const addr = document.getElementById('address');
const reloadBtn = document.getElementById('reload');
const btnBack = document.querySelector('[data-act="back"]');
const btnForward = document.querySelector('[data-act="forward"]');
const cellsEl = document.getElementById('cells');
const gridBtn = document.getElementById('gridbtn');
const accountBtn = document.getElementById('accountbtn');

const ICON_CROSS =
  '<svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
const ICON_RELOAD = '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.6"/></svg>';

let state = { activeId: null, tabs: [] };
const els = new Map(); // tabId -> { root, slot, title, iconKey }
let addrTabId = null;

// ---------------------------------------------------------------- 标签渲染

function makeTab(tab) {
  const root = document.createElement('div');
  root.className = 'tab';
  root.dataset.id = String(tab.id);

  const slot = document.createElement('span');
  slot.className = 'tab-slot';

  const title = document.createElement('span');
  title.className = 'tab-title';

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.title = '关闭 (Ctrl+W)';
  close.innerHTML = ICON_CROSS;

  root.append(slot, title, close);

  root.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) {
      window.browser.closeTab(tab.id);
      return;
    }
    window.browser.activateTab(tab.id);
  });
  root.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      window.browser.closeTab(tab.id);
    }
  });

  const el = { root, slot, title, iconKey: null };
  els.set(tab.id, el);
  return el;
}

function renderIcon(el, tab) {
  const key = tab.loading ? 'loading' : tab.favicon || '';
  if (el.iconKey === key) return;
  el.iconKey = key;
  el.slot.textContent = '';
  if (tab.loading) {
    const s = document.createElement('span');
    s.className = 'tab-spinner';
    el.slot.append(s);
  } else if (tab.favicon) {
    const img = document.createElement('img');
    img.className = 'tab-icon';
    img.src = tab.favicon;
    img.addEventListener('error', () => {
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'tab-icon placeholder' }));
    });
    el.slot.append(img);
  } else {
    const d = document.createElement('span');
    d.className = 'tab-icon placeholder';
    el.slot.append(d);
  }
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function renderTabs() {
  const live = new Set(state.tabs.map((t) => t.id));
  for (const [id, el] of els) {
    if (!live.has(id)) {
      el.root.remove();
      els.delete(id);
    }
  }

  let prev = null;
  for (const t of state.tabs) {
    const el = els.get(t.id) || makeTab(t);
    el.root.classList.toggle('active', t.id === state.activeId);
    el.title.textContent = t.title || '新标签页';
    el.root.title = t.url || t.title || '';
    renderIcon(el, t);

    const want = prev ? prev.nextSibling : tabsEl.firstChild;
    if (want !== el.root) tabsEl.insertBefore(el.root, want);
    prev = el.root;
  }
}

// ---------------------------------------------------------------- 工具栏

function renderToolbar() {
  const t = activeTab();
  if (!t) {
    addr.value = '';
    addrTabId = null;
    btnBack.disabled = true;
    btnForward.disabled = true;
    return;
  }

  // 正在输入同一个标签的地址时不要覆盖用户输入
  const typing = document.activeElement === addr && addrTabId === String(t.id);
  if (!typing) {
    addr.value = t.url || '';
    addrTabId = String(t.id);
  }

  btnBack.disabled = !t.canGoBack;
  btnForward.disabled = !t.canGoForward;
  reloadBtn.innerHTML = t.loading ? ICON_STOP : ICON_RELOAD;
  reloadBtn.title = t.loading ? '停止 (Esc)' : '刷新 (Ctrl+R)';
  document.title = t.title || 'minibrowser';

  // 当前标签属于哪个账号
  accountBtn.querySelector('.acc-dot').style.background = t.accountColor || 'var(--fg-dim)';
  accountBtn.querySelector('.acc-name').textContent = t.accountName || '默认';
  accountBtn.title = `账号：${t.accountName || '默认'}（点击切换 / 新建）`;
}

function render() {
  renderTabs();
  renderToolbar();
  renderCells();
  renderGridButton();
}

// ---------------------------------------------------------------- 宫格

/** 按行列画一个小小的布局图标 */
function gridSvg(cols, rows) {
  const S = 12;
  const P = 1.7;
  const G = 1.1;
  const w = (S - P * 2 - G * (cols - 1)) / cols;
  const h = (S - P * 2 - G * (rows - 1)) / rows;
  let rects = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      rects += `<rect x="${(P + x * (w + G)).toFixed(2)}" y="${(P + y * (h + G)).toFixed(2)}" width="${w.toFixed(
        2
      )}" height="${h.toFixed(2)}" rx="0.9"/>`;
    }
  }
  return `<svg viewBox="0 0 12 12">${rects}</svg>`;
}

function renderGridButton() {
  const g = state.grid || { cols: 1, rows: 1, capacity: 1 };
  gridBtn.innerHTML = gridSvg(g.cols, g.rows);
  gridBtn.title = `宫格布局：${g.capacity} 格（Ctrl+Shift+G 切换）`;
}

let cellsSig = '';

function renderCells() {
  const cells = (state.cells || []).filter((c) => c.header > 0);
  const sig =
    cells.map((c) => `${c.id}:${c.x},${c.y},${c.width},${c.active ? 1 : 0}`).join('|') +
    '#' +
    state.tabs.map((t) => t.title).join('|');
  if (sig === cellsSig) return;
  cellsSig = sig;

  const frag = document.createDocumentFragment();
  for (const c of cells) {
    const tab = state.tabs.find((t) => t.id === c.id);
    const el = document.createElement('div');
    el.className = 'cell-head' + (c.active ? ' active' : '');
    el.style.left = c.x + 'px';
    el.style.top = c.y + 'px';
    el.style.width = c.width + 'px';
    el.style.height = c.header + 'px';

    const fav = document.createElement(tab && tab.favicon ? 'img' : 'span');
    fav.className = 'cell-fav' + (tab && tab.favicon ? '' : ' placeholder');
    if (tab && tab.favicon) fav.src = tab.favicon;

    // 非默认账号：在标题前点一个账号色点，宫格里一眼看出哪个号
    if (tab && tab.accountId && tab.accountId !== 'default') {
      const dot = document.createElement('span');
      dot.className = 'cell-acc';
      dot.style.background = tab.accountColor;
      dot.title = tab.accountName || '';
      el.append(dot);
    }

    const title = document.createElement('span');
    title.className = 'cell-title';
    title.textContent = tab ? tab.title : '';

    el.append(fav, title);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      window.browser.activateTab(c.id);
    });
    frag.append(el);
  }
  cellsEl.replaceChildren(frag);
}

// ---------------------------------------------------------------- 交互

document.getElementById('newtab').addEventListener('click', () => window.browser.createTab());

for (const btn of [btnBack, btnForward]) {
  btn.addEventListener('click', () => window.browser.action(btn.dataset.act));
}

reloadBtn.addEventListener('click', () => {
  const t = activeTab();
  window.browser.action(t && t.loading ? 'stop' : 'reload');
});

gridBtn.addEventListener('click', () => window.browser.cycleGrid());
accountBtn.addEventListener('click', () => window.browser.showAccountMenu());
document.getElementById('toolsbtn').addEventListener('click', () => window.browser.showToolsMenu());

addr.addEventListener('focus', () => addr.select());

addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = addr.value;
    addr.blur();
    window.browser.go(v);
  } else if (e.key === 'Escape') {
    const t = activeTab();
    addr.value = t ? t.url || '' : '';
    addr.blur();
  }
});

window.browser.onState((s) => {
  state = s;
  render();
});

window.browser.onFocusAddress(() => {
  addr.focus();
  addr.select();
});

window.browser.snapshot().then((s) => {
  state = s;
  render();
});
