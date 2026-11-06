'use strict';
/**
 * 账号池：每个账号 = 一个独立的 Electron session（partition）。
 *
 * 持久化：
 *   - 账号列表写在 userData/accounts.json，跨启动保留；
 *   - 写入先写临时文件再 rename，避免半截文件；
 *   - 监听文件变化，别的窗口/进程改了会自动重载并通知 UI；
 *   - 每个窗口的「当前账号」只存在自己的 ctx 里，互不影响。
 */
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const COLORS = ['#2f6fed', '#e0574b', '#2fa36b', '#c47f17', '#8b5cf6', '#0ea5e9', '#db2777', '#65a30d'];
const DEFAULT_ACCOUNT = { id: 'default', name: '默认', color: '#8a9099', partition: '' };
const VERSION = 1;

let state = null;
let lastSig = '';
let lastSaveError = '';
let watcher = null;
let watchTimer = null;
const listeners = new Set();

function file() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function signature() {
  try {
    const st = fs.statSync(file());
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function cleanName(value, fallback) {
  const s = String(value == null ? '' : value).trim().slice(0, 30);
  return s || fallback;
}

function cleanColor(value, fallback) {
  const s = String(value == null ? '' : value);
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : fallback;
}

function normalize(raw) {
  const src = raw && Array.isArray(raw.accounts) ? raw.accounts : [];
  const savedDefault = src.find((a) => a && a.id === 'default') || {};
  const accounts = [
    {
      ...DEFAULT_ACCOUNT,
      name: cleanName(savedDefault.name, DEFAULT_ACCOUNT.name),
      color: cleanColor(savedDefault.color, DEFAULT_ACCOUNT.color),
      partition: '',
    },
  ];
  const seen = new Set(['default']);
  const partitions = new Set(['']);

  for (const a of src) {
    if (!a || typeof a !== 'object') continue;
    const id = String(a.id || '').trim();
    if (!id || id === 'default' || seen.has(id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) continue;

    let partition =
      typeof a.partition === 'string' && a.partition.startsWith('persist:')
        ? a.partition
        : 'persist:mb-' + id;
    if (partitions.has(partition)) partition = `persist:mb-${id}-${Math.random().toString(36).slice(2, 6)}`;

    accounts.push({
      id,
      name: cleanName(a.name, `账号 ${accounts.length}`),
      color: cleanColor(a.color, COLORS[(accounts.length - 1) % COLORS.length]),
      partition,
    });
    seen.add(id);
    partitions.add(partition);
  }

  return {
    version: VERSION,
    revision: Number(raw && raw.revision) || 0,
    updatedAt: (raw && raw.updatedAt) || new Date().toISOString(),
    accounts,
  };
}

function readDisk() {
  try {
    return normalize(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return null;
  }
}

function emit(reason) {
  if (!state) return;
  const snapshot = state.accounts.map((a) => ({ id: a.id, name: a.name, color: a.color }));
  for (const fn of [...listeners]) {
    try {
      fn({ reason, accounts: snapshot });
    } catch {
      /* 单个监听器失败不影响其它窗口 */
    }
  }
}

function ensureWatcher() {
  if (watcher) return;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    watcher = fs.watch(path.dirname(file()), (_event, filename) => {
      const name = filename ? String(filename) : '';
      if (name && name !== 'accounts.json') return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        const next = readDisk();
        if (!next) return;
        const before = state ? JSON.stringify(state.accounts) : '';
        const after = JSON.stringify(next.accounts);
        state = next;
        lastSig = signature();
        if (before && before !== after) emit('external');
      }, 120);
    });
    watcher.on('error', () => {
      /* 文件被删/无权限时静默，下次 load 会再尝试 */
    });
  } catch {
    /* fs.watch 不可用就退回按 mtime 检查 */
  }
}

function load() {
  ensureWatcher();
  const sig = signature();

  if (!state) {
    const disk = sig ? readDisk() : null;
    state = disk || normalize(null);
    lastSig = sig;
    if (!sig) save();
    return state;
  }

  if (sig && sig !== lastSig) {
    const next = readDisk();
    if (next) {
      const before = JSON.stringify(state.accounts);
      state = next;
      lastSig = sig;
      if (before !== JSON.stringify(state.accounts)) emit('external');
    }
  }
  return state;
}

function save() {
  if (!state) load();
  const next = {
    ...state,
    version: VERSION,
    revision: (Number(state.revision) || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  state = next;

  const tmp = `${file()}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    try {
      fs.renameSync(tmp, file());
    } catch {
      // Windows 上目标文件被占用时 rename 可能失败，退回覆盖写
      fs.copyFileSync(tmp, file());
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件清理失败不影响主流程 */
      }
    }
    lastSig = signature();
    lastSaveError = '';
    emit('local');
    return true;
  } catch (e) {
    lastSaveError = String((e && e.message) || e);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
    console.error('[accounts] 保存失败：', lastSaveError);
    return false;
  }
}

function list() {
  return load().accounts;
}

function get(id) {
  const all = list();
  return all.find((a) => a.id === id) || all[0];
}

function exists(id) {
  return list().some((a) => a.id === id);
}

function create(name) {
  const s = load();
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const acc = {
    id: 'acc-' + stamp,
    name: cleanName(name, `账号 ${s.accounts.length}`),
    color: COLORS[(s.accounts.length - 1) % COLORS.length],
    partition: 'persist:mb-' + stamp,
  };
  s.accounts.push(acc);
  save();
  return acc;
}

function rename(id, name) {
  const acc = list().find((a) => a.id === id);
  if (!acc || !name) return null;
  acc.name = cleanName(name, acc.name);
  save();
  return acc;
}

/** 改名 / 改色 */
function update(id, patch = {}) {
  const acc = list().find((a) => a.id === id);
  if (!acc) return null;
  if (patch.name !== undefined) acc.name = cleanName(patch.name, acc.name);
  if (patch.color !== undefined) acc.color = cleanColor(patch.color, acc.color);
  save();
  return acc;
}

/** 删除账号（默认账号不能删）；它的会话分区也一起清掉 */
function remove(id) {
  const s = load();
  if (id === DEFAULT_ACCOUNT.id) return { ok: false, reason: '默认账号不能删除' };
  const i = s.accounts.findIndex((a) => a.id === id);
  if (i < 0) return { ok: false, reason: '账号不存在' };
  const [acc] = s.accounts.splice(i, 1);
  if (!save()) {
    s.accounts.splice(i, 0, acc);
    return { ok: false, reason: `账号文件写入失败：${lastSaveError || '未知错误'}` };
  }
  if (acc.partition) {
    try {
      session.fromPartition(acc.partition).clearStorageData();
    } catch {
      /* 分区已不存在 */
    }
  }
  return { ok: true, account: acc };
}

/** 账号 → Electron Session（第一次取会创建持久化分区） */
function sessionOf(acc) {
  return acc.partition ? session.fromPartition(acc.partition) : session.defaultSession;
}

/** 给 UI 用的精简结构（不带 partition） */
function publicList() {
  return list().map((a) => ({ id: a.id, name: a.name, color: a.color }));
}

/** 账号池/文件变化时通知；返回取消订阅函数 */
function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 显式重新读盘（测试/诊断用） */
function reload() {
  const next = readDisk();
  if (!next) return false;
  const before = state ? JSON.stringify(state.accounts) : '';
  state = next;
  lastSig = signature();
  if (before && before !== JSON.stringify(state.accounts)) emit('external');
  return true;
}

/** 存储状态（给 UI/诊断用） */
function storageInfo() {
  const f = file();
  return {
    path: f,
    exists: fs.existsSync(f),
    ok: !lastSaveError,
    error: lastSaveError,
    count: state ? state.accounts.length : 0,
  };
}

function dispose() {
  clearTimeout(watchTimer);
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 忽略 */
    }
    watcher = null;
  }
  listeners.clear();
}

app.on('will-quit', dispose);

module.exports = {
  list,
  publicList,
  get,
  exists,
  create,
  rename,
  update,
  remove,
  save,
  reload,
  storageInfo,
  onChange,
  sessionOf,
  DEFAULT_ACCOUNT,
  COLORS,
};
