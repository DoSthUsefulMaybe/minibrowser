'use strict';
/**
 * CLI 版 —— 给 AI / 脚本用的那一份。
 *
 * 与 GUI 版共用同一份 Electron 运行时、同一套渲染引擎（WebContentsView），
 * 区别只是不画窗口：多个 URL 各自一个标签，在同一个隐藏窗口里并行加载。
 *
 * 设计原则（面向机器调用）：
 *   1. 子命令 + 固定字段的输出，`--json` 给出结构化结果，字段不会随版本乱变；
 *   2. `caps` 自描述能力，AI 可以先问「你能做什么」再决定怎么调；
 *   3. 退出码语义固定：0 全成功 / 1 有页面失败 / 2 参数错；
 *   4. 大输出可以 `--out` 落盘，避免把几十 KB HTML 塞回上下文。
 */
const { app, BaseWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'minibrowser-cli';
const VERSION = '0.1.0';

// Windows 控制台默认是 GBK，中文会乱码；有控制台时切到 UTF-8（无控制台则静默失败）
if (process.platform === 'win32') {
  try {
    require('node:child_process').execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'chcp.com'),
      ['65001'],
      { stdio: 'ignore', windowsHide: true }
    );
  } catch {
    /* 双击启动没有控制台，忽略 */
  }
}

if (process.argv.includes('--no-gpu') || process.env.MINIBROWSER_NO_GPU) {
  app.disableHardwareAcceleration();
}

// CLI 与 GUI 分开缓存目录，避免两边同时跑时抢 GPU 缓存/锁文件
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'minibrowser-cli'));
} catch {
  /* 取不到 appData 就用默认 */
}

/** Electron / Chromium 自己的开关：原样透传给运行时，CLI 只放行 */
const CHROMIUM_FLAGS = new Set([
  '--no-sandbox',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--in-process-gpu',
  '--disable-gpu-sandbox',
  '--enable-logging',
  '--disable-dev-shm-usage',
]);

// ---------------------------------------------------------------- 能力声明

const COMMANDS = [
  { name: 'text', args: '<url...>', desc: '页面正文纯文本（默认命令）' },
  { name: 'html', args: '<url...>', desc: '页面完整 HTML' },
  { name: 'title', args: '<url...>', desc: '只取标题' },
  { name: 'links', args: '<url...>', desc: '页面所有链接（文字 + href）' },
  { name: 'eval', args: '<url...> --js <code>', desc: '在页面里执行 JS，输出返回值' },
  { name: 'shot', args: '<url...> [--out <file>]', desc: '截图 PNG' },
  { name: 'caps', args: '', desc: '输出本工具的能力清单（JSON）' },
  { name: 'help', args: '', desc: '人类可读的帮助' },
];

const OPTIONS = [
  { flag: '--json', desc: '结构化 JSON 输出（机器读这个）' },
  { flag: '--pretty', desc: 'JSON 缩进美化' },
  { flag: '--out <file>', desc: '把结果写到文件（多 URL 自动加 -1/-2 后缀）' },
  { flag: '--js <code>', desc: 'eval 命令要执行的代码' },
  { flag: '--quiet', desc: '人类模式下只输出结果本身' },
  { flag: '--wait <ms>', desc: '加载完成后再等多久，默认 0' },
  { flag: '--timeout <ms>', desc: '单页超时，默认 30000' },
  { flag: '--concurrency <n>', desc: '并行标签数，默认 4' },
  { flag: '--width <n>', desc: '视口宽，默认 1280' },
  { flag: '--height <n>', desc: '视口高，默认 900' },
  { flag: '--ua <string>', desc: '自定义 User-Agent' },
  { flag: '--no-gpu', desc: '禁用硬件加速' },
];

const EXIT_CODES = { '0': '全部成功', '1': '至少一个页面失败', '2': '参数错误' };

function caps() {
  return {
    name: NAME,
    version: VERSION,
    engine: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    platform: `${process.platform}-${process.arch}`,
    commands: COMMANDS,
    options: OPTIONS,
    output: { human: '默认', json: '--json', file: '--out <path>' },
    exitCodes: EXIT_CODES,
    notes: [
      '多个 <url> 会各自开一个标签并行加载，互不阻塞。',
      'URL 可以是完整 URL、裸域名（自动补 https）、或搜索词（走 Bing）。',
      'AI 调用建议：加 --json；大内容用 --out 落盘再读文件。',
    ],
  };
}

const HELP = `
${NAME} ${VERSION} —— 极简浏览器的命令行版（给 AI / 脚本用），与 GUI 版同一套渲染引擎。

用法
  ${NAME} [命令] <url...> [选项]

  省略命令时按 text 处理：  ${NAME} example.com

命令
${COMMANDS.map((c) => `  ${c.name.padEnd(6)} ${c.args.padEnd(24)} ${c.desc}`).join('\n')}

选项
${OPTIONS.map((o) => `  ${o.flag.padEnd(20)} ${o.desc}`).join('\n')}

退出码
${Object.entries(EXIT_CODES)
  .map(([k, v]) => `  ${k}  ${v}`)
  .join('\n')}

例子
  ${NAME} text example.com
  ${NAME} title example.com bing.com --json
  ${NAME} html example.com --out page.html
  ${NAME} links example.com --json
  ${NAME} eval example.com --js "document.title"
  ${NAME} shot example.com --out shot.png
  ${NAME} caps --json
`.trim();

// ---------------------------------------------------------------- 参数

function parse(argv) {
  const o = {
    cmd: null,
    urls: [],
    js: null,
    out: null,
    json: false,
    pretty: false,
    quiet: false,
    wait: 0,
    timeout: 30000,
    concurrency: 4,
    width: 1280,
    height: 900,
    ua: null,
    bad: null,
  };

  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const names = new Set(COMMANDS.map((c) => c.name));

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];

    if (a === '-h' || a === '--help') o.cmd = 'help';
    else if (a === '-v' || a === '--version') o.cmd = 'version';
    else if (a === '--json') o.json = true;
    else if (a === '--pretty') o.pretty = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--js') o.js = next();
    else if (a === '--out') o.out = next();
    else if (a === '--wait') o.wait = num(next(), o.wait);
    else if (a === '--timeout') o.timeout = num(next(), o.timeout) || o.timeout;
    else if (a === '--concurrency') o.concurrency = Math.max(1, num(next(), 4));
    else if (a === '--width') o.width = num(next(), o.width) || o.width;
    else if (a === '--height') o.height = num(next(), o.height) || o.height;
    else if (a === '--ua') o.ua = next();
    else if (CHROMIUM_FLAGS.has(a) || a === '--no-gpu' || a === '--cli' || a === '--gui') {
      /* 运行时开关 */
    } else if (a.startsWith('-')) o.bad = a;
    else if (!o.cmd && names.has(a.toLowerCase())) o.cmd = a.toLowerCase();
    else if (!o.cmd) {
      // 第一个非命令、非选项的词：当成 URL，命令走默认值
      o.urls.push(a);
    } else o.urls.push(a);
  }

  if (!o.cmd) o.cmd = 'text';
  return o;
}

/** 与 GUI 版地址栏同样的规则 */
function normalizeInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^localhost([:/]|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}([:/?#]|$)/.test(s)) return 'http://' + s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(about|data|file|mailto|view-source):/i.test(s)) return s;
  if (!/\s/.test(s) && /^[^\s/?#]+\.[^\s/?#]{2,}([:/?#]|$)/.test(s)) return 'https://' + s;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- 抓取

const EXTRACT = {
  text: 'document.body ? document.body.innerText.replace(/\\n{3,}/g, "\\n\\n").trim() : ""',
  html: 'document.documentElement.outerHTML',
  title: 'document.title',
  links: `[...document.querySelectorAll('a[href]')].map(a => ({
    text: (a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
    href: a.href
  }))`,
};

async function grab(win, rawInput, opts, index) {
  const url = normalizeInput(rawInput);
  const r = { input: rawInput, url, title: '', output: '', outputFile: null, error: null, screenshot: null, ms: 0 };
  const t0 = Date.now();

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (opts.ua) view.webContents.setUserAgent(opts.ua);
  win.contentView.addChildView(view);
  view.setVisible(false);
  view.setBounds({ x: 0, y: 0, width: opts.width, height: opts.height });

  const wc = view.webContents;
  try {
    await withTimeout(wc.loadURL(url), opts.timeout, url);
    if (opts.wait) await sleep(opts.wait);

    r.title = wc.getTitle();
    r.url = wc.getURL() || url;

    if (opts.cmd === 'eval') {
      if (!opts.js) throw new Error('eval 需要 --js <code>');
      const v = await wc.executeJavaScript(opts.js, true);
      r.output = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    } else if (opts.cmd === 'shot') {
      // 隐藏窗口没有 display surface，截图前「显示但不激活」
      win.showInactive();
      view.setVisible(true);
      await sleep(180);
      const shot = await wc.capturePage();
      const file = numberedPath(opts.out || `${hostOf(r.url) || 'page'}.png`, index, opts.urls.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, shot.toPNG());
      r.screenshot = file;
      r.output = file;
    } else {
      const raw = await wc.executeJavaScript(EXTRACT[opts.cmd] || EXTRACT.text, true);
      if (opts.cmd === 'links' && Array.isArray(raw)) {
        r.linkCount = raw.length;
        r.output = raw.map((l) => `${l.text || '(无文字)'}\t${l.href}`).join('\n');
      } else {
        r.output = String(raw == null ? '' : raw);
      }
    }

    // --out：大内容落盘，只把路径 + 预览带回
    if (opts.out && opts.cmd !== 'shot') {
      const file = numberedPath(opts.out, index, opts.urls.length);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, r.output, 'utf8');
      r.outputFile = file;
      r.preview = r.output.slice(0, 200);
      r.bytes = Buffer.byteLength(r.output, 'utf8');
    }
  } catch (e) {
    r.error = String((e && e.message) || e).split('\n')[0];
    r.url = wc.getURL() || url;
    r.title = r.title || wc.getTitle() || '';
  } finally {
    r.ms = Date.now() - t0;
    try {
      win.contentView.removeChildView(view);
      wc.close();
    } catch {
      /* 已销毁 */
    }
  }
  return r;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/[^\w.-]+/g, '_');
  } catch {
    return '';
  }
}

function numberedPath(base, index, total) {
  const abs = path.resolve(base);
  if (total <= 1) return abs;
  const ext = path.extname(abs);
  return `${abs.slice(0, abs.length - ext.length)}-${index + 1}${ext}`;
}

// ---------------------------------------------------------------- 输出

function printHuman(results, opts) {
  for (const r of results) {
    if (!opts.quiet) {
      console.log(r.error ? `✗ ${r.input}` : `■ ${r.title || '(无标题)'}`);
      console.log(`  ${r.url}`);
    }
    if (r.error) console.log(`  ${r.error}`);
    else if (opts.cmd === 'shot') console.log(r.screenshot);
    else if (r.outputFile) console.log(`  → ${r.outputFile}（${r.bytes} 字节）\n${r.preview}${r.bytes > 200 ? '…' : ''}`);
    else if (r.output) console.log(r.output);
    if (!opts.quiet) console.log('');
  }
}

function toJson(results, opts, elapsed) {
  return {
    ok: results.every((r) => !r.error),
    command: opts.cmd,
    elapsed_ms: elapsed,
    count: results.length,
    results: results.map((r) => {
      const o = { input: r.input, url: r.url, title: r.title, error: r.error, ms: r.ms };
      if (r.outputFile) {
        o.outputFile = r.outputFile;
        o.bytes = r.bytes;
        o.preview = r.preview;
      } else if (r.output) {
        o.output = r.output;
      }
      if (r.linkCount !== undefined) o.linkCount = r.linkCount;
      if (r.screenshot) o.screenshot = r.screenshot;
      return o;
    }),
  };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const opts = parse(process.argv.slice(process.defaultApp ? 2 : 1));

  if (opts.bad) {
    console.error(`未知选项：${opts.bad}（用 --help 看用法）`);
    return 2;
  }
  if (opts.cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  if (opts.cmd === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (opts.cmd === 'caps') {
    console.log(JSON.stringify(caps(), null, opts.pretty ? 2 : 0));
    return 0;
  }
  if (!opts.urls.length) {
    console.error('缺少 <url>（用 --help 看用法）');
    return 2;
  }
  if (opts.cmd === 'eval' && !opts.js) {
    console.error('eval 需要 --js <code>');
    return 2;
  }

  const t0 = Date.now();
  const win = new BaseWindow({
    show: false,
    width: opts.width,
    height: opts.height,
    backgroundColor: '#ffffff',
  });

  const results = await mapPool(opts.urls, opts.concurrency, (u, i) => grab(win, u, opts, i));

  if (opts.json) {
    const payload = toJson(results, opts, Date.now() - t0);
    console.log(JSON.stringify(payload, null, opts.pretty ? 2 : 0));
  } else {
    printHuman(results, opts);
  }

  try {
    win.destroy();
  } catch {
    /* 忽略 */
  }
  return results.every((r) => !r.error) ? 0 : 1;
}

function flush() {
  return new Promise((r) => {
    if (!process.stdout.writableLength) return r();
    process.stdout.write('', () => r());
  });
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error(String((e && e.stack) || e));
  }
  await flush();

  // 退出码是 CLI 的接口契约，必须准。
  // 坑：在没有任何窗口、主循环还没真正转起来时直接 exit/process.exit，
  // Windows 上会以 0xC0000409（fail-fast）结束，退出码全废。
  // 所以先让事件循环转几拍，再用 app.exit() 带码退出。
  await sleep(250);
  app.exit(code);
});

app.on('window-all-closed', () => {
  /* CLI 自己管退出 */
});
