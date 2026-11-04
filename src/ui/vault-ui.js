'use strict';

const $ = (id) => document.getElementById(id);
const treeEl = $('tree');
const qEl = $('q');
const editor = $('editor');
const preview = $('preview');
const backsEl = $('backs');
const titleEl = $('title');
const statusEl = $('status');

let currentRel = null;
let currentTitle = '';
let treeData = [];
let titles = new Set();
let dirty = false;
let saveTimer = null;
let renderTimer = null;

// ---------------------------------------------------------------- 状态

function setStatus(text, tone) {
  statusEl.textContent = text || '';
  statusEl.style.color = tone === 'dirty' ? 'var(--fg-dim)' : tone === 'error' ? 'var(--danger)' : 'var(--fg-dim)';
}

function markDirty(isDirty) {
  dirty = isDirty;
  setStatus(isDirty ? '未保存' : '已保存', isDirty ? 'dirty' : '');
}

// ---------------------------------------------------------------- 文件树

function collectTitles(nodes, acc = new Set()) {
  for (const n of nodes) {
    if (n.type === 'dir') collectTitles(n.children, acc);
    else acc.add(n.title);
  }
  return acc;
}

async function reloadTree() {
  treeData = await window.vault.tree();
  titles = collectTitles(treeData);
  if (!qEl.value.trim()) renderTree();
}

function buildNodes(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.type === 'dir') {
      const el = document.createElement('div');
      el.className = 'node';
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = '▾';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = n.name;
      el.append(ico, label);

      const kids = document.createElement('div');
      kids.className = 'children';
      kids.append(buildNodes(n.children));

      el.addEventListener('click', () => {
        kids.hidden = !kids.hidden;
        ico.textContent = kids.hidden ? '▸' : '▾';
      });

      frag.append(el, kids);
      continue;
    }

    const el = document.createElement('div');
    el.className = 'node' + (n.path === currentRel ? ' active' : '');
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = '·';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = n.title;
    el.append(ico, label);
    el.title = n.path;

    el.addEventListener('click', () => open(n.path));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(n, e);
    });
    frag.append(el);
  }
  return frag;
}

function renderTree() {
  treeEl.replaceChildren();
  if (!treeData.length) {
    const d = document.createElement('div');
    d.className = 'empty-tip';
    d.innerHTML = '这个文件夹里还没有笔记。<br>点右上角「新建笔记」开始写。';
    treeEl.append(d);
    return;
  }
  treeEl.append(buildNodes(treeData));
}

// ---------------------------------------------------------------- 输入框
// Electron 不支持 window.prompt，所以自己做一个

function ask(title, defaultValue = '') {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'ask-mask';

    const box = document.createElement('div');
    box.className = 'ask-box';

    const t = document.createElement('div');
    t.className = 'ask-title';
    t.textContent = title;

    const input = document.createElement('input');
    input.className = 'ask-input';
    input.value = defaultValue;
    input.spellcheck = false;

    const actions = document.createElement('div');
    actions.className = 'ask-actions';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '确定';
    actions.append(cancel, ok);

    box.append(t, input, actions);
    mask.append(box);
    document.body.append(mask);
    input.focus();
    input.select();

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      mask.remove();
      resolve(v);
    };

    ok.addEventListener('click', () => done(input.value.trim() || null));
    cancel.addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      else if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) done(null);
    });
  });
}

// ---------------------------------------------------------------- 右键菜单

function closeMenu() {
  const old = document.querySelector('.ctx');
  if (old) old.remove();
}

function showContextMenu(node, ev) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctx';
  m.style.left = ev.clientX + 'px';
  m.style.top = ev.clientY + 'px';

  const mk = (label, fn, danger) => {
    const d = document.createElement('div');
    d.textContent = label;
    if (danger) d.style.color = 'var(--danger)';
    d.addEventListener('click', () => {
      closeMenu();
      fn();
    });
    m.append(d);
  };

  mk('重命名…', async () => {
    const next = await ask('新的笔记名', node.title);
    if (!next || next === node.title) return;
    try {
      const r = await window.vault.rename(node.path, next);
      await reloadTree();
      if (currentRel === node.path && r) open(r.path);
      else renderTree();
    } catch (e) {
      alert(String(e.message || e));
    }
  });
  mk('在文件夹中显示', () => window.vault.reveal(node.path));
  mk('删除', async () => {
    if (!confirm(`删除「${node.title}」？文件会直接从磁盘删除。`)) return;
    await window.vault.remove(node.path);
    if (currentRel === node.path) {
      currentRel = null;
      currentTitle = '';
      editor.value = '';
      preview.innerHTML = '';
      backsEl.innerHTML = '';
      titleEl.textContent = '未打开笔记';
    }
    await reloadTree();
    renderTree();
  }, true);

  document.body.append(m);
  const rect = m.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) m.style.left = window.innerWidth - rect.width - 8 + 'px';
  if (rect.bottom > window.innerHeight - 8) m.style.top = window.innerHeight - rect.height - 8 + 'px';
}

document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// ---------------------------------------------------------------- 打开 / 保存

async function open(rel) {
  if (!rel) return;
  if (dirty) await save();
  const text = await window.vault.read(rel);
  currentRel = rel;
  currentTitle = rel.replace(/^.*\//, '').replace(/\.md$/i, '');
  editor.value = text;
  titleEl.textContent = currentTitle;
  markDirty(false);
  renderPreview();
  renderTree();
  renderBacklinks();
  editor.focus();
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
}

async function save() {
  if (!currentRel) return;
  clearTimeout(saveTimer);
  try {
    await window.vault.write(currentRel, editor.value);
    markDirty(false);
    await reloadTree();
  } catch (e) {
    setStatus('保存失败', 'error');
    console.error(e);
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 120);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 800);
}

function renderPreview() {
  preview.innerHTML = window.MD.render(editor.value);
  // 悬空双链（库里没有对应笔记）标灰
  for (const a of preview.querySelectorAll('a.wikilink')) {
    const target = a.dataset.target;
    if (!titles.has(target)) a.classList.add('missing');
  }
}

async function renderBacklinks() {
  backsEl.replaceChildren();
  if (!currentTitle) return;

  const list = await window.vault.backlinks(currentTitle);
  const out = document.createElement('div');
  const h = document.createElement('h4');
  h.textContent = `反向链接（${list.length}）`;
  out.append(h);
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'none';
    d.textContent = '还没有别的笔记链接到这里。用 [[笔记名]] 建立链接。';
    out.append(d);
  } else {
    for (const b of list) {
      const a = document.createElement('span');
      a.className = 'bl';
      a.textContent = `← ${b.title}`;
      a.addEventListener('click', () => open(b.path));
      out.append(a);
    }
  }
  backsEl.append(out);
}

// ---------------------------------------------------------------- 交互

editor.addEventListener('input', () => {
  markDirty(true);
  scheduleRender();
  scheduleSave();
});

editor.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
  // Tab 插入两个空格而不是跳焦点
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart;
    const t = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(t);
    editor.selectionStart = editor.selectionEnd = s + 2;
    markDirty(true);
    scheduleRender();
    scheduleSave();
  }
});

preview.addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  const target = a.dataset.target;
  for (const n of flattenTree(treeData)) {
    if (n.title === target) {
      open(n.path);
      return;
    }
  }
  // 没有就新建一篇
  createNote(target);
});

function flattenTree(nodes, out = []) {
  for (const n of nodes) {
    if (n.type === 'dir') flattenTree(n.children, out);
    else out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- 搜索

let searchTimer = null;

qEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = qEl.value.trim();
    if (!q) {
      renderTree();
      return;
    }
    const rows = await window.vault.search(q);
    treeEl.replaceChildren();
    if (!rows.length) {
      const d = document.createElement('div');
      d.className = 'empty-tip';
      d.textContent = '没有匹配的笔记';
      treeEl.append(d);
      return;
    }
    for (const r of rows) {
      const el = document.createElement('div');
      el.className = 'result';
      const b = document.createElement('b');
      b.textContent = r.title;
      const s = document.createElement('span');
      s.textContent = r.snippet;
      el.append(b, s);
      el.addEventListener('click', () => open(r.path));
      treeEl.append(el);
    }
  }, 180);
});

// ---------------------------------------------------------------- 新建

async function createNote(name) {
  const rel = name || (await ask('新笔记的名字'));
  if (!rel) return;
  const r = await window.vault.create(rel, '');
  await reloadTree();
  await open(r.path);
  qEl.value = '';
  renderTree();
}

$('newBtn').addEventListener('click', () => createNote());

$('folderBtn').addEventListener('click', async () => {
  if (dirty) await save();
  const root = await window.vault.chooseRoot();
  await reloadTree();
  qEl.value = '';
  renderTree();
  const first = flattenTree(treeData)[0];
  if (first) {
    await open(first.path);
  } else {
    currentRel = null;
    currentTitle = '';
    editor.value = '';
    preview.innerHTML = '';
    backsEl.replaceChildren();
    titleEl.textContent = '未打开笔记';
  }
  $('folderBtn').title = root;
});

for (const btn of document.querySelectorAll('.seg button')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b === btn);
    document.body.className = `mode-${btn.dataset.mode}`;
    if (btn.dataset.mode !== 'edit') renderPreview();
  });
}

window.addEventListener('beforeunload', () => {
  if (dirty) window.vault.write(currentRel, editor.value);
});

// ---------------------------------------------------------------- 启动

(async function init() {
  await reloadTree();
  renderTree();

  const root = await window.vault.root();
  $('folderBtn').title = root;
  const first = flattenTree(treeData)[0];
  if (first) {
    open(first.path);
  } else {
    titleEl.textContent = '未打开笔记';
    setStatus(root ? '' : '');
  }
})();
