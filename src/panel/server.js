'use strict';

/**
 * 控制面板的本地服务（只在 127.0.0.1 上监听）。
 *
 * 面板界面是 Ant Design + React 构建出来的静态产物：
 *   - 打包版：构建产物在打包时被内联进 exe（见 tools/bundle.mjs 生成的 './panel-assets'）
 *   - 源码版：直接读 ui/dist
 *
 * 接口：
 *   GET  /                     控制面板页面（注入一次性令牌）
 *   GET  /api/status           代理与缓存状态（代理在跑时转发它的 /stats）
 *   GET  /api/log?lines=N      日志尾部
 *   POST /api/action           { action } —— 需要头部 x-gbf-panel: <令牌>
 *
 * 为什么要有令牌：本地服务没有账号体系，任何网页都能向 127.0.0.1 发请求；
 * 要求一个自定义头 + 随机令牌，就能挡掉跨站请求（浏览器跨域发不出这个头）。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function contentTypeOf(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** 收集面板静态文件：优先 exe 内联资源，其次磁盘上的 ui/dist */
function loadPanelAssets(root, requireFn) {
  try {
    const inlined = requireFn('./panel-assets');
    if (inlined && inlined.files) {
      const files = {};
      for (const [name, rec] of Object.entries(inlined.files)) {
        files[name] = { type: rec.type || contentTypeOf(name), data: Buffer.from(rec.b64 || '', 'base64') };
      }
      return { files, source: `inline（${Object.keys(files).length} 个文件）` };
    }
  } catch {
    /* 源码/无内联资源：走磁盘 */
  }
  // 界面产物跟代码在一起（src/panel/server.js 的上一级），而不是跟着 GBF_CACHE_HOME——
  // 测试/多实例会用临时工作目录，但界面永远来自项目目录（打包版则来自内联资源）。
  const selfDir = typeof __dirname === 'string' ? __dirname : null;
  // selfDir = <root>/src/panel，界面产物在 <root>/ui/dist
  const dist = selfDir ? path.join(selfDir, '..', '..', 'ui', 'dist') : path.join(root, 'ui', 'dist');
  const files = {};
  const walk = (dir, base = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else files[rel] = { type: contentTypeOf(rel), data: fs.readFileSync(p) };
    }
  };
  try {
    walk(dist);
  } catch {
    return { files: {}, source: `缺失（${dist}）` };
  }
  return { files, source: `disk（${Object.keys(files).length} 个文件）` };
}

function createPanel(opts) {
  const { root, config, log, isSea, findChrome, requireFn } = opts;
  const host = config.listen && config.listen.host ? config.listen.host : '127.0.0.1';
  const port = Number(opts.port || (config.panelPort || 18082));
  const statsPort = Number(opts.statsPort || config.statsPort || 18081);
  const token = crypto.randomBytes(16).toString('hex');
  const assets = loadPanelAssets(root, requireFn);
  const logFile = path.isAbsolute(config.logFile || '') ? config.logFile : path.join(root, config.logFile || 'runtime/logs/proxy.log');

  /** 代理可执行文件 + 参数：优先项目里的主 exe，其次用当前 node 跑 src/main.js（源码模式） */
  function proxyCommand(extra) {
    const mainExe = path.join(root, 'Grancache.exe');
    if (fs.existsSync(mainExe)) return { bin: mainExe, args: extra };
    if (opts.isSea) return { bin: process.execPath, args: extra };
    return { bin: process.execPath, args: [opts.scriptPath, ...extra] };
  }

  function runProxy(extra, { wait = false } = {}) {
    const { bin, args } = proxyCommand(extra);
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: root, windowsHide: true, stdio: 'ignore', detached: !wait });
      if (wait) child.on('exit', (code) => resolve(code));
      else {
        child.unref();
        resolve(0);
      }
    });
  }

  function proxyStats() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: statsPort, path: '/stats', timeout: 1200 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitProxy(expectRunning, timeoutMs = 15000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const s = await proxyStats();
      if (expectRunning ? !!s : !s) return true;
      await sleep(300);
    }
    return false;
  }

  function readLogTail(lines) {
    try {
      const max = 400 * 1024;
      const st = fs.statSync(logFile);
      const take = Math.min(max, st.size);
      const fd = fs.openSync(logFile, 'r');
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, st.size - take);
      fs.closeSync(fd);
      const all = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
      return all.slice(Math.max(0, all.length - lines)).join('\n');
    } catch {
      return '';
    }
  }

  function openInShell(url) {
    try {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      log('ERROR', 'PANEL-OPEN-FAIL ' + err.message);
    }
  }

  /** 打开"应用窗口"：Chrome 的 --app 模式没有地址栏和标签页，看起来就是个桌面程序 */
  function openPanelWindow(url) {
    const chrome = typeof findChrome === 'function' ? findChrome() : null;
    if (!chrome) {
      log('WARN', `PANEL 找不到 Chrome，请手动打开 ${url}`);
      return;
    }
    try {
      const child = spawn(chrome, [`--app=${url}`], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      log('WARN', 'PANEL 打开窗口失败：' + err.message);
    }
  }

  const ACTIONS = {
    'start-proxy': async () => {
      if (await proxyStats()) return { message: '缓存在运行中，无需重复启动' };
      await runProxy(['--daemon']);
      const ok = await waitProxy(true);
      if (!ok) throw new Error('启动超时，可以看 logs\\stdout.log');
      return { message: '缓存已启动' };
    },
    'stop-proxy': async () => {
      if (!(await proxyStats())) return { message: '缓存本来就已停止' };
      await runProxy(['--stop'], { wait: true });
      const ok = await waitProxy(false);
      if (!ok) throw new Error('停止超时（可能有别的程序占着端口）');
      return { message: '缓存已停止' };
    },
    'restart-proxy': async () => {
      await runProxy(['--stop'], { wait: true });
      await waitProxy(false, 10000);
      await runProxy(['--daemon']);
      const ok = await waitProxy(true);
      if (!ok) throw new Error('重启超时');
      return { message: '缓存已重启' };
    },
    'start-all': async () => {
      // --play = playMode：确保后台代理在跑，并用带缓存的配置打开 Chrome 和游戏
      await runProxy(['--play']);
      const ok = await waitProxy(true, 25000);
      if (!ok) throw new Error('缓存没起来，可以看 logs\\stdout.log');
      return { message: '缓存已就绪，Chrome 正在打开游戏' };
    },
    'clear-cache': async () => {
      await runProxy(['--clear-cache'], { wait: true });
      return { message: '缓存已清空（_ap 魔改文件保留）' };
    },
    // 系统代理（PAC）：接管后"已经开着的浏览器"也会走缓存；
    // 只分流碧蓝幻想域名，其它流量原样交回原来的出口
    'system-proxy-on': async () => {
      await runProxy(['--system-proxy=on'], { wait: true });
      return { message: '已接管系统代理：未重启的浏览器也会走缓存' };
    },
    'system-proxy-off': async () => {
      await runProxy(['--system-proxy=off'], { wait: true });
      return { message: '已还原系统代理设置' };
    },
    'open-stats': async () => {
      openInShell(`http://127.0.0.1:${statsPort}/`);
      return { message: '已打开统计页' };
    },
    'open-log': async () => {
      if (!fs.existsSync(logFile)) throw new Error('还没有日志文件');
      const child = spawn('notepad.exe', [logFile], { detached: true, stdio: 'ignore' });
      child.unref();
      return { message: '已用记事本打开日志' };
    },
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-gbf-panel': '1' });
      res.end(body);
    };
    const json = (code, obj) => send(code, JSON.stringify(obj));

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const idx = assets.files['index.html'];
      if (!idx) {
        return send(
          500,
          '<h2>面板界面缺失</h2><p>请在 ui 目录执行 <code>npm install &amp;&amp; npm run build</code>，或使用打包好的 exe。</p>',
          'text/html; charset=utf-8'
        );
      }
      const html = idx.data.toString('utf8').replace(/__GBF_PANEL_TOKEN__/g, token);
      return send(200, html, 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return proxyStats().then((stats) =>
        json(200, {
          ok: true,
          panel: { port, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) },
          proxy: { running: !!stats, pid: stats ? stats.pid : null, stats },
          paths: { root, cacheDir: config.cacheDir, logFile, panelAssets: assets.source },
          // 系统代理（PAC）状态：接管后"已经开着的浏览器"也会走缓存
          systemProxy: {
            applied: fs.existsSync(path.join(root, 'runtime', 'system-proxy.json')),
            supported: config.systemProxy !== false,
          },
        })
      );
    }

    if (req.method === 'GET' && url.pathname === '/api/log') {
      const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines') || 120)));
      return json(200, { ok: true, text: readLogTail(lines) });
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (req.headers['x-gbf-panel'] !== token) return json(403, { ok: false, message: '令牌不对（请在面板页面里操作）' });
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', async () => {
        let action = '';
        try {
          action = JSON.parse(body || '{}').action || '';
        } catch {
          return json(400, { ok: false, message: '请求体不是 JSON' });
        }
        const fn = ACTIONS[action];
        if (!fn) return json(400, { ok: false, message: `未知动作：${action}` });
        try {
          const r = await fn();
          const stats = await proxyStats();
          log('PANEL', `${action}${r && r.message ? ' —— ' + r.message : ''}`);
          return json(200, { ok: true, running: !!stats, ...(r || {}) });
        } catch (err) {
          log('WARN', `PANEL ${action} 失败：${err.message}`);
          return json(500, { ok: false, message: err.message });
        }
      });
      return undefined;
    }

    const assetName = url.pathname.replace(/^\/+/, '') || 'index.html';
    const asset = assets.files[assetName];
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      return res.end(asset.data);
    }
    return json(404, { ok: false, message: 'not found' });
  });

  const startedAt = Date.now();
  server.on('error', (err) => {
    log('ERROR', `PANEL 启动失败：${err.message}`);
    if (err.code === 'EADDRINUSE') log('ERROR', `面板端口 ${port} 被占用（可能已经开着一个面板）`);
  });

  server.listen(port, host, () => {
    const url = `http://127.0.0.1:${port}/`;
    log(`[panel] 控制面板已就绪：${url}（界面资源：${assets.source}）`);
    // GBF_PANEL_NO_WINDOW=1 时不自动开窗口（自动化测试、或不想弹窗的场合）
    if (opts.openWindow && process.env.GBF_PANEL_NO_WINDOW !== '1') openPanelWindow(url);
  });

  return { server, port, token, url: `http://127.0.0.1:${port}/` };
}

module.exports = { createPanel, loadPanelAssets };
