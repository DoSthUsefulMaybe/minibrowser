'use strict';
/**
 * 账号池：每个账号 = 一个独立的 Electron session（partition）。
 *
 * 这样同一站点可以同时登多个号：cookie / localStorage / IndexedDB / 缓存全部隔离，
 * 配合宫格布局就能一眼看住好几个号。
 *
 * 默认账号用默认 session（不隔离），其余账号用 persist:mb-<id>。
 */
const { app, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const COLORS = ['#2f6fed', '#e0574b', '#2fa36b', '#c47f17', '#8b5cf6', '#0ea5e9', '#db2777', '#65a30d'];
const DEFAULT_ACCOUNT = { id: 'default', name: '默认', color: '#8a9099', partition: '' };

let state = null;

function file() {
  return path.join(app.getPath('userData'), 'accounts.json');
}

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && Array.isArray(raw.accounts) && raw.accounts.length) {
      state = raw;
      return state;
    }
  } catch {
    /* 首次运行或文件损坏 */
  }
  state = { accounts: [{ ...DEFAULT_ACCOUNT }] };
  return state;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(state, null, 2));
  } catch {
    /* 写不了就算了，不影响使用 */
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
    name: name || `账号 ${s.accounts.length}`,
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
  acc.name = String(name).slice(0, 30);
  save();
  return acc;
}

/** 改名 / 改色 */
function update(id, patch = {}) {
  const acc = list().find((a) => a.id === id);
  if (!acc) return null;
  if (patch.name !== undefined) acc.name = String(patch.name).slice(0, 30) || acc.name;
  if (patch.color !== undefined && /^#[0-9a-f]{3,8}$/i.test(String(patch.color))) acc.color = String(patch.color);
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
  save();
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

module.exports = { list, publicList, get, exists, create, rename, update, remove, save, sessionOf, DEFAULT_ACCOUNT, COLORS };
