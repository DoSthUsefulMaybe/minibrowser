'use strict';
/**
 * 本地自动化入口（给 AI / 脚本用）
 *
 * 只监听 127.0.0.1，并要求 Bearer token：
 *   minibrowser.exe --automation-port=9333 --automation-token=xxx
 *
 * 接口：
 *   GET  /health          → 存活检查
 *   GET  /status          → 窗口、标签、当前标签
 *   GET  /screenshot      → 当前标签截图（PNG 路径）
 *   GET  /events          → 最近捕获的网络/控制台事件
 *   POST /navigate        → { url, tabId?, newTab? }（仅 http/https）
 *   POST /select          → { tabId }
 *   POST /eval            → { code, tabId? }
 *   POST /focus           → { selector, tabId? }
 *   POST /click           → { selector, tabId? }
 *   POST /insert          → { text, tabId? }（向当前焦点输入）
 *   POST /useragent       → { ua, tabId? }
 *   POST /cdp             → { method, params, tabId? }（方法白名单）
 *   POST /focuswindow     → 把当前窗口带到前台
 *   POST /listen          → 开启网络/控制台捕获
 *   POST /clear-events    → 清空捕获
 *   POST /netbody         → { requestId, tabId? }（响应体，敏感字段打码）
 *   POST /wait            → { ms }
 *
 * 安全边界：只监听 127.0.0.1，必须带 Bearer token，拒绝非本机 Host，
 * POST 必须是 application/json；不暴露文件系统、不执行 shell。
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BODY = 1024 * 1024; // 1MB，足够粘贴一篇文章
const events = [];
const hooked = new WeakSet();

// 只允许自动化实际需要的 CDP 方法，避免被拿来做关闭浏览器/改网络等操作
const CDP_ALLOW = new Set([
  'Network.setUserAgentOverride',
  'Network.enable',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
  'Network.getResponseBody',
  'Storage.clearDataForOrigin',
  'Runtime.enable',
  'Log.enable',
  'Page.reload',
  'Page.captureScreenshot',
  'Page.bringToFront',
]);

function tokenMatches(got, expected) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function safeNavigateUrl(raw) {
  const s = String(raw || '').trim();
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http/https urls are allowed');
  return u.toString();
}

function redactBody(s) {
  return String(s || '')
    .replace(/("?(?:token|ticket|cookie|password|phone|mobile)"?\s*[:=]\s*")([^"]*)"/gi, '$1***"')
    .slice(0, 10000);
}

function pushEvent(e) {
  events.push(e);
  while (events.length > 400) events.shift();
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^(cookie|set-cookie|authorization|x-zse-|x-xsrftoken|x-udid|x-za-clientid)/i.test(k)) out[k] = '<redacted>';
    else out[k] = String(v).slice(0, 500);
  }
  return out;
}

function safePostData(raw) {
  if (!raw) return '';
  const s = String(raw).slice(0, 4000);
  try {
    const o = JSON.parse(s);
    for (const k of Object.keys(o)) {
      if (/pass|token|ticket|cookie|phone|mobile|code|digits|username|email|account/i.test(k)) o[k] = '***';
    }
    return JSON.stringify(o).slice(0, 2000);
  } catch {
    // 非 JSON：只保留可打印的表单文本，二进制/压缩体直接丢弃，避免把密文带进日志
    if (!/^[\x09\x0a\x0d\x20-\x7e\u4e00-\u9fa5]*$/.test(s)) return '<binary>';
    return s
      .replace(/(password|phone|mobile|token|ticket|cookie|code|digits|username|email|account)=([^&]*)/gi, '$1=***')
      .slice(0, 2000);
  }
}

function attachEvents(tab) {
  const dbg = tab.view.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  if (hooked.has(dbg)) return;
  hooked.add(dbg);
  dbg.on('message', (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      pushEvent({
        type: 'request',
        ts: Date.now(),
        requestId: params.requestId,
        method: params.request.method,
        url: params.request.url,
        headers: redactHeaders(params.request.headers),
        postData: safePostData(params.request.postData),
      });
    } else if (method === 'Network.responseReceived') {
      pushEvent({
        type: 'response',
        ts: Date.now(),
        requestId: params.requestId,
        status: params.response.status,
        mimeType: params.response.mimeType,
        url: params.response.url,
        headers: redactHeaders(params.response.headers),
      });
    } else if (method === 'Network.loadingFailed') {
      pushEvent({
        type: 'failed',
        ts: Date.now(),
        requestId: params.requestId,
        errorText: params.errorText,
        blockedReason: params.blockedReason,
      });
    } else if (method === 'Runtime.consoleAPICalled') {
      pushEvent({
        type: 'console',
        ts: Date.now(),
        level: params.type,
        text: (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(' ')
          .slice(0, 1000),
      });
    } else if (method === 'Log.entryAdded') {
      pushEvent({
        type: 'log',
        ts: Date.now(),
        level: params.entry.level,
        text: String(params.entry.text || '').slice(0, 1000),
        url: params.entry.url,
      });
    }
  });
}

async function enableEvents(tab) {
  attachEvents(tab);
  const dbg = tab.view.webContents.debugger;
  await dbg.sendCommand('Network.enable').catch(() => {});
  await dbg.sendCommand('Runtime.enable').catch(() => {});
  await dbg.sendCommand('Log.enable').catch(() => {});
  events.length = 0;
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function pickTab(api, tabId) {
  if (tabId !== undefined && tabId !== null && tabId !== '') {
    const id = Number(tabId);
    for (const ctx of api.windows) {
      const tab = ctx.tabs.find((t) => t.id === id);
      if (tab) return { tab, ctx };
    }
    throw new Error(`tab not found: ${tabId}`);
  }
  const ctx = api.curCtx();
  if (!ctx) throw new Error('no window');
  const tab = api.activeTab(ctx);
  if (!tab) throw new Error('no active tab');
  return { tab, ctx };
}

function tabInfo(tab, ctx) {
  const wc = tab.view.webContents;
  return {
    id: tab.id,
    windowId: ctx.id,
    active: ctx.activeId === tab.id,
    loading: tab.loading,
    accountId: tab.accountId,
    title: tab.title || wc.getTitle(),
    url: wc.getURL(),
  };
}

async function screenshot(tab, filePath) {
  const wc = tab.view.webContents;
  const image = await wc.capturePage();
  const out = filePath || path.join(os.tmpdir(), `minibrowser-shot-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  return out;
}

function start({ port, token, api }) {
  if (!token) {
    console.error('[automation] 拒绝启动：必须提供 --automation-token 或 MINIBROWSER_AUTOMATION_TOKEN');
    return null;
  }

  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)) {
      return json(res, 403, { ok: false, error: 'localhost only' });
    }

    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return json(res, 403, { ok: false, error: 'invalid host' });
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const auth = String(req.headers.authorization || '');
    const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(got, token)) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
      return json(res, 415, { ok: false, error: 'content-type must be application/json' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, app: 'minibrowser', time: Date.now() });
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
          ok: true,
          windows: api.windows.map((ctx) => ({
            id: ctx.id,
            activeId: ctx.activeId,
            gridIndex: ctx.gridIndex,
            focused: ctx.win === require('electron').BrowserWindow.getFocusedWindow(),
            tabs: ctx.tabs.map((t) => tabInfo(t, ctx)),
          })),
        });
      }

      if (req.method === 'GET' && url.pathname === '/screenshot') {
        const { tab } = pickTab(api, url.searchParams.get('tabId'));
        const file = await screenshot(tab, url.searchParams.get('path'));
        return json(res, 200, { ok: true, path: file });
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        const since = Number(url.searchParams.get('since')) || 0;
        const limit = Math.max(1, Math.min(400, Number(url.searchParams.get('limit')) || 200));
        const filter = url.searchParams.get('filter') || '';
        const list = events
          .filter((e) => e.ts >= since && (!filter || JSON.stringify(e).includes(filter)))
          .slice(-limit);
        return json(res, 200, { ok: true, count: list.length, events: list });
      }

      if (req.method !== 'POST') {
        return json(res, 404, { ok: false, error: 'not found' });
      }

      const body = await readBody(req);

      if (url.pathname === '/navigate') {
        const target = safeNavigateUrl(body.url);
        const ctx = body.tabId ? pickTab(api, body.tabId).ctx : api.curCtx();
        if (!ctx) throw new Error('no window');
        if (body.newTab) {
          const tab = api.createTab(target, {}, ctx);
          return json(res, 200, { ok: true, tab: tabInfo(tab, ctx) });
        }
        const { tab } = pickTab(api, body.tabId);
        await tab.view.webContents.loadURL(target);
        return json(res, 200, { ok: true, tab: tabInfo(tab, ctx) });
      }

      if (url.pathname === '/select') {
        const { tab, ctx } = pickTab(api, body.tabId);
        api.setActive(tab.id, ctx);
        return json(res, 200, { ok: true, tab: tabInfo(tab, ctx) });
      }

      if (url.pathname === '/eval') {
        const { tab } = pickTab(api, body.tabId);
        const code = String(body.code || '');
        if (!code) throw new Error('code required');
        const value = await tab.view.webContents.executeJavaScript(code, true);
        return json(res, 200, { ok: true, value });
      }

      if (url.pathname === '/focus') {
        const { tab } = pickTab(api, body.tabId);
        const selector = String(body.selector || '');
        if (!selector) throw new Error('selector required');
        const value = await tab.view.webContents.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return document.activeElement === el; })()`,
          true
        );
        return json(res, 200, { ok: true, focused: value });
      }

      if (url.pathname === '/click') {
        const { tab } = pickTab(api, body.tabId);
        const selector = String(body.selector || '');
        if (!selector) throw new Error('selector required');
        const value = await tab.view.webContents.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
          true
        );
        return json(res, 200, { ok: true, clicked: value });
      }

      if (url.pathname === '/insert') {
        const { tab } = pickTab(api, body.tabId);
        const text = String(body.text || '');
        if (!text) throw new Error('text required');
        tab.view.webContents.insertText(text);
        return json(res, 200, { ok: true, length: text.length });
      }

      if (url.pathname === '/useragent') {
        const { tab } = pickTab(api, body.tabId);
        const ua = String(body.ua || '').trim();
        if (!ua) throw new Error('ua required');
        tab.view.webContents.setUserAgent(ua);
        return json(res, 200, { ok: true, ua: tab.view.webContents.getUserAgent() });
      }

      if (url.pathname === '/cdp') {
        const { tab } = pickTab(api, body.tabId);
        const method = String(body.method || '');
        if (!method) throw new Error('method required');
        if (!CDP_ALLOW.has(method)) throw new Error(`cdp method not allowed: ${method}`);
        const dbg = tab.view.webContents.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        const result = await dbg.sendCommand(method, body.params || {});
        return json(res, 200, { ok: true, result });
      }

      if (url.pathname === '/focuswindow') {
        const ctx = api.curCtx();
        if (!ctx || !ctx.win) throw new Error('no window');
        ctx.win.show();
        ctx.win.focus();
        return json(res, 200, { ok: true, windowId: ctx.id });
      }

      if (url.pathname === '/listen') {
        const { tab } = pickTab(api, body.tabId);
        await enableEvents(tab);
        return json(res, 200, { ok: true, listening: true });
      }

      if (url.pathname === '/clear-events') {
        events.length = 0;
        return json(res, 200, { ok: true });
      }

      if (url.pathname === '/netbody') {
        const { tab } = pickTab(api, body.tabId);
        const requestId = String(body.requestId || '');
        if (!requestId) throw new Error('requestId required');
        const dbg = tab.view.webContents.debugger;
        if (!dbg.isAttached()) dbg.attach('1.3');
        const r = await dbg.sendCommand('Network.getResponseBody', { requestId });
        return json(res, 200, {
          ok: true,
          base64Encoded: !!r.base64Encoded,
          body: redactBody(r.body),
        });
      }

      if (url.pathname === '/wait') {
        const ms = Math.max(0, Math.min(60000, Number(body.ms) || 0));
        await new Promise((r) => setTimeout(r, ms));
        return json(res, 200, { ok: true, waited: ms });
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[automation] http://127.0.0.1:${port} (token required)`);
  });
  server.on('error', (e) => console.error('[automation]', e.message));
  return server;
}

module.exports = { start };
