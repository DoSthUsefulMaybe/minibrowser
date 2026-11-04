'use strict';
/**
 * 回归测试：一次跑完 GUI 自检 + CLI 全部命令。
 *
 *   node test/regress.js          跑源码版（node_modules 里的 electron）
 *   node test/regress.js --dist   跑打包版（dist/minibrowser）
 *
 * 退出码：0 全绿 / 1 有失败。
 *
 * 注：这里固定带 --no-sandbox --disable-gpu，是为了能在无 GPU 的自动化环境里跑；
 *     本机手动验证时不需要这两个参数。
 */
const { spawnSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USE_DIST = process.argv.includes('--dist');
const SANDBOX = ['--no-sandbox', '--disable-gpu'];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 详见 README：这个变量会逼 Electron 进 Node 模式

let guiExe;
let cliExe;
let prefix; // 开发模式需要先传 "."

if (USE_DIST) {
  const dir = path.join(ROOT, 'dist', 'minibrowser');
  guiExe = path.join(dir, 'minibrowser.exe');
  cliExe = path.join(dir, 'minibrowser-cli.exe');
  prefix = [];
  if (!fs.existsSync(guiExe)) {
    console.error('找不到 dist/minibrowser，先跑 npm run build');
    process.exit(1);
  }
} else {
  guiExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  cliExe = guiExe;
  prefix = ['.'];
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

function run(exe, args) {
  const r = spawnSync(exe, args, { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const cli = (...args) => run(cliExe, [...prefix, '--cli', ...args, ...SANDBOX]);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- CLI

{
  const r = cli('caps', '--json');
  const j = parseJson(r.out);
  check('CLI caps 自描述', r.status === 0 && j && j.name === 'minibrowser-cli' && j.commands.length >= 6, j ? `${j.commands.length} 个命令 / ${j.engine}` : '解析失败');
}

{
  const r = cli('--version');
  check('CLI 版本', r.status === 0 && /^\d+\.\d+\.\d+$/.test(r.out), r.out || `status=${r.status}`);
}

{
  const r = cli('--badflag');
  check('未知选项 → 退出码 2', r.status === 2, `status=${r.status}`);
}

{
  const r = cli('title', 'example.com', '--json');
  const j = parseJson(r.out);
  check('CLI 抓取成功 → 0', r.status === 0 && j && j.ok && j.results[0].title === 'Example Domain', j ? j.results[0].title : r.out.slice(0, 80));
}

{
  const r = cli('title', 'no-such-host.invalid', '--json', '--timeout', '8000');
  const j = parseJson(r.out);
  check('CLI 页面失败 → 1', r.status === 1 && j && j.ok === false, j && j.results[0].error ? j.results[0].error : `status=${r.status}`);
}

{
  const r = cli('title', 'example.com', 'bing.com', '--json');
  const j = parseJson(r.out);
  const two = j && j.count === 2 && j.results.every((x) => !x.error);
  check('CLI 多 URL 并行', r.status === 0 && two, j ? `${j.elapsed_ms}ms / ${j.results.map((x) => x.title).join(' | ')}` : r.out.slice(0, 80));
}

{
  const out = path.join(ROOT, 'test', '_tmp_page.html');
  const r = cli('html', 'example.com', '--out', out, '--json');
  const j = parseJson(r.out);
  const ok = r.status === 0 && j && j.results[0].outputFile && fs.existsSync(out) && fs.statSync(out).size > 200;
  check('CLI --out 落盘', ok, j && j.results[0].outputFile ? `${j.results[0].bytes} 字节` : `status=${r.status}`);
  fs.rmSync(out, { force: true });
}

// ---------------------------------------------------------------- GUI

{
  const r = run(guiExe, [...prefix, '--selfcheck', ...SANDBOX]);
  const pass = (r.out.match(/"pass": true/g) || []).length;
  const fail = (r.out.match(/"pass": false/g) || []).length;
  check('GUI 自检全绿', r.status === 0 && fail === 0 && pass >= 20, `pass=${pass} fail=${fail}`);
}

// ---------------------------------------------------------------- 汇总

const width = Math.max(...results.map((r) => [...r.name].length)) + 2;
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  const pad = ' '.repeat(Math.max(0, width - [...r.name].length));
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${pad}${r.detail || ''}`);
}
console.log('');
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
