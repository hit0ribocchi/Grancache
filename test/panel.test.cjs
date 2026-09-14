'use strict';
/**
 * 控制面板（--panel-only）的离线端到端测试：
 *   1. 页面能取到（含注入的令牌、antd 前端资源可加载）
 *   2. /api/status、/api/log 正常
 *   3. 没有令牌 → POST 被拒（403）
 *   4. 带令牌：start-proxy / stop-proxy / clear-cache 真跑一遍
 *
 * 全程用临时工作目录，不碰真实缓存与真实 config.json；不会打开任何窗口。
 * 用法: node tools/panel.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const PANEL_PORT = 18997;
const PROXY_PORT = 18995;

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-panel-'));
fs.mkdirSync(path.join(tmp, 'runtime', 'certs', 'ca'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'runtime', 'certs', 'leaf'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'runtime', 'logs'), { recursive: true });
for (const f of ['ca.crt', 'ca.key']) fs.copyFileSync(path.join(ROOT, 'runtime', 'certs', 'ca', f), path.join(tmp, 'runtime', 'certs', 'ca', f));
for (const f of ['localhost.crt', 'localhost.key']) fs.copyFileSync(path.join(ROOT, 'runtime', 'certs', 'leaf', f), path.join(tmp, 'runtime', 'certs', 'leaf', f));

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
cfg.listen = { host: '127.0.0.1', port: PROXY_PORT };
cfg.statsPort = PROXY_PORT + 1;
cfg.panelPort = PANEL_PORT;
cfg.cacheDir = path.join(tmp, 'cache');
cfg.logFile = path.join(tmp, 'runtime', 'logs', 'proxy.log');
cfg.keepWarmSeconds = 0;
cfg.keepWarmHosts = [];
cfg.prewarmHosts = [];
cfg.upstream = { mode: 'direct', host: '127.0.0.1', port: 0 };
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg, null, 2));

function req(method, pathname, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['x-gbf-panel'] = token;
    if (body) headers['content-type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: PANEL_PORT, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const jsonOf = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
};

(async () => {
  console.log('临时工作目录:', tmp);
  // TARGET=exe 时改用打包好的面板 exe（这样还能顺带验证界面是不是真的内联进去了）
  const useExe = process.env.TARGET === 'exe';
  // 允许用 PANEL_EXE 指定被测 exe（默认Grancache.exe；主 exe 重打后也可以用它来验）
  const bin = useExe ? path.join(ROOT, process.env.PANEL_EXE || 'Grancache.exe') : NODE;
  const args = useExe ? ['--panel-only'] : [path.join(ROOT, 'src/main.js'), '--panel-only'];
  console.log('被测对象:', bin);
  const child = spawn(bin, args, {
    cwd: ROOT,
    env: { ...process.env, GBF_CACHE_HOME: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  try {
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const r = await req('GET', '/api/status');
        if (r.status === 200) break;
      } catch {
        /* 还没起来 */
      }
    }

    const page = await req('GET', '/');
    check('面板页面可访问（200）', page.status === 200, `status=${page.status}`);
    check('页面里注入了令牌（不是占位符）', /gbf-panel-token" content="[0-9a-f]{32}"/.test(page.text));
    const token = (/gbf-panel-token" content="([0-9a-f]{32})"/.exec(page.text) || [])[1];
    check('拿到令牌', !!token);
    check('页面引用了前端资源', /<script[^>]+src="\.?\/?assets\//.test(page.text), (page.text.match(/src="[^"]+"/) || [''])[0]);

    const assetPath = (/src="\.?\/?(assets\/[^"]+)"/.exec(page.text) || [])[1];
    if (assetPath) {
      const asset = await req('GET', '/' + assetPath);
      check('前端 JS 可加载（text/javascript）', asset.status === 200 && /javascript/.test(String(asset.headers['content-type'])), `${asset.status} ${asset.headers['content-type']} ${asset.text.length}B`);
    }

    const st0 = jsonOf(await req('GET', '/api/status'));
    check('status：面板在跑、代理未启动', st0 && st0.ok && st0.proxy.running === false, JSON.stringify(st0 && st0.proxy));
    check('status：带上了缓存目录等路径', !!(st0 && st0.paths && st0.paths.cacheDir));
    check('status：报告了界面资源来源', !!(st0 && /内联|inline|dist|disk/.test(st0.paths.panelAssets)), st0 && st0.paths.panelAssets);

    const log0 = jsonOf(await req('GET', '/api/log?lines=50'));
    check('log 接口正常', log0 && log0.ok === true && typeof log0.text === 'string');

    const noToken = await req('POST', '/api/action', { body: { action: 'start-proxy' } });
    check('没有令牌的 POST 被拒（403）', noToken.status === 403, `status=${noToken.status}`);
    const badToken = await req('POST', '/api/action', { token: 'deadbeef', body: { action: 'start-proxy' } });
    check('错误令牌的 POST 被拒（403）', badToken.status === 403, `status=${badToken.status}`);
    const badAction = await req('POST', '/api/action', { token, body: { action: 'nope' } });
    check('未知动作被拒（400）', badAction.status === 400, `status=${badAction.status}`);

    const start = await req('POST', '/api/action', { token, body: { action: 'start-proxy' } });
    const startJson = jsonOf(start);
    check('start-proxy 返回 ok', start.status === 200 && startJson && startJson.ok === true, start.text.slice(0, 120));
    const st1 = jsonOf(await req('GET', '/api/status'));
    check('启动后 status 显示运行中', !!(st1 && st1.proxy.running && st1.proxy.pid), JSON.stringify(st1 && st1.proxy.pid));

    const again = jsonOf(await req('POST', '/api/action', { token, body: { action: 'start-proxy' } }));
    check('重复 start 幂等（提示已在运行）', !!(again && again.ok), again && again.message);

    const stop = jsonOf(await req('POST', '/api/action', { token, body: { action: 'stop-proxy' } }));
    check('stop-proxy 返回 ok', !!(stop && stop.ok), stop && stop.message);
    const st2 = jsonOf(await req('GET', '/api/status'));
    check('停止后 status 显示已停止', !!(st2 && st2.proxy.running === false));

    const clear = jsonOf(await req('POST', '/api/action', { token, body: { action: 'clear-cache' } }));
    check('clear-cache 返回 ok', !!(clear && clear.ok), clear && clear.message);

    // 面板是常驻进程，日志单独一份（runtime\logs\panel.log），不会被代理重启时的归档挪走
    const panelLog = path.join(tmp, 'runtime', 'logs', 'panel.log');
    check('面板日志里有 PANEL 记录', fs.existsSync(panelLog) && /PANEL/.test(fs.readFileSync(panelLog, 'utf8')));
    const proxyLog = path.join(tmp, 'runtime', 'logs', 'proxy.log');
    check('代理日志里不掺面板的记录', !fs.existsSync(proxyLog) || !/PANEL/.test(fs.readFileSync(proxyLog, 'utf8')));
  } finally {
    child.kill();
    await sleep(400);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
