'use strict';
/**
 * 脚本仓库：用户脚本（userscript）的存储与注入。
 *
 * 脚本就是一段 JS，按 matches（glob）匹配 URL，页面加载完成后注入。
 * 与 Tampermonkey 的差别：不做沙箱 API，直接跑在页面上下文里，够用就行。
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let state = null;

function file() {
  return path.join(app.getPath('userData'), 'scripts.json');
}

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      state = raw;
      return state;
    }
  } catch {
    /* 首次运行 */
  }
  state = { items: [] };
  return state;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(state, null, 2));
  } catch {
    /* 忽略 */
  }
}

function list() {
  return load().items;
}

function newId() {
  return 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function upsert(item) {
  const s = load();
  const clean = {
    id: item.id || newId(),
    name: String(item.name || '未命名脚本').slice(0, 60),
    enabled: item.enabled !== false,
    matches: Array.isArray(item.matches)
      ? item.matches.map((m) => String(m).trim()).filter(Boolean)
      : String(item.matches || '*://*/*')
          .split('\n')
          .map((m) => m.trim())
          .filter(Boolean),
    code: String(item.code || ''),
  };
  const i = s.items.findIndex((x) => x.id === clean.id);
  if (i >= 0) s.items[i] = clean;
  else s.items.push(clean);
  save();
  return clean;
}

function remove(id) {
  const s = load();
  const i = s.items.findIndex((x) => x.id === id);
  if (i >= 0) {
    s.items.splice(i, 1);
    save();
    return true;
  }
  return false;
}

function toggle(id, enabled) {
  const s = load();
  const item = s.items.find((x) => x.id === id);
  if (!item) return null;
  item.enabled = !!enabled;
  save();
  return item;
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** glob 匹配：* 通配任意字符，例如 *://*.example.com/* */
function matches(pattern, url) {
  if (!pattern || !url) return false;
  try {
    const re = new RegExp('^' + String(pattern).split('*').map(escapeRe).join('.*') + '$', 'i');
    return re.test(url);
  } catch {
    return false;
  }
}

/** 某个 URL 上应该跑哪些脚本 */
function forUrl(url) {
  return list().filter((s) => s.enabled && (s.matches || []).some((p) => matches(p, url)));
}

module.exports = { list, upsert, remove, toggle, forUrl, matches };
