'use strict';
/**
 * 笔记本 = 一个 Obsidian 风格的 vault：
 *   - vault 就是一个普通文件夹，笔记就是 .md 纯文本，别的编辑器也能直接打开；
 *   - `[[笔记名]]` 双向链接，反链靠扫描全库算出来；
 *   - 网页摘录写进 摘录/ 子目录，带 frontmatter。
 */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let cfg = null;

function configFile() {
  return path.join(app.getPath('userData'), 'vault.json');
}

function saveCfg() {
  try {
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
  } catch {
    /* 忽略 */
  }
}

function config() {
  if (cfg) return cfg;
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    if (raw && raw.root) {
      cfg = raw;
      return cfg;
    }
  } catch {
    /* 首次运行 */
  }
  cfg = { root: path.join(app.getPath('userData'), 'vault') };
  fs.mkdirSync(cfg.root, { recursive: true });
  saveCfg();
  return cfg;
}

function root() {
  const r = config().root;
  try {
    fs.mkdirSync(r, { recursive: true });
  } catch {
    /* 忽略 */
  }
  return r;
}

function setRoot(dir) {
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  cfg = { ...config(), root: dir };
  saveCfg();
  return true;
}

/** 只允许 vault 内部的相对路径 */
function abs(rel) {
  const base = path.resolve(root());
  const p = path.resolve(base, String(rel || ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('路径越界：' + rel);
  return p;
}

function safeName(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || '未命名'
  );
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- 文件树

function tree(dir = null, rel = '') {
  const realDir = dir || root();
  let entries = [];
  try {
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;

    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: relPath, children: tree(path.join(realDir, e.name), relPath) });
    } else if (/\.md$/i.test(e.name)) {
      out.push({ type: 'file', name: e.name, path: relPath, title: e.name.replace(/\.md$/i, '') });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 读写

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8');
}

function write(rel, content) {
  const p = abs(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(content), 'utf8');
  return { path: rel, mtime: fs.statSync(p).mtimeMs };
}

function uniqueRel(dirRel, baseName, ext = '.md') {
  let rel = (dirRel ? dirRel + '/' : '') + baseName + ext;
  let i = 2;
  while (fs.existsSync(abs(rel))) {
    rel = (dirRel ? dirRel + '/' : '') + `${baseName} ${i}` + ext;
    i++;
  }
  return rel;
}

function create(name, content = '', dirRel = '') {
  const rel = uniqueRel(dirRel, safeName(name));
  write(rel, content);
  return { path: rel, title: path.basename(rel, '.md') };
}

function remove(rel) {
  const p = abs(rel);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function rename(rel, nextName) {
  const p = abs(rel);
  if (!fs.existsSync(p)) return null;
  const dir = path.dirname(p);
  const nextAbs = path.join(dir, safeName(nextName) + '.md');
  if (nextAbs === p) return { path: rel };
  if (fs.existsSync(nextAbs)) throw new Error('同名笔记已存在');
  fs.renameSync(p, nextAbs);
  const relDir = path.dirname(rel);
  return { path: (relDir === '.' ? '' : relDir + '/') + path.basename(nextAbs) };
}

// ---------------------------------------------------------------- 双链

const WIKI_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function linksIn(content) {
  const out = new Set();
  let m;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(content))) out.add(m[1].trim());
  return [...out];
}

/** 全库扫描，找出「谁链接了我」 */
function backlinks(title) {
  const target = String(title || '').trim();
  if (!target) return [];
  const out = [];
  const walk = (nodes, prefix = '') => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        walk(n.children, n.path);
        continue;
      }
      if (n.title === target) continue;
      let text = '';
      try {
        text = read(n.path);
      } catch {
        continue;
      }
      if (!text.includes('[[')) continue;
      if (linksIn(text).includes(target)) out.push({ path: n.path, title: n.title });
    }
  };
  walk(tree());
  return out;
}

/** 所有 [[X]] 指向但库里没有的笔记 —— 点一下就能建 */
function missingLinks() {
  const titles = new Set();
  const referenced = new Set();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        walk(n.children);
        continue;
      }
      titles.add(n.title);
      let text = '';
      try {
        text = read(n.path);
      } catch {
        continue;
      }
      for (const l of linksIn(text)) referenced.add(l);
    }
  };
  walk(tree());
  return [...referenced].filter((t) => !titles.has(t)).sort();
}

// ---------------------------------------------------------------- 搜索

function search(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'dir') {
        walk(n.children);
        continue;
      }
      let text = '';
      try {
        text = read(n.path);
      } catch {
        continue;
      }
      const inTitle = n.title.toLowerCase().includes(needle);
      const idx = text.toLowerCase().indexOf(needle);
      if (inTitle || idx >= 0) {
        const from = Math.max(0, idx - 40);
        out.push({
          path: n.path,
          title: n.title,
          snippet: idx >= 0 ? text.slice(from, from + 120).replace(/\s+/g, ' ') : text.slice(0, 120).replace(/\s+/g, ' '),
        });
      }
      if (out.length >= 80) return;
    }
  };
  walk(tree());
  return out;
}

// ---------------------------------------------------------------- 摘录

/** 从网页建一条笔记：写进 收件箱/，带 frontmatter 和来源；有选中文字就带引用块 */
function addNote({ url, title, text }) {
  const d = new Date();
  const base = safeName(title || '网页笔记');
  const rel = uniqueRel('收件箱', `${base} ${stamp(d)}`);
  const body = String(text || '').trim();
  const quote = body
    ? body
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n')
    : '';

  const content = [
    '---',
    `title: ${base}`,
    `source: ${url || ''}`,
    `created: ${d.toISOString()}`,
    '---',
    '',
    `# ${base}`,
    '',
    quote,
    body ? '' : '',
    url ? `来源：<${url}>` : '',
    '',
  ]
    .filter((l, idx, arr) => !(l === '' && arr[idx - 1] === ''))
    .join('\n');

  write(rel, content);
  return { path: rel, title: base };
}

module.exports = {
  root,
  setRoot,
  tree,
  read,
  write,
  create,
  remove,
  rename,
  backlinks,
  missingLinks,
  linksIn,
  search,
  addNote,
  safeName,
};
