'use strict';

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const hintEl = $('hint');

const COLORS = ['#2f6fed', '#e0574b', '#2fa36b', '#c47f17', '#8b5cf6', '#0ea5e9', '#db2777', '#65a30d', '#8a9099'];

let items = [];

async function refresh() {
  items = await window.accountStore.list();
  render();
  hintEl.textContent = `${items.length} 个账号`;
}

function render() {
  listEl.replaceChildren();

  for (const a of items) {
    const row = document.createElement('div');
    row.className = 'row';

    // 色点：点一下展开色板
    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.style.background = a.color;
    dot.title = '点击换颜色';
    dot.addEventListener('click', () => openPalette(row, a));
    row.append(dot);

    // 名字：直接改，失焦/回车保存
    const name = document.createElement('input');
    name.className = 'name';
    name.value = a.name;
    name.spellcheck = false;
    name.maxLength = 30;
    const commit = async () => {
      const v = name.value.trim();
      if (!v || v === a.name) {
        name.value = a.name;
        return;
      }
      await window.accountStore.update(a.id, { name: v });
      a.name = v;
      hintEl.textContent = `已改名：${v}`;
    };
    name.addEventListener('blur', commit);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      if (e.key === 'Escape') {
        name.value = a.name;
        name.blur();
      }
    });
    row.append(name);

    const usage = document.createElement('span');
    usage.className = 'usage';
    usage.textContent = a.tabs ? `${a.tabs} 个标签` : '未使用';
    row.append(usage);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = a.id === 'default' ? '内置' : '删除';
    del.disabled = a.id === 'default';
    if (a.id === 'default') del.title = '默认账号不能删除';
    del.addEventListener('click', async () => {
      if (a.tabs > 0) {
        const ok = confirm(`「${a.name}」还有 ${a.tabs} 个标签在用。\n删除后这些标签会退回默认账号并重新加载，确定？`);
        if (!ok) return;
      } else if (!confirm(`删除「${a.name}」？它的 cookie 和存储会一起清掉。`)) {
        return;
      }
      const r = await window.accountStore.remove(a.id);
      if (!r || !r.ok) alert((r && r.reason) || '删除失败');
      await refresh();
    });
    row.append(del);

    listEl.append(row);
  }

  if (!items.length) {
    const d = document.createElement('div');
    d.style.cssText = 'color:var(--fg-dim);text-align:center;padding:24px';
    d.textContent = '还没有账号';
    listEl.append(d);
  }
}

function openPalette(row, acc) {
  const old = document.querySelector('.palette');
  if (old) {
    old.remove();
    return;
  }
  const box = document.createElement('div');
  box.className = 'palette';
  box.style.cssText =
    'display:flex;gap:6px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel);margin:-4px 0 8px;flex-wrap:wrap';

  for (const c of COLORS) {
    const b = document.createElement('span');
    b.style.cssText = `width:20px;height:20px;border-radius:50%;cursor:pointer;background:${c};border:2px solid ${
      c === acc.color ? 'var(--fg)' : 'transparent'
    }`;
    b.addEventListener('click', async () => {
      await window.accountStore.update(acc.id, { color: c });
      box.remove();
      await refresh();
    });
    box.append(b);
  }
  row.after(box);
}

$('new').addEventListener('click', async () => {
  const a = await window.accountStore.create();
  await refresh();
  hintEl.textContent = `已新建：${a.name}（名字可以直接改）`;
});

refresh();
