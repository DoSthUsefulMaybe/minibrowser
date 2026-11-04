'use strict';
/**
 * 打包：一份 Electron 运行时 + 两个入口。
 *
 *   dist/minibrowser/
 *     minibrowser.exe        GUI 版（给人用）
 *     minibrowser-cli.exe    CLI 版（给 AI / 脚本用）—— 与 GUI 是同一个二进制的硬链接，
 *                            只有文件名不同，程序靠 exe 名分流，不额外占空间
 *     resources/app/         两个 exe 共用这一份应用代码
 *
 * 用法：npm run build   或   node build.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'minibrowser');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 只留中文 + 英文语言包
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);

/** 复制时直接跳过不用带的东西（比「复制完再删」快，也不碰批量删除的限制） */
function filter(src) {
  const rel = path.relative(ELECTRON_DIST, src);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts[0] === 'locales') return parts.length === 1 || KEEP_LOCALES.has(parts[1]);
  if (rel === path.join('resources', 'default_app.asar')) return false;
  return true;
}

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function sizeOf(dir, seen = new Set()) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += sizeOf(p, seen);
    else if (e.isFile()) {
      const st = fs.statSync(p);
      const key = `${st.dev}:${st.ino}`;
      if (seen.has(key)) continue; // 硬链接只算一次
      seen.add(key);
      total += st.size;
    }
  }
  return total;
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('找不到 node_modules/electron/dist，请先 npm install');
    process.exit(1);
  }

  console.log('· 准备输出目录');
  fs.mkdirSync(OUT, { recursive: true });
  // 只清应用代码和旧入口，运行时文件用覆盖复制（避免批量删除）
  rm(path.join(OUT, 'resources', 'app'));
  for (const f of ['minibrowser.exe', 'minibrowser-cli.exe']) {
    const p = path.join(OUT, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log('· 复制 Electron 运行时');
  fs.cpSync(ELECTRON_DIST, OUT, { recursive: true, filter });

  console.log('· 生成两个入口');
  const guiExe = path.join(OUT, 'minibrowser.exe');
  const cliExe = path.join(OUT, 'minibrowser-cli.exe');
  fs.renameSync(path.join(OUT, 'electron.exe'), guiExe);

  try {
    fs.linkSync(guiExe, cliExe); // 硬链接：同一份二进制，不占额外空间
  } catch {
    fs.copyFileSync(guiExe, cliExe); // 非 NTFS 时退回复制
    console.warn('  （硬链接不可用，CLI 入口为副本）');
  }

  console.log('· 写入应用代码');
  const appDir = path.join(OUT, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(appDir, 'src'), { recursive: true });

  // 只留运行时需要的字段
  const appPkg = {
    name: pkg.name,
    productName: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: 'src/main.js',
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));

  const total = sizeOf(OUT);
  console.log('');
  console.log('完成：' + OUT);
  console.log('  总体积          ' + mb(total));
  console.log('  minibrowser.exe      ' + mb(fs.statSync(guiExe).size) + '（GUI，给人用）');
  console.log(
    '  minibrowser-cli.exe  ' +
      (fs.statSync(cliExe).ino === fs.statSync(guiExe).ino ? '硬链接，不额外占空间' : mb(fs.statSync(cliExe).size)) +
      '（CLI，给 AI 用）'
  );
  console.log('');
  console.log('跑一下：');
  console.log('  dist\\minibrowser\\minibrowser.exe');
  console.log('  dist\\minibrowser\\minibrowser-cli.exe caps --json');
}

main();
