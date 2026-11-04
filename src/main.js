'use strict';
/**
 * 唯一入口。
 *
 * GUI 版和 CLI 版共用同一份 Electron 运行时、同一套渲染引擎：
 *   - minibrowser.exe      → GUI（标签 + 地址栏）
 *   - minibrowser-cli.exe  → CLI（无窗口，抓页面/截图/跑 JS）
 * 分流依据：exe 文件名里带 cli，或者显式传 --cli / --gui。
 */
const path = require('node:path');

function isCli() {
  const argv = process.argv;
  if (argv.includes('--cli')) return true;
  if (argv.includes('--gui') || argv.includes('--selfcheck')) return false;
  const exe = path.basename(process.execPath || '').toLowerCase();
  return /(^|[-_ ])cli(\.exe)?$/.test(exe);
}

if (isCli()) require('./cli.js');
else require('./gui.js');
