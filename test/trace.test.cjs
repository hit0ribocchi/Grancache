'use strict';
/**
 * 结构化追踪（events-*.jsonl）的离线测试。
 * 造 4 种典型情况，然后检查事件字段是否足以识别它们，并跑一遍报告脚本：
 *   1. 第一次未命中（MISS）→ 第二次命中（HIT）      → key 相同、先 MISS 后 HIT
 *   2. 本机有对象但过期了没法命中（missReasons=expired）→ MISS
 *   3. 动态接口不能缓存（cacheable=false, bypassReason=excluded-pattern）→ BYPASS
 *   4. 上游给空响应、不入库（store=skipped, storeReason=empty）→ MISS-NOSTORE
 *
 * 用法: node tools/trace.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
let PROXY_PORT = 0;
let ORIGIN_PORT = 0;

/** 取一个空闲端口，避免固定端口撞车（上次跑挂时端口可能还占着） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = Buffer.alloc(12 * 1024, 7);
const origin = http.createServer((req, res) => {
  if (req.url === '/assets/empty.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
    return res.end();
  }
  if (req.url.startsWith('/rest/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end('{"ok":true}');
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': BODY.length,
    'cache-control': 'public, max-age=31536000',
    etag: '"e1"',
  });
  return res.end(BODY);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-trace-'));

/** 准备临时工作目录（端口确定之后再写 config） */
function prepareHome() {
  fs.mkdirSync(path.join(tmp, 'runtime', 'certs', 'ca'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'runtime', 'certs', 'leaf'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'runtime', 'logs'), { recursive: true });
  for (const f of ['ca.crt', 'ca.key']) fs.copyFileSync(path.join(ROOT, 'runtime', 'certs', 'ca', f), path.join(tmp, 'runtime', 'certs', 'ca', f));
  for (const f of ['localhost.crt', 'localhost.key']) fs.copyFileSync(path.join(ROOT, 'runtime', 'certs', 'leaf', f), path.join(tmp, 'runtime', 'certs', 'leaf', f));

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.listen = { host: '127.0.0.1', port: PROXY_PORT };
  cfg.statsPort = PROXY_PORT + 1;
  cfg.cacheDir = path.join(tmp, 'cache');
  cfg.logFile = path.join(tmp, 'runtime', 'logs', 'proxy.log');
  cfg.traceJsonl = true;
  cfg.keepWarmSeconds = 0;
  cfg.keepWarmHosts = [];
  cfg.prewarmHosts = [];
  cfg.hostAliases = {};
  cfg.upstream = { mode: 'direct', host: '127.0.0.1', port: 0 };
  // 测试绝不碰用户真实的系统代理设置：这里的代理是被直接 kill 的，
  // 没有 --stop 那条还原路径，一旦接管就会把 PAC 留在系统里
  cfg.systemProxy = false;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg, null, 2));
}

/** 手工放一个"已过期"的缓存对象，制造"有对象却没法命中"的情况 */
function plantExpired() {
  const rel = 'http/127.0.0.1/assets/exp.png';
  const abs = path.join(tmp, 'cache', ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(2048, 3));
  fs.writeFileSync(
    abs + '.ext',
    JSON.stringify({
      v: 1,
      url: `http://127.0.0.1:${ORIGIN_PORT}/assets/exp.png`,
      at: Math.floor(Date.now() / 1000),
      size: 2048,
      storedAt: Date.now() - 86400000,
      lastAccess: Date.now() - 86400000,
      expiresAt: Date.now() - 60000,
      ct: 'image/png',
      ce: '',
      headers: { 'content-type': 'image/png' },
    })
  );
}

function proxyGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method: 'GET', path: `http://127.0.0.1:${ORIGIN_PORT}${p}`, headers: { host: `127.0.0.1:${ORIGIN_PORT}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, xg: res.headers['x-gbf-cache'], bytes: Buffer.concat(chunks).length }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  PROXY_PORT = await freePort();
  ORIGIN_PORT = await freePort();
  // 代理会占用 PROXY_PORT + 1 作为统计页端口；别让 mock 源站恰好占在那里
  while (ORIGIN_PORT === PROXY_PORT + 1) ORIGIN_PORT = await freePort();
  prepareHome();
  await new Promise((r) => origin.listen(ORIGIN_PORT, '127.0.0.1', r));
  console.log('临时工作目录:', tmp);
  plantExpired();

  const child = spawn(NODE, [path.join(ROOT, 'src/main.js'), '--serve'], {
    cwd: ROOT,
    env: { ...process.env, GBF_CACHE_HOME: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => (childOut += d));
  child.stderr.on('data', (d) => (childOut += d));

  try {
    // 用 TCP 探活（不要发真实请求，否则会多出一个"从未命中"的对象干扰断言）
    const canConnect = () =>
      new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port: PROXY_PORT });
        const done = (ok) => {
          s.removeAllListeners();
          s.destroy();
          resolve(ok);
        };
        s.setTimeout(400, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
      });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      up = await canConnect();
    }
    if (!up) {
      console.error('代理没起来，子进程输出：\n' + childOut.slice(-1500));
      throw new Error('代理未启动');
    }
    const urlA = '/assets/a.png';
    const r1 = await proxyGet(urlA);
    await sleep(250);
    const r2 = await proxyGet(urlA);
    await proxyGet('/assets/exp.png');
    await proxyGet('/rest/user/data');
    await proxyGet('/assets/empty.png');
    await sleep(500);

    check('第一次 MISS、第二次 HIT', r1.xg === 'MISS' && r2.xg === 'HIT', `${r1.xg} → ${r2.xg}`);

    const files = fs.readdirSync(path.join(tmp, 'runtime', 'logs')).filter((f) => /^events-.*\.jsonl$/.test(f));
    check('生成了结构化事件文件', files.length === 1, files.join(','));
    const file = path.join(tmp, 'runtime', 'logs', files[0]);
    const evts = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const first = evts.find((e) => e.path === urlA && e.outcome === 'MISS');
    const hit = evts.find((e) => e.path === urlA && e.outcome === 'HIT');

    check('事件带对象身份 key', !!(first && first.key && first.key.includes('/assets/a.png')), first && first.key);
    check('MISS 事件记录了入库原因', !!(first && first.store === 'stored' && first.storeReason), first && `${first.store}/${first.storeReason}`);
    check('MISS 与 HIT 的 key 相同（能判定"同一素材第二次命中"）', !!first && !!hit && first.key === hit.key);
    check('事件带请求 id 与时间', !!(first && first.id && first.t));

    const exp = evts.find((e) => e.path === '/assets/exp.png');
    check('过期对象被标记为"有缓存却没命中"', !!(exp && exp.outcome === 'MISS' && (exp.missReasons || []).includes('expired')), exp && JSON.stringify(exp.missReasons));

    const rest = evts.find((e) => e.path.startsWith('/rest/'));
    check('动态接口标为不可缓存 + 原因', !!(rest && rest.cacheable === false && rest.bypassReason === 'excluded-pattern'), rest && rest.bypassReason);

    const empty = evts.find((e) => e.path === '/assets/empty.png');
    check('空响应事件带不入库原因', !!(empty && empty.outcome === 'MISS-NOSTORE' && empty.storeReason === 'empty'), empty && `${empty.outcome}/${empty.storeReason}`);

    const rep = spawnSync(NODE, [path.join(ROOT, 'tools', 'report.cjs'), '--file', file], { encoding: 'utf8' });
    const out = (rep.stdout || '') + (rep.stderr || '');
    check('报告脚本能跑通', rep.status === 0, `exit=${rep.status}`);
    check('报告识别出"先 MISS 后 HIT"', /先 MISS 后 HIT 的对象数\s+1/.test(out), (out.match(/先 MISS 后 HIT.*/) || [''])[0]);
    check('报告识别出"从未命中"与过期原因', /从未命中的对象数\s+1/.test(out) && /expired\s+\d/.test(out));
    check('报告列出不可缓存原因', /excluded-pattern\s+\d/.test(out));

    // ---- 重启后必须"新一轮干净"，且上一轮归档到 runtime\logs\prev ----
    const eventsBefore = fs.readFileSync(file, 'utf8');
    child.kill();
    await sleep(600);
    const child2 = spawn(NODE, [path.join(ROOT, 'src/main.js'), '--serve'], {
      cwd: ROOT,
      env: { ...process.env, GBF_CACHE_HOME: tmp },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      let up2 = false;
      for (let i = 0; i < 40 && !up2; i++) {
        await sleep(250);
        up2 = await new Promise((r) => {
          const s = net.connect({ host: '127.0.0.1', port: PROXY_PORT });
          const done = (ok) => {
            s.removeAllListeners();
            s.destroy();
            r(ok);
          };
          s.setTimeout(400, () => done(false));
          s.once('connect', () => done(true));
          s.once('error', () => done(false));
        });
      }
      await proxyGet('/assets/after-restart.png').catch(() => {});
      await sleep(500);

      const prevDir = path.join(tmp, 'runtime', 'logs', 'prev');
      const prevFiles = fs.existsSync(prevDir) ? fs.readdirSync(prevDir) : [];
      check('重启后：上一轮日志被归档到 logs\\prev', prevFiles.some((f) => /^proxy-.*\.log$/.test(f)) && prevFiles.some((f) => /^events-.*\.jsonl$/.test(f)), prevFiles.join(','));

      const newFile = path.join(tmp, 'runtime', 'logs', fs.readdirSync(path.join(tmp, 'runtime', 'logs')).filter((f) => /^events-.*\.jsonl$/.test(f))[0]);
      const newText = fs.readFileSync(newFile, 'utf8');
      const newEvents = newText.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const newSessions = [...new Set(newEvents.map((e) => e.session))];
      check('新一轮事件文件里没有上一轮的记录', newSessions.length === 1 && !eventsBefore.includes(newSessions[0]), newSessions.join(','));
      check('上一轮的事件内容确实在归档里', (() => {
        const arch = prevFiles.filter((f) => /^events-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(prevDir, f), 'utf8'));
        return arch.some((t) => t.includes(eventsBefore.split('\n').filter(Boolean)[0]));
      })());
    } finally {
      child2.kill();
    }
    console.log('\n---- 报告节选 ----');
    console.log(out.split('\n').slice(0, 30).join('\n'));
  } finally {
    child.kill();
    origin.close();
    await sleep(400);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
