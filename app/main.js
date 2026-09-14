'use strict';

/**
 * Grancache 的桌面外壳（Electron）。
 *
 * 面板没有被重写：这里直接复用 src/panel/server.js 起的那个本地服务（界面就是 ui/dist 里的
 * React + Ant Design），只是把原来的「chrome --app 打开网页」换成真正的原生窗口，
 * 再补上托盘、单实例、记忆窗口位置。
 *
 * 想用回原来的浏览器窗口：`Grancache.exe --panel`（那条路一行没动）。
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ICON = path.join(ROOT, 'Grancache.ico');
const STATE_FILE = path.join(ROOT, 'runtime', 'window.json');
const LOG_FILE = path.join(ROOT, 'runtime', 'logs', 'panel.log');
const PROXY_LOG = path.join(ROOT, 'runtime', 'logs', 'proxy.log');

let win = null;
let tray = null;
let panel = null;
let quitting = false;

// ---------------------------------------------------------------- 工具

/** 面板进程自己的日志，和 --panel 模式写同一个文件 */
function makeLog() {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
    /* 目录建不出来就算了 */
  }
  return (...parts) => {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    process.stdout.write(line + '\n');
    try {
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
      /* 日志写不进去不影响使用 */
    }
  };
}

const log = makeLog();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(win.getBounds()));
  } catch {
    /* 记不住位置不是问题 */
  }
}

/** 起/停缓存复用面板那套命令行，避免两套逻辑走偏 */
function proxyCommand(extra) {
  const exe = path.join(ROOT, 'Grancache.exe');
  if (fs.existsSync(exe)) return { bin: exe, args: extra, viaElectron: false };
  // 源码模式：process.execPath 是 electron.exe，要让它按 Node 跑
  return { bin: process.execPath, args: [path.join(ROOT, 'src', 'main.js'), ...extra], viaElectron: true };
}

function runProxy(extra) {
  const { bin, args, viaElectron } = proxyCommand(extra);
  try {
    const child = spawn(bin, args, {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: viaElectron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    });
    child.unref();
  } catch (err) {
    log('WARN', `执行 ${extra.join(' ')} 失败：${err.message}`);
  }
}

// ---------------------------------------------------------------- 面板服务

/** 复用 src/panel/server.js；把它的「自动开浏览器窗口」关掉，窗口由 Electron 提供 */
function startPanel(config, port) {
  const { createPanel } = require(path.join(ROOT, 'src', 'panel', 'server.js'));
  panel = createPanel({
    root: ROOT,
    config,
    log,
    isSea: false,
    findChrome: () => null,
    requireFn: require,
    scriptPath: path.join(ROOT, 'src', 'main.js'),
    statsPort: config.statsPort,
    port,
    openWindow: false,
  });
  return new Promise((resolve, reject) => {
    const srv = panel.server;
    if (srv.listening) return resolve(panel.url);
    srv.once('listening', () => resolve(panel.url));
    srv.once('error', reject);
  });
}

/** 面板端口：--panel-port=18082 或环境变量 GBF_PANEL_PORT 可换，默认用 config.json */
function panelPort() {
  const fromArg = (process.argv.find((a) => a.startsWith('--panel-port=')) || '').split('=')[1];
  const n = Number(fromArg || process.env.GBF_PANEL_PORT);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 那个端口上是不是已经有一个 Grancache 面板在跑 */
function probePanel(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.includes('gbf-panel-token')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 起自己的面板；端口被占且那里确实是个面板时，直接复用，不再起第二个 */
async function ensurePanel() {
  const config = loadConfig();
  const port = panelPort();
  try {
    return await startPanel(config, port);
  } catch (err) {
    const url = `http://127.0.0.1:${port || config.panelPort || 18082}/`;
    if (err && err.code === 'EADDRINUSE' && (await probePanel(url))) {
      log(`[panel] 端口已有面板在跑，直接复用：${url}`);
      panel = { url, reused: true };
      return url;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- 窗口

function createWindow(url) {
  const st = readState();
  win = new BrowserWindow({
    width: st.width || 1180,
    height: st.height || 820,
    x: Number.isFinite(st.x) ? st.x : undefined,
    y: Number.isFinite(st.y) ? st.y : undefined,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Grancache',
    icon: ICON,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f1115', symbolColor: '#c9d1d9', height: 36 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });

  win.once('ready-to-show', () => win.show());
  win.on('resize', saveState);
  win.on('move', saveState);

  // 关窗口 = 收进托盘（缓存继续跑）；真退出走托盘菜单
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  // 用了无边框标题栏，就得自己补一条可拖动的顶栏，否则窗口没法拖
  win.webContents.on('did-finish-load', () => {
    win.webContents
      .executeJavaScript(`(() => {
        if (document.getElementById('gc-dragbar')) return;
        const bar = document.createElement('div');
        bar.id = 'gc-dragbar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:36px;background:#0f1115;'
          + '-webkit-app-region:drag;z-index:2147483646';
        document.body.appendChild(bar);
        document.body.style.paddingTop = '36px';
        document.body.style.boxSizing = 'border-box';
        // 面板最外层是 minHeight:100vh，顶栏占掉 36px 后会平白多一条滚动条，这里补回来
        const wrap = document.getElementById('root') && document.getElementById('root').firstElementChild;
        if (wrap) wrap.style.minHeight = 'calc(100vh - 36px)';
      })()`)
      .catch(() => {});

    // 给文档出图用：GC_SCREENSHOT=<png 路径> 时，渲染完把窗口内容存下来再退出。
    // 只截应用自己的窗口，不碰桌面其它内容。
    const shot = process.env.GC_SCREENSHOT;
    if (shot) {
      setTimeout(async () => {
        try {
          // 尽量装下整页：截完就退出，临时放大窗口不会影响正常使用
          const full = await win.webContents.executeJavaScript('document.body.scrollHeight + 40');
          if (Number.isFinite(full) && full > 200) {
            const b = win.getBounds();
            win.setBounds({ x: b.x, y: 0, width: b.width, height: Math.min(2400, Math.round(full)) });
            await new Promise((r) => setTimeout(r, 900));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shot, img.toPNG());
          log(`[shot] 窗口截图已保存：${shot}`);
        } catch (err) {
          log('WARN', `截图失败：${err.message}`);
        }
        quitting = true;
        app.quit();
      }, 2500);
    }
  });

  win.loadURL(url);
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Grancache');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示面板', click: showWindow },
      { type: 'separator' },
      { label: '启动缓存', click: () => runProxy(['--daemon']) },
      { label: '停止缓存', click: () => runProxy(['--stop']) },
      { label: '清空缓存', click: () => runProxy(['--clear-cache']) },
      { type: 'separator' },
      { label: '打开日志', click: () => shell.openPath(PROXY_LOG) },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('double-click', showWindow);
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    app.setAppUserModelId('Grancache');
    let url;
    try {
      url = await ensurePanel();
    } catch (err) {
      log('ERROR', `面板服务启动失败：${err.message}`);
      dialog.showErrorBox('Grancache', `控制面板启动失败：${err.message}`);
      app.exit(1);
      return;
    }
    createWindow(url);
    createTray();
  });

  // 托盘常驻：窗口全关也不退出
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    saveState();
  });
}
