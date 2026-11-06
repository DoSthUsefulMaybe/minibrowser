# minibrowser

极简浏览器，**一个窗口、多个标签、每个标签独立进程独立渲染**。
切换标签不重载页面，后台标签照常运行，所以同窗口内可以真正并行交互。

同一份代码出两个入口：

| 入口 | 给谁用 | 形态 |
| --- | --- | --- |
| `minibrowser.exe` | 人 | 有窗口：标签条 + 地址栏 |
| `minibrowser-cli.exe` | AI / 脚本 | 无窗口：子命令 + 结构化输出 |

两者是**同一个二进制**（硬链接，只有文件名不同），共用一份 Electron 运行时和一套渲染引擎。

## 打包

```bat
npm run build
```

产出 `dist/minibrowser/`：

```
minibrowser.exe        GUI 版
minibrowser-cli.exe    CLI 版（硬链接，不额外占空间）
resources/app/         两个入口共用
locales/               只留中英文
```

## GUI 版

双击 `dist\minibrowser\minibrowser.exe`，或开发时 `npm start`。

| 键 | 作用 |
| --- | --- |
| `Ctrl+T` | 新标签页 |
| `Ctrl+W` | 关闭当前标签（关掉最后一个则关窗口） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签 |
| `Ctrl+1`…`Ctrl+8` / `Ctrl+9` | 跳到第 n 个 / 最后一个标签 |
| `Ctrl+L` | 聚焦地址栏 |
| `Ctrl+R` / `F5` | 刷新（`Ctrl+Shift+R` 忽略缓存） |
| `Alt+←` / `Alt+→` | 后退 / 前进 |
| `Esc` | 停止加载 |
| `Ctrl+N` | 新窗口（窗口之间账号独立）|
| `Ctrl+Shift+G` | 切换宫格布局（1 → 2 → 4 → 6 → 9 格） |
| `Ctrl+Shift+I` | 开发者工具 |

中键点标签 = 关闭；地址栏支持「域名直达 / 其它当搜索词」。

## 宫格监控

工具栏最右边的按钮（或 `Ctrl+Shift+G`）在 1 / 2 / 4 / 6 / 9 格之间循环：

- **每个格子是一个真实的标签**，同时可见、同时渲染、同时跑（不是截图/缩略图，后台也不会被降频）；
- 每格顶部 22px 是标题条（标题 + favicon），点它或点网页本身都会把这个格子设为当前标签，地址栏跟着走；
- 格子之间留 4px 缝隙，当前格子标题条高亮 + 左侧竖条；
- 格子数装不下所有标签时按「滑动窗口」处理：切到窗口外的标签会自动滑进来。

实现上：单格 = `header 0 / gap 0`，多格 = 每个 `WebContentsView` 拿到自己的矩形。
标题条那块**不放 view**，露出下面的窗口 UI 层来画 —— 所以格子标题条和缝隙都是普通 DOM。

## 账号池

点工具栏上的「● 账号名」：

- 每个账号 = 一个独立的 Electron session（`persist:mb-*` 分区），**cookie / localStorage / 缓存全隔离**，
  所以同一站点可以同时登多个号，配合宫格一眼看住；
- 切换账号会**重建该标签的 view**（session 建好就不能换），地址保留、自动重新加载；
- 非默认账号在宫格标题条上有色点，一眼区分；
- 菜单里还有「新建账号」「管理账号池…」「清除当前账号的站点数据」。

**账号池可以可视化编辑**：「管理账号池…」打开一个窗口，直接改名（输入框里改，回车/失焦保存）、
点色点换颜色、新建、删除，右边显示每个账号正被多少个标签使用。删账号会把它的 cookie 一起清掉，
正在用它的标签自动退回默认账号并重新加载；内置的「默认」账号不可删。

账号池保存在 `userData/accounts.json`，**关闭重开仍在**；写入使用临时文件 + rename，
文件被其它窗口/进程改动时会自动重载并刷新界面。每个窗口仍然各自选择当前账号，
一个窗口切账号不会影响其它窗口；只有账号被删除时，用到它的标签才各自退回默认账号。

## 多窗口

`Ctrl+N` 新开一个窗口，或者「⋯ → 新窗口」。

- 每个窗口有**自己的标签条、宫格布局、当前账号**，互不干扰；
- 新窗口沿用当前窗口的账号，之后可以各自切——同一个站点，窗口 A 登甲号、窗口 B 登乙号，浏览器层面完全隔离；
- 标签拖到别的窗口？还没做（要自己写拖拽）。

实测：A 账号看到 `AAA`、B 账号看到 `BBB`、默认账号看到空 —— 三个 session 互不可见；
开第二个窗口后两边的标签 id 不重叠，给窗口2切账号不影响窗口1。

## 脚本仓库

「⋯ → 脚本仓库」，或直接编辑 `%LOCALAPPDATA%/minibrowser/scripts.json`。

- 脚本 = 名称 + 匹配规则（glob，`*` 通配，一行一条）+ 代码 + 启用开关；
- 匹配上的脚本在页面 `did-finish-load` 后注入页面上下文，能直接改 DOM；
- 改完点「重载已开页面」让所有标签重新注入；
- 存 `scripts.json`，纯本地。

## 笔记本（Obsidian 风格）

「⋯ → 笔记本」。它不是一个数据库，而是**直接读写磁盘上的一个文件夹**：
默认 `%LOCALAPPDATA%/minibrowser/vault`，点「文件夹」就能换成你自己的 Obsidian 库。

- **写**：新建 / 编辑 Markdown，输入停 800ms 自动存盘，`Ctrl+S` 立即存；
- **取**：左边文件树按目录翻，右边三栏「编辑 / 分栏 / 阅读」；
- **查**：顶部搜索标题和正文，命中显示上下文摘要；
- **双链**：`[[笔记名]]` 点一下跳过去；库里没有的显示灰色虚线下划线，点一下自动新建；
- **反链**：右下角列出所有链接到当前笔记的笔记；
- 渲染支持标题 / 粗斜体 / 行内代码 / 代码块 / 引用 / 列表 / 任务列表 / 表格 / 图片 / `#标签`。

网页上选中文字右键「用选中内容新建笔记」会写进 `收件箱/`，带 frontmatter + 来源链接。
这只是入口之一 —— 笔记本身就是普通 `.md`，Obsidian / VS Code / Typora 都能直接打开。

> 数据都在 `%LOCALAPPDATA%/minibrowser/`：`accounts.json` / `scripts.json` / `vault/`，
> 不写程序目录。自检自动用独立目录（`%TEMP%/minibrowser-selfcheck`），不会污染真实数据。

## CLI 版（给 AI 用）

```bat
minibrowser-cli.exe caps --json          :: 先问它能做什么
minibrowser-cli.exe text example.com
minibrowser-cli.exe title a.com b.com --json
minibrowser-cli.exe html example.com --out page.html
minibrowser-cli.exe links example.com --json
minibrowser-cli.exe eval example.com --js "document.title"
minibrowser-cli.exe shot example.com --out shot.png
```

- 多个 URL = **多个标签并行加载**（`--concurrency` 控制并发，默认 4）；
- `--json` 给结构化结果，字段固定：`ok / command / elapsed_ms / count / results[]`；
- `--out` 把大内容落盘，只回传路径 + 200 字预览 + 字节数，避免撑爆上下文；
- 退出码固定：`0` 全成功 / `1` 有页面失败 / `2` 参数错误；
- `caps` 输出能力清单（命令、选项、退出码），新增命令后自动出现在里面。

## 本地自动化入口（GUI）

给 AI / 脚本用的本地 HTTP 接口。启动时加：

```bat
minibrowser.exe --automation-port=9333 --automation-token=你的随机token
```

> 也可以把 token 放在环境变量 `MINIBROWSER_AUTOMATION_TOKEN`，避免出现在进程命令行里。
> 没有 token 时自动化入口拒绝启动。

可选参数：

- `--automation-profile=<目录>`：自动化实例使用独立 profile，避免和正在开的窗口抢缓存；
- `--user-agent=<UA>`：自定义 UA（有些站点会按 UA 里的 Electron 标识做风控）。

接口（全部要求 `Authorization: Bearer <token>`）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET | `/status` | 窗口、标签、当前标签 |
| GET | `/screenshot` | 当前标签截图 |
| GET | `/events` | 最近捕获的网络/控制台事件 |
| POST | `/navigate` | 打开 http/https 地址 |
| POST | `/select` | 切换标签 |
| POST | `/eval` | 在当前标签执行 JS |
| POST | `/focus` / `/click` / `/insert` | 聚焦、点击、输入 |
| POST | `/listen` / `/clear-events` | 开启/清空网络捕获 |
| POST | `/netbody` | 读取某次请求的响应体（敏感字段打码） |
| POST | `/useragent` / `/cdp` | 设置 UA / 白名单内的 CDP 命令 |

**安全边界**：只监听 `127.0.0.1`，必须带 token，校验 Host 和 `Content-Type: application/json`；
`/cdp` 只允许自动化需要的方法；`/navigate` 只允许 http/https；不要把端口暴露到局域网或公网。
`/eval` 会在当前页面执行 JS，等同于把该标签页的控制权交给调用方，token 要当成本机密钥保管。

## 备忘

- **窗口一闪而过打不开**：加 `--disable-gpu` 启动（少数机器显卡驱动会让 GPU 进程反复崩溃）：
  `minibrowser.exe --disable-gpu`
- CLI 版请在命令行里用。双击它没有控制台，输出会丢失（这也是它和 GUI 版分开的原因）。
- 首次启动会在 `%LOCALAPPDATA%\minibrowser`（CLI 是 `minibrowser-cli`）建缓存，不写程序目录。
- `dist/` 里的两个 exe 是硬链接，改其中一个的文件名不影响另一个；但拷到不支持硬链接的盘上会变成两份。

## 自检 / 回归

```bat
npm run check              :: GUI 自检（三十多项断言）
node test/regress.js       :: 源码版回归：GUI 自检 + CLI 全部命令
node test/regress.js --dist :: 打包版回归
```

GUI 自检覆盖（54 项）：多标签并行、JS 运行时隔离、布局、地址解析、UI 点击与地址栏导航全链路、
宫格（铺满/不重叠/同时运行/焦点切换）、账号池（两个账号 cookie 互不可见、切换后地址保留）、
脚本仓库（匹配注入 / 停用不注入 / 不匹配不注入 / 窗口能开）、笔记本（存改删 / 窗口能开）。

回归脚本会打印逐项结果，退出码 0 = 全绿。

## 结构

```
src/main.js        入口分流：exe 名带 cli / --cli 走 CLI，否则走 GUI
src/gui.js         GUI：窗口、标签表、每个标签的 WebContentsView、快捷键、IPC、自检
src/cli.js         CLI：命令表、参数解析、并行抓取、截图、JSON 输出
src/preload-ui.js  给工具栏 UI 的最小接口（无 node 权限）
src/ui/            标签条 + 工具栏（就是窗口标题栏）、地址栏逻辑、新标签页
build.js           打包：一份运行时 + 两个 exe
```

### 为什么能「单窗口多标签并行」

- `BrowserWindow` 自身只画顶部 76px 的工具栏；
- 每个标签是一个 `WebContentsView`，各自独立进程 / 独立 JS 堆 / 独立导航历史；
- 切换标签只是 `setVisible` + 换 bounds，**不销毁不重载**；
- `backgroundThrottling: false`，不可见的标签也不会被降频；
- 主进程是唯一状态源，任何变化推一份完整快照给 UI，UI 只负责画。

CLI 版是同一套结构：一个隐藏的 `BaseWindow`，每个 URL 一个 `WebContentsView`。
