'use strict';

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const nameEl = $('name');
const matchesEl = $('matches');
const codeEl = $('code');
const enabledEl = $('enabled');
const hintEl = $('hint');

let items = [];
let currentId = null; // null = 新建中

async function refresh() {
  items = await window.scriptStore.list();
  renderList();
}

function renderList() {
  listEl.replaceChildren();
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '还没有脚本';
    listEl.append(d);
    return;
  }
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'item' + (it.id === currentId ? ' active' : '') + (it.enabled ? '' : ' off');
    el.dataset.id = it.id;

    const dot = document.createElement('span');
    dot.className = 'dot';

    const box = document.createElement('div');
    box.style.cssText = 'flex:1;min-width:0';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = it.name;
    const pat = document.createElement('div');
    pat.className = 'pat';
    pat.textContent = (it.matches || []).join('  ') || '(未设置匹配)';
    box.append(name, pat);

    el.append(dot, box);
    el.addEventListener('click', () => select(it.id));
    el.addEventListener('dblclick', async () => {
      await window.scriptStore.toggle(it.id, !it.enabled);
      await refresh();
    });
    listEl.append(el);
  }
}

function select(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  currentId = id;
  nameEl.value = it.name;
  matchesEl.value = (it.matches || []).join('\n');
  codeEl.value = it.code || '';
  enabledEl.checked = !!it.enabled;
  hintEl.textContent = `匹配：${(it.matches || []).join(', ')}`;
  renderList();
}

function clearForm() {
  currentId = null;
  nameEl.value = '';
  matchesEl.value = '*://*/*';
  codeEl.value = '';
  enabledEl.checked = true;
  hintEl.textContent = '新建中';
  renderList();
  nameEl.focus();
}

$('new').addEventListener('click', clearForm);

$('save').addEventListener('click', async () => {
  const item = {
    id: currentId || undefined,
    name: nameEl.value.trim() || '未命名脚本',
    matches: matchesEl.value.split('\n').map((s) => s.trim()).filter(Boolean),
    code: codeEl.value,
    enabled: enabledEl.checked,
  };
  if (!item.matches.length) item.matches = ['*://*/*'];
  const saved = await window.scriptStore.save(item);
  currentId = saved.id;
  await refresh();
  hintEl.textContent = `已保存：${saved.name}`;
});

$('delete').addEventListener('click', async () => {
  if (!currentId) return;
  const it = items.find((x) => x.id === currentId);
  if (!it) return;
  if (!confirm(`删除脚本「${it.name}」？`)) return;
  await window.scriptStore.remove(currentId);
  clearForm();
  await refresh();
});

$('refresh').addEventListener('click', async () => {
  hintEl.textContent = '正在重载已打开的页面…';
  await window.scriptStore.reloadPages();
  hintEl.textContent = '已重载，脚本会重新注入';
});

(async function init() {
  await refresh();
  if (items.length) select(items[0].id);
  else clearForm();
})();
