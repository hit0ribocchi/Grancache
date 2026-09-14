'use strict';
/**
 * 端到端验证：启一个本地 mock 源站，让代理去代理它（走明文 HTTP 代理入口）。
 * 用例编号对应 docs/plan-acgpower-cache-mvp.md §6.1 的 21 条。
 *
 * 用法:
 *   node tools/e2e.cjs            # 跑源码版 src/main.js
 *   TARGET=exe node tools/e2e.cjs # 跑打包出来的 exe
 *
 * 全程用临时目录，不碰 D:/gbf-cache，也不碰真实 config.json。
 */
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const PROXY_PORT = 18999;
const ORIGIN_PORT = 19501;
const RAW_PORT = 19502; // 会"说谎"的裸 TCP 源站（截断响应用）

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock 源站 ----------
const BODY = Buffer.alloc(12 * 1024, 7); // 12KB，第一个字节非 0
const BODY_GZ = zlib.gzipSync(Buffer.alloc(9 * 1024, 9));
const originHits = new Map(); // path（含 query）-> 次数
let flakyFirstHit = true;

const origin = http.createServer((req, res) => {
  const p = req.url;
  originHits.set(p, (originHits.get(p) || 0) + 1);
  const wantsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

  if (p === '/assets/flaky.png' && flakyFirstHit) {
    flakyFirstHit = false;
    // 第一次故意不回响应，直接把连接掐掉，模拟"上游长连接半死"
    req.socket.destroy();
    return;
  }
  if (p === '/assets/empty.png') {
    // 200 但空响应：落盘完整性校验里的 'empty' 分支
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000' });
    res.end();
    return;
  }
  if (p === '/rest/down/data') {
    // 动态接口的 5xx：代理必须原样透传（不重试、不拿旧副本顶）
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"error":"down"}');
    return;
  }
  if (p === '/assets/once5xx.png' && (originHits.get(p) || 0) === 1) {
    // 第一次网关错误、第二次成功 → 用来验证单次重试
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('try again');
    return;
  }
  if (p === '/assets/down.png' || p === '/assets/stale.png' || p === '/assets/oldstale.png') {
    // 一直网关错误 → 用来验证 stale-if-error 与它的两条反例
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('upstream down');
    return;
  }
  if (p.startsWith('/rest/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, at: Date.now() }));
    return;
  }
  if (p.startsWith('/assets/') && req.headers['if-none-match'] === '"e1"') {
    // 条件请求：内容没变 → 304（后台 revalidate 会走这条）
    res.writeHead(304, { etag: '"e1"', 'cache-control': 'public, max-age=31536000' });
    res.end();
    return;
  }
  if (p === '/assets/gz.png') {
    if (wantsGzip) {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-encoding': 'gzip',
        'content-length': BODY_GZ.length,
        'cache-control': 'public, max-age=31536000',
        etag: '"gz1"',
      });
      res.end(BODY_GZ);
    } else {
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': BODY.length,
        'cache-control': 'public, max-age=31536000',
        etag: '"gz1"',
      });
      res.end(BODY);
    }
    return;
  }
  if (p.startsWith('/assets/')) {
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': BODY.length,
      'cache-control': 'public, max-age=31536000',
      etag: '"e1"',
      'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
    });
    res.end(BODY);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('nope');
});

// 裸 TCP 源站：声明 4096 字节却只发 1024 字节就停住（模拟半截响应）
const rawOrigin = net.createServer((socket) => {
  socket.on('data', () => {
    socket.write(
      'HTTP/1.1 200 OK\r\n' +
        'content-type: image/png\r\n' +
        'content-length: 4096\r\n' +
        'cache-control: public, max-age=31536000\r\n' +
        '\r\n'
    );
    socket.write(Buffer.alloc(1024, 5));
    setTimeout(() => socket.destroy(), 1200);
  });
});

// ---------- 准备临时工作目录 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-e2e-'));
const CACHE = path.join(tmp, 'cache');
fs.mkdirSync(path.join(tmp, 'runtime', 'certs', 'ca'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'runtime', 'certs', 'leaf'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'runtime', 'logs'), { recursive: true });
for (const f of ['ca.crt', 'ca.key']) {
  fs.copyFileSync(path.join(PROJECT, 'runtime', 'certs', 'ca', f), path.join(tmp, 'runtime', 'certs', 'ca', f));
}
for (const f of ['localhost.crt', 'localhost.key']) {
  fs.copyFileSync(path.join(PROJECT, 'runtime', 'certs', 'leaf', f), path.join(tmp, 'runtime', 'certs', 'leaf', f));
}
fs.writeFileSync(
  path.join(tmp, 'config.json'),
  JSON.stringify(
    {
      listen: { host: '127.0.0.1', port: PROXY_PORT },
      statsPort: PROXY_PORT + 1,
      cacheDir: CACHE,
      maxCacheGB: 1,
      maxObjectMB: 8,
      verifyIntegrity: false,
      browserMaxAgeSeconds: 300,
      aliasBrowserMaxAgeSeconds: 604800,
      cacheKeyStripQueryParams: ['_', 't', 'uid'],
      cacheHostFallback: 'fallback.test',
      queryDirPrefix: '__q_',
      overrideEnable: true,
      optionsPreflightEnable: true,
      optionsPreflightMaxAge: 604360,
      logMinLevel: 'DEBUG',
      // 本轮新增的残留风险修复开关（测试里把窗口/周期调小以便观察）
      staleIfErrorSeconds: 60,
      retryOn5xx: true,
      retry5xxDelayMs: 50,
      inactiveDays: 0,
      rescanCheckSeconds: 2,
      expireMode: 'immortal',
      revalidateAfterSeconds: 0,
      minMaxAge: 3600,
      fallbackTtlSeconds: 2592000,
      aggressiveAssetCache: true,
      // 把 mock 源站的 IP 当"素材主机"，这样 OPTIONS 预检 / 素材策略都会被走到
      assetHostPatterns: ['127.0.0.1'],
      neverCacheContentTypes: ['text/html'],
      assetExtensions: ['png', 'jpg', 'webp'],
      excludePatterns: ['/rest/', '/api/'],
      passthroughHosts: [],
      insecureUpstream: false,
      // alias.test 会被改写到 127.0.0.1（端口不变），用来验证"已死别名域名"的长浏览器缓存
      hostAliases: { 'alias.test': '127.0.0.1' },
      apiDumpPatterns: [],
      keepWarmSeconds: 0,
      keepWarmHosts: [],
      blockHostPatterns: [],
      upstream: { mode: 'direct', host: '127.0.0.1', port: 0 },
      prewarmHosts: [],
      logFile: path.join(tmp, 'runtime', 'logs', 'proxy.log'),
      logMaxMB: 4,
      logConsole: true,
      logRequests: true,
      printStatsEverySeconds: 9999,
    },
    null,
    2
  )
);

// ---------- 工具 ----------
function proxyRequest(method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: '127.0.0.1', port: PROXY_PORT, method, path: url, headers: { host: u.host, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        // 上游响应被截断时，Node 把错误发在 response 上（不是 request 上），
        // 不接住的话 Promise 永远不 settle（第一版就踩了这个坑）
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('aborted')));
      }
    );
    req.on('error', reject);
    req.end();
  });
}
const proxyGet = (url, headers) => proxyRequest('GET', url, headers);

function stats() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PROXY_PORT + 1, path: '/stats' }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(JSON.parse(b)));
      })
      .on('error', reject);
  });
}

// 每次重启代理都会把上一轮日志归档到 runtime\logs\prev\，所以"整个测试跑过的日志" = 当前 + 归档
const logText = () => {
  const dir = path.join(tmp, 'runtime', 'logs');
  let out = '';
  try {
    out += fs.readFileSync(path.join(dir, 'proxy.log'), 'utf8') + '\n';
  } catch {
    /* 还没写 */
  }
  try {
    for (const f of fs.readdirSync(path.join(dir, 'prev'))) {
      if (!/^proxy-.*\.log$/.test(f)) continue; // events-*.jsonl 也要留着给报告用，但不算"日志行"
      out += fs.readFileSync(path.join(dir, 'prev', f), 'utf8') + '\n';
    }
  } catch {
    /* 还没归档 */
  }
  return out;
};
// 本测试走的是明文 HTTP 代理入口（http://...），所以磁盘上的 scheme 目录是 http/。
// 真实 GBF 流量是 MITM 解开的 https，目录会是 https/ —— 两者在代码里同一条路径规则。
const SCHEME = 'http';
const rel = (p) => `${SCHEME}/${p}`;
const diskPath = (relPath) => path.join(CACHE, ...relPath.split('/'));
const exists = (relPath) => fs.existsSync(diskPath(relPath));

/** 手工在缓存目录里放一个对象（模拟导入 ACGPower 缓存包 / 别人的分片） */
function plantObject(rel, bodyBuf, meta = {}) {
  const abs = diskPath(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bodyBuf);
  fs.writeFileSync(
    abs + '.ext',
    JSON.stringify({
      v: 1,
      url: meta.url || 'https://planted.test/' + rel,
      at: Math.floor(Date.now() / 1000),
      size: bodyBuf.length,
      storedAt: meta.storedAt || Date.now(),
      lastAccess: meta.lastAccess || Date.now(),
      expiresAt: meta.expiresAt || 0,
      revalidateAt: 0,
      ct: meta.ct || 'image/png',
      ce: meta.ce || '',
      headers: meta.headers || { 'content-type': meta.ct || 'image/png' },
    })
  );
  return abs;
}

// ---------- 启动 / 重启代理 ----------
const useExe = process.env.TARGET === 'exe';
const bin = useExe ? path.join(PROJECT, 'Grancache.exe') : NODE;
const binArgs = useExe ? ['--serve'] : [path.join(PROJECT, 'src/main.js'), '--serve'];
let child = null;
let out = '';
let childExited = null;

function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      s.removeAllListeners();
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function startProxy() {
  childExited = null;
  child = spawn(bin, binArgs, { env: { ...process.env, GBF_CACHE_HOME: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('exit', (code) => (childExited = code));
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (childExited !== null) throw new Error(`代理子进程提前退出（code=${childExited}）`);
    try {
      await stats();
      return;
    } catch {
      /* 还没起来 */
    }
  }
  throw new Error('代理没起来');
}

async function stopProxy() {
  if (!child) return;
  child.kill();
  child = null;
  // Windows 上端口不是立刻释放的：等它真的关掉，否则下一次 startProxy 会因为
  // EADDRINUSE 起不来，而测试还以为在跟新进程说话（这会掩盖真实问题）
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!(await isPortOpen(PROXY_PORT))) return;
  }
  throw new Error('代理端口在 10 秒内没有释放');
}

(async () => {
  await new Promise((r) => origin.listen(ORIGIN_PORT, '127.0.0.1', r));
  await new Promise((r) => rawOrigin.listen(RAW_PORT, '127.0.0.1', r));
  console.log('mock 源站:', ORIGIN_PORT, ' 裸源站:', RAW_PORT, ' 临时工作目录:', tmp);
  console.log('被测对象:', bin);
  await startProxy();

  const O = `http://127.0.0.1:${ORIGIN_PORT}`;
  const urlA = `${O}/assets/a.png`;

  try {
    // ---- 用例 1：MISS → HIT ----
    const r1 = await proxyGet(urlA);
    check('用例1 第一次 200', r1.status === 200, `status=${r1.status}`);
    check('用例1 第一次是 MISS', r1.headers['x-gbf-cache'] === 'MISS', `x-gbf-cache=${r1.headers['x-gbf-cache']}`);
    check('用例1 响应体完整', r1.body.equals(BODY), `${r1.body.length}/${BODY.length}`);
    await sleep(250); // 落盘是"先回浏览器、后写盘"的异步过程
    const r2 = await proxyGet(urlA);
    check('用例1 第二次是 HIT', r2.headers['x-gbf-cache'] === 'HIT', `x-gbf-cache=${r2.headers['x-gbf-cache']}`);
    check('用例1 命中带 age 头', typeof r2.headers['x-gbf-cache-age'] === 'string');
    check('用例1 HIT 响应体一致', r2.body.equals(BODY));
    check('用例1 HIT 不再回源', originHits.get('/assets/a.png') === 1, `originHits=${originHits.get('/assets/a.png')}`);

    // ---- 用例 2：路径镜像布局 ----
    check('用例2 落在 <scheme>/<host>/assets/a.png', exists(rel('127.0.0.1/assets/a.png')));
    check('用例2 有同名 .ext', exists(rel('127.0.0.1/assets/a.png.ext')));
    check('用例2 没有再建 objects/ 布局', !fs.existsSync(path.join(CACHE, 'objects')));

    // ---- 用例 3：.ext 字段 ----
    const ext = JSON.parse(fs.readFileSync(diskPath(rel('127.0.0.1/assets/a.png.ext')), 'utf8'));
    check(
      '用例3 .ext 有 v/url/ct/size/at',
      ext.v === 1 && ext.url === urlA && ext.ct === 'image/png' && ext.size === BODY.length && typeof ext.at === 'number',
      JSON.stringify({ v: ext.v, ct: ext.ct, size: ext.size, at: ext.at })
    );
    check('用例3 .ext 保留完整响应头（含 etag）', ext.headers && ext.headers.etag === '"e1"');

    // ---- 用例 4 + 16：单编码桶 + HIT 必须回放 content-encoding ----
    const urlGz = `${O}/assets/gz.png`;
    const g1 = await proxyGet(urlGz, { 'accept-encoding': 'gzip' });
    check('用例4 gzip 客户端第一次 MISS', g1.headers['x-gbf-cache'] === 'MISS');
    check('用例4 gzip 响应带 content-encoding', g1.headers['content-encoding'] === 'gzip');
    await sleep(250);
    const g2 = await proxyGet(urlGz, { 'accept-encoding': 'gzip, deflate, br, zstd' });
    check('用例4 客户端 AE 串不同仍命中同一份（单桶）', g2.headers['x-gbf-cache'] === 'HIT', `x-gbf-cache=${g2.headers['x-gbf-cache']}`);
    check('用例16 HIT 回放了 content-encoding: gzip', g2.headers['content-encoding'] === 'gzip');
    check('用例16 HIT 字节与 gzip 原文一致', g2.body.equals(BODY_GZ), `${g2.body.length}/${BODY_GZ.length}`);
    const g3 = await proxyGet(urlGz, { 'accept-encoding': 'identity' });
    check('用例4 不认 gzip 的客户端不回放 gzip 体', !g3.headers['content-encoding'] && g3.body.equals(BODY), `ce=${g3.headers['content-encoding']}`);
    await sleep(250);
    const g4 = await proxyGet(urlGz, { 'accept-encoding': 'gzip' });
    check('用例4 identity 那份可以被 gzip 客户端复用', g4.headers['x-gbf-cache'] === 'HIT' && g4.body.equals(BODY));

    // ---- 用例 5：/rest/ 透传 ----
    const restUrl = `${O}/rest/user/data`;
    const b1 = await proxyGet(restUrl);
    check('用例5 /rest/ 走透传', b1.headers['x-gbf-cache'] === 'BYPASS', `x-gbf-cache=${b1.headers['x-gbf-cache']}`);
    const b2 = await proxyGet(restUrl);
    check('用例5 /rest/ 第二次仍不缓存', b2.headers['x-gbf-cache'] === 'BYPASS');
    check('用例5 /rest/ 没落盘', !exists(rel('127.0.0.1/rest/user/data')));

    // ---- 用例 6：上游掐断自动重试（回归）----
    const urlFlaky = `${O}/assets/flaky.png`;
    const f1 = await proxyGet(urlFlaky);
    check('用例6 被掐断的连接能自动重试成功', f1.status === 200, `status=${f1.status} cache=${f1.headers['x-gbf-cache']}`);
    check('用例6 重试后能正常入库', f1.headers['x-gbf-cache'] === 'MISS');
    await sleep(250);
    const f2 = await proxyGet(urlFlaky);
    check('用例6 下次可命中', f2.headers['x-gbf-cache'] === 'HIT');
    check('用例6 日志里有 RETRY-STALE', /WARN RETRY-STALE/.test(logText()), (logText().match(/.*RETRY-STALE.*/) || [''])[0]);

    // ---- 用例 7 + 20 + 17：魔改层 ----
    const ovAbs = plantObject(rel('127.0.0.1/assets/ov_ap.png'), Buffer.from('MODDED-BYTES'));
    const o1 = await proxyGet(`${O}/assets/ov.png`);
    check('用例7 魔改文件命中 OVERRIDE', o1.headers['x-gbf-cache'] === 'OVERRIDE', `x-gbf-cache=${o1.headers['x-gbf-cache']}`);
    check('用例7 返回的是魔改内容', o1.body.toString() === 'MODDED-BYTES', o1.body.toString());
    check('用例7 Content-Type 按扩展名表给出', o1.headers['content-type'] === 'image/png', o1.headers['content-type']);
    check('用例20 OVERRIDE 带 cache-control: no-cache', o1.headers['cache-control'] === 'no-cache', o1.headers['cache-control']);
    check('用例20 OVERRIDE 带 ap- 前缀 etag', /^"ap-\d+-\d+"$/.test(String(o1.headers.etag)), String(o1.headers.etag));
    const o2 = await proxyGet(`${O}/assets/ov.png`, { 'if-none-match': o1.headers.etag });
    check('用例20 带同一 etag 的第二次请求得 304', o2.status === 304, `status=${o2.status}`);
    check('用例7 魔改不落 .ext（plant 的 .ext 被我们删掉后仍能命中）', fs.existsSync(ovAbs));
    check('用例18 魔改文件不在缓存索引里', (await stats()).cache.objects >= 1 && !logText().includes('_ap.png.ext 载入'), '魔改 .ext 不进索引');

    // 用例 17：魔改 + gzip：ce 必须被回放，字节原样发出
    plantObject(rel('127.0.0.1/assets/gzov_ap.png'), BODY_GZ, {
      ce: 'gzip',
      ct: 'image/png',
      headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' },
    });
    const og = await proxyGet(`${O}/assets/gzov.png`, { 'accept-encoding': 'gzip' });
    check('用例17 gzip 魔改包命中 OVERRIDE', og.headers['x-gbf-cache'] === 'OVERRIDE');
    check('用例17 gzip 魔改包回放 content-encoding', og.headers['content-encoding'] === 'gzip');
    check('用例17 gzip 魔改包字节原样返回', og.body.equals(BODY_GZ));

    // ---- 用例 8：OPTIONS 预检本地应答 ----
    const pre = await proxyRequest('OPTIONS', `${O}/assets/opt.png`, { origin: 'https://game.granbluefantasy.jp' });
    check('用例8 OPTIONS 返回 200', pre.status === 200, `status=${pre.status}`);
    check('用例8 标记 OPTIONS-HIT', pre.headers['x-gbf-cache'] === 'OPTIONS-HIT', `x-gbf-cache=${pre.headers['x-gbf-cache']}`);
    check('用例8 带 ACAO/ACAH/ACAM: *', pre.headers['access-control-allow-origin'] === '*' && pre.headers['access-control-allow-headers'] === '*' && pre.headers['access-control-allow-methods'] === '*');
    check('用例8 max-age=604360', pre.headers['cache-control'] === 'public, max-age=604360', pre.headers['cache-control']);
    check('用例8 没有回源', !originHits.has('/assets/opt.png'), `originHits=${originHits.get('/assets/opt.png')}`);
    const preRest = await proxyRequest('OPTIONS', `${O}/rest/user/data`);
    check('用例8 API 路径的预检照常回源（不接管）', originHits.get('/rest/user/data') >= 3, `originHits=${originHits.get('/rest/user/data')}`);

    // ---- 用例 9：半截响应不入库；空响应不入库（MISS-NOSTORE）----
    const urlRaw = `http://127.0.0.1:${RAW_PORT}/trunc.png`;
    let rawFailed = false;
    let rawBodyLen = -1;
    try {
      const rr = await proxyGet(urlRaw);
      rawBodyLen = rr.body.length;
    } catch {
      rawFailed = true;
    }
    await sleep(300);
    check('用例9 半截响应不落盘', !exists('http/127.0.0.1/trunc.png'), fs.existsSync(diskPath('http/127.0.0.1/trunc.png')) ? '文件居然存在' : '');
    check(
      '用例9 半截响应不会伪装成完整对象（客户端拿到错误或不足量字节）',
      rawFailed || rawBodyLen < 4096,
      `clientError=${rawFailed} bodyLen=${rawBodyLen}`
    );
    check('用例9 代理把这次截断记成 ERROR 级 UPSTREAM-STREAM-ERROR', /ERROR UPSTREAM-STREAM-ERROR/.test(logText()), (logText().match(/.*UPSTREAM-STREAM-ERROR.*/) || [''])[0]);
    const urlEmpty = `${O}/assets/empty.png`;
    const e1 = await proxyGet(urlEmpty);
    check('用例9 空响应仍是 200', e1.status === 200);
    await sleep(250);
    check('用例9 空响应不入库', !exists(rel('127.0.0.1/assets/empty.png')));
    check('用例9 日志里记了 MISS-NOSTORE + 级别 WARN', /WARN MISS-NOSTORE .*\(empty\)/.test(logText()), (logText().match(/.*MISS-NOSTORE.*/) || [''])[0]);
    check('用例9 统计里回源未入库计数 > 0', (await stats()).missNoStore > 0);

    // ---- 用例 10：全零对象被当未命中并删除 ----
    const urlZ = `${O}/assets/z.png`;
    await proxyGet(urlZ);
    await sleep(250);
    const zAbs = diskPath(rel('127.0.0.1/assets/z.png'));
    fs.writeFileSync(zAbs, Buffer.alloc(BODY.length, 0)); // 手工写坏
    const hitsBefore = originHits.get('/assets/z.png');
    const z1 = await proxyGet(urlZ);
    check('用例10 全零对象按 MISS 回源', z1.headers['x-gbf-cache'] === 'MISS', `x-gbf-cache=${z1.headers['x-gbf-cache']}`);
    check('用例10 回源拿到的是真内容', z1.body.equals(BODY));
    check('用例10 回源次数 +1', originHits.get('/assets/z.png') === hitsBefore + 1);
    await sleep(250);
    check('用例10 坏对象被重写回正常内容', fs.readFileSync(zAbs).equals(BODY));

    // 未命中要分得清两类：本机没有（首次） vs 本机有对象却用不了（缓存没生效）
    const stZ = await stats();
    const zRec = (stZ.missObjects || []).find((o) => o.key === rel('127.0.0.1/assets/z.png'));
    check('用例10 统计区分出「有缓存却未命中」', stZ.missCached >= 1, `missCached=${stZ.missCached}`);
    check('用例10 记录了未命中对象与原因', !!zRec && zRec.cached >= 1 && zRec.reason === 'all-zero',
      zRec ? `cached=${zRec.cached}/first=${zRec.first}/${zRec.reason}` : '缺记录');
    check('用例10 首次未命中单独计数', stZ.missFirst >= 1, `missFirst=${stZ.missFirst}`);

    // ---- 用例 11：版本 query 目录化，互不覆盖 ----
    const vq1 = await proxyGet(`${O}/assets/v.png?v=1`);
    const vq2 = await proxyGet(`${O}/assets/v.png?v=2`);
    check('用例11 v=1 首次 MISS', vq1.headers['x-gbf-cache'] === 'MISS');
    check('用例11 v=2 首次 MISS（不同对象）', vq2.headers['x-gbf-cache'] === 'MISS');
    await sleep(250);
    check('用例11 v=1 目录存在', exists(rel('127.0.0.1/assets/__q_v=1/v.png')));
    check('用例11 v=2 目录存在', exists(rel('127.0.0.1/assets/__q_v=2/v.png')));
    const vq1b = await proxyGet(`${O}/assets/v.png?v=1`);
    const vq2b = await proxyGet(`${O}/assets/v.png?v=2`);
    check('用例11 v=1 命中', vq1b.headers['x-gbf-cache'] === 'HIT');
    check('用例11 v=2 命中', vq2b.headers['x-gbf-cache'] === 'HIT');

    // ---- 用例 15：非白名单主机也剥掉 ?t=/?uid=（aggressiveAssetCache 路径）----
    const urlQ = `http://localhost:${ORIGIN_PORT}/assets/q.png?t=1&uid=2`;
    const q1 = await proxyGet(urlQ);
    check('用例15 非白名单主机首次 MISS', q1.headers['x-gbf-cache'] === 'MISS', `x-gbf-cache=${q1.headers['x-gbf-cache']}`);
    await sleep(250);
    check('用例15 落盘路径不含 query 参数', exists(rel('localhost/assets/q.png')));
    const q2 = await proxyGet(urlQ);
    check('用例15 第二次 HIT', q2.headers['x-gbf-cache'] === 'HIT');
    const q3 = await proxyGet(`http://localhost:${ORIGIN_PORT}/assets/q.png?t=999&uid=888`);
    check('用例15 换一组时间戳参数仍命中同一份', q3.headers['x-gbf-cache'] === 'HIT');

    // ---- 用例 19：主机回退（ACGPower 包没有 host 层）----
    plantObject(rel('fallback.test/assets/fb.png'), Buffer.from('FROM-FALLBACK-HOST'));
    const fb1 = await proxyGet(`${O}/assets/fb.png`);
    check('用例19 只存在于回退主机目录的对象也能命中', fb1.headers['x-gbf-cache'] === 'HIT' && fb1.body.toString() === 'FROM-FALLBACK-HOST', `x-gbf-cache=${fb1.headers['x-gbf-cache']}`);

    // ---- 用例 21：版本 query 回退（导入包丢 query 的布局）----
    plantObject(rel('127.0.0.1/assets/nq.png'), Buffer.from('NO-QUERY-COPY'));
    const nq1 = await proxyGet(`${O}/assets/nq.png?v=9`);
    check('用例21 只有无 query 的对象时带版本参数也能命中', nq1.headers['x-gbf-cache'] === 'HIT' && nq1.body.toString() === 'NO-QUERY-COPY', `x-gbf-cache=${nq1.headers['x-gbf-cache']}`);

    // ---- 用例 13：重启后索引从 .ext 重建 ----
    // ---- 用例 22：网关错误单次重试 ----
    // ---- 用例 27/28/29：HEAD、命中 304、PAC 这三条浏览器真实路径 ----
    const headResp = await proxyRequest('HEAD', urlA);
    check(
      '用例27 HEAD 命中返回 200 且无响应体',
      headResp.status === 200 && headResp.body.length === 0 && headResp.headers['x-gbf-cache'] === 'HIT',
      `status=${headResp.status} len=${headResp.body.length} cache=${headResp.headers['x-gbf-cache']}`
    );
    const imResp = await proxyGet(urlA, { 'if-none-match': '"e1"' });
    check('用例28 带 If-None-Match 命中同一 ETag 得 304', imResp.status === 304, `status=${imResp.status}`);
    const pacResp = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: PROXY_PORT + 1, path: '/proxy.pac' }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        })
        .on('error', reject);
    });
    check(
      '用例29 PAC 可下发且指向本代理端口',
      pacResp.status === 200 &&
        /FindProxyForURL/.test(pacResp.body) &&
        pacResp.body.includes(`127.0.0.1:${PROXY_PORT}`) &&
        /granbluefantasy\.jp/.test(pacResp.body),
      `status=${pacResp.status} len=${pacResp.body.length}`
    );

    const r5 = await proxyGet(`${O}/assets/once5xx.png`);
    check(
      '用例22 502/503/504 会自动重试一次并成功',
      r5.status === 200 && r5.headers['x-gbf-cache'] === 'MISS',
      `status=${r5.status} cache=${r5.headers['x-gbf-cache']}`
    );
    check('用例22 源站确实被打了两次', originHits.get('/assets/once5xx.png') === 2, `hits=${originHits.get('/assets/once5xx.png')}`);
    check('用例22 日志记录了 RETRY-5XX（WARN）', /WARN RETRY-5XX/.test(logText()), (logText().match(/.*RETRY-5XX.*/) || [''])[0]);

    // ---- 用例 23：stale-if-error —— 过期旧副本顶一次（RFC 5861）----
    plantObject(rel('127.0.0.1/assets/stale.png'), Buffer.from('STALE-COPY'), {
      expiresAt: Date.now() - 5000,
      storedAt: Date.now() - 3600 * 1000,
      headers: { 'content-type': 'image/png' },
    });
    const st1 = await proxyGet(`${O}/assets/stale.png`);
    check('用例23 上游 503 时用旧副本顶', st1.headers['x-gbf-cache'] === 'STALE', `x-gbf-cache=${st1.headers['x-gbf-cache']}`);
    check('用例23 返回的是旧副本内容', st1.body.toString() === 'STALE-COPY', st1.body.toString());
    check(
      '用例23 带 Age 与陈旧标记（RFC 9111 已废弃 Warning，用 Age + 诊断头）',
      st1.headers.age !== undefined && /stale=\d+s/.test(String(st1.headers['x-gbf-cache-stale'])),
      `age=${st1.headers.age} stale=${st1.headers['x-gbf-cache-stale']}`
    );
    check('用例23 cache-control: no-cache（不把旧内容钉在浏览器里）', st1.headers['cache-control'] === 'no-cache', st1.headers['cache-control']);
    check('用例23 先试了两次上游才用旧副本', originHits.get('/assets/stale.png') === 2, `hits=${originHits.get('/assets/stale.png')}`);
    check('用例23 日志记录 STALE（WARN）', /WARN STALE /.test(logText()), (logText().match(/.*STALE .*/) || [''])[0]);

    // ---- 用例 24（反例）：损坏的过期对象绝不能被当旧副本发出去 ----
    const downAbs = plantObject(rel('127.0.0.1/assets/down.png'), Buffer.from('GOOD-COPY'), { expiresAt: Date.now() - 5000 });
    fs.writeFileSync(downAbs, Buffer.alloc(3, 1)); // 截断成坏对象
    const st2 = await proxyGet(`${O}/assets/down.png`);
    check('用例24 损坏对象不会被 stale 掩盖（回 ERROR）', st2.headers['x-gbf-cache'] === 'ERROR', `x-gbf-cache=${st2.headers['x-gbf-cache']}`);
    await sleep(200);
    check('用例24 损坏对象同时被删掉', !fs.existsSync(downAbs));

    // ---- 用例 24b（反例）：超出 stale 窗口不给旧副本 ----
    plantObject(rel('127.0.0.1/assets/oldstale.png'), Buffer.from('TOO-OLD'), { expiresAt: Date.now() - 300 * 1000 });
    const st3 = await proxyGet(`${O}/assets/oldstale.png`);
    check('用例24b 超出窗口（>60s）的旧副本不顶', st3.headers['x-gbf-cache'] === 'ERROR', `x-gbf-cache=${st3.headers['x-gbf-cache']}`);

    // ---- 用例 24c（反例）：上游健康时，过期对象照旧重取 ----
    plantObject(rel('127.0.0.1/assets/renew.png'), Buffer.from('OLD-COPY'), { expiresAt: Date.now() - 5000 });
    const rn = await proxyGet(`${O}/assets/renew.png`);
    check(
      '用例24c 上游健康时过期对象照旧重取（不拿旧的）',
      rn.headers['x-gbf-cache'] === 'MISS' && rn.body.equals(BODY),
      `x-gbf-cache=${rn.headers['x-gbf-cache']} len=${rn.body.length}`
    );

    // ---- 用例 25：导入哨兵触发后台重扫（不用重启、不用等第一次刷新）----
    const preimportRel = rel('127.0.0.1/assets/preimport.png');
    plantObject(preimportRel, Buffer.from('FROM-IMPORT'));
    const objectsBeforeRescan = (await stats()).cache.objects;
    fs.writeFileSync(path.join(CACHE, '.gbf-rescan-request'), String(Date.now()));
    let rescanned = false;
    for (let i = 0; i < 20 && !rescanned; i++) {
      await sleep(500);
      if (/后台重扫完成/.test(logText())) rescanned = true;
    }
    check('用例25 哨兵触发后台重扫并写进日志', rescanned, (logText().match(/.*后台重扫完成.*/) || [''])[0]);
    check(
      '用例25 重扫后索引里多了导入的对象',
      (await stats()).cache.objects > objectsBeforeRescan,
      `before=${objectsBeforeRescan} after=${(await stats()).cache.objects}`
    );
    const pi = await proxyGet(`${O}/assets/preimport.png`);
    check(
      '用例25 重扫后直接命中、没回源',
      pi.headers['x-gbf-cache'] === 'HIT' && pi.body.toString() === 'FROM-IMPORT' && !originHits.has('/assets/preimport.png'),
      `x-gbf-cache=${pi.headers['x-gbf-cache']} hits=${originHits.get('/assets/preimport.png')}`
    );

    // ---- 用例 26（回归）：动态接口的 5xx 照旧原样透传 ----
    const dynDown = await proxyGet(`${O}/rest/down/data`);
    check(
      '用例26 动态接口 5xx 原样透传（不重试、不顶旧副本）',
      dynDown.status === 503 && dynDown.headers['x-gbf-cache'] === 'BYPASS' && originHits.get('/rest/down/data') === 1,
      `status=${dynDown.status} cache=${dynDown.headers['x-gbf-cache']} hits=${originHits.get('/rest/down/data')}`
    );

    // ---- 用例 13：重启后索引从 .ext 重建 ----
    // ---- 用例 32：已死别名域名（a1~a5 这类）的素材给浏览器长缓存 ----
    // 理由：这些域名 DNS 已经没了，代理一停浏览器直连必失败；只有浏览器自己那份副本还能显示图片。
    const aliasUrl = `http://alias.test:${ORIGIN_PORT}/assets/alias.png`;
    const al1 = await proxyGet(aliasUrl);
    check(
      '用例32 别名主机请求改写后仍能取到',
      al1.status === 200 && al1.headers['x-gbf-cache'] === 'MISS',
      `status=${al1.status} cache=${al1.headers['x-gbf-cache']}`
    );
    check('用例32 别名主机素材给浏览器长缓存（7 天）', al1.headers['cache-control'] === 'public, max-age=604800', al1.headers['cache-control']);
    await sleep(250);
    const al2 = await proxyGet(aliasUrl);
    check(
      '用例32 二次命中且依然长缓存',
      al2.headers['x-gbf-cache'] === 'HIT' && al2.headers['cache-control'] === 'public, max-age=604800',
      `${al2.headers['x-gbf-cache']} / ${al2.headers['cache-control']}`
    );
    const normalHit = await proxyGet(urlA);
    check(
      '用例32 普通主机素材仍是短缓存（没被牵连）',
      normalHit.headers['x-gbf-cache'] === 'HIT' && normalHit.headers['cache-control'] === 'public, max-age=300',
      `${normalHit.headers['x-gbf-cache']} / ${normalHit.headers['cache-control']}`
    );

    const stBefore = await stats();
    check(
      '统计（重启前）：旧副本顶过 1 次、错误计数 > 0',
      stBefore.stale >= 1 && stBefore.errors >= 1,
      JSON.stringify({ stale: stBefore.stale, errors: stBefore.errors })
    );
    check(
      '统计（重启前）：魔改 / 预检 / 回源未入库计数都 > 0',
      stBefore.overrides > 0 && stBefore.preflights > 0 && stBefore.missNoStore > 0,
      JSON.stringify({ overrides: stBefore.overrides, preflights: stBefore.preflights, missNoStore: stBefore.missNoStore })
    );
    check('统计（重启前）：磁盘上导入的对象被按需接管', stBefore.cache.adopted >= 2, `adopted=${stBefore.cache.adopted}`);
    await stopProxy();
    await startProxy();
    const afterRestart = await proxyGet(urlA);
    check('用例13 重启后仍能命中', afterRestart.headers['x-gbf-cache'] === 'HIT', `x-gbf-cache=${afterRestart.headers['x-gbf-cache']}`);
    check('用例13 重启后对象数一致', (await stats()).cache.objects === stBefore.cache.objects, `${(await stats()).cache.objects} vs ${stBefore.cache.objects}`);

    // ---- 用例 14：--clear-cache（真数据在 host 目录里，旧版会清不掉）----
    await new Promise((resolve) => {
      const p = spawn(bin, useExe ? ['--clear-cache'] : [path.join(PROJECT, 'src/main.js'), '--clear-cache'], {
        env: { ...process.env, GBF_CACHE_HOME: tmp },
        stdio: 'ignore',
      });
      p.on('exit', resolve);
    });
    const leftovers = fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : [];
    // 只数"缓存对象"：`_ap` 魔改文件是被刻意保留的，不算在内
    const cacheFileCount = (d) => {
      let n = 0;
      const walk = (x) => {
        if (!fs.existsSync(x)) return;
        for (const e of fs.readdirSync(x, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(x, e.name));
          else if (!/_ap\.[A-Za-z0-9]{1,8}(?:\.ext)?$/i.test(e.name)) n++;
        }
      };
      walk(d);
      return n;
    };
    check('用例14 --clear-cache 清掉了缓存对象', cacheFileCount(CACHE) === 0, `files=${cacheFileCount(CACHE)} leftovers=${JSON.stringify(leftovers)}`);
    check('用例14 魔改文件被保留（清缓存不删手工放的东西）', fs.existsSync(ovAbs));
    // 运行中的代理索引里还有旧条目：读文件失败 → 删对象 → 按 MISS 处理
    const afterClear = await proxyGet(urlA);
    check('用例14 清空后下次请求按 MISS 重新入库', afterClear.headers['x-gbf-cache'] === 'MISS', `x-gbf-cache=${afterClear.headers['x-gbf-cache']}`);
    await sleep(250);
    check('用例14 代理能继续正常写入', exists(rel('127.0.0.1/assets/a.png')));

    // ---- 统计与日志 ----
    // ---- 用例 7b：overrideEnable=false 时魔改层整体关掉 ----
    await stopProxy();
    const cfgPath = path.join(tmp, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.overrideEnable = false;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    await startProxy();
    const ovOff = await proxyGet(`${O}/assets/ov.png`);
    check(
      '用例7b 关掉 overrideEnable 后不再返回 OVERRIDE（走普通缓存/回源）',
      ovOff.headers['x-gbf-cache'] !== 'OVERRIDE' && ovOff.body.equals(BODY),
      `x-gbf-cache=${ovOff.headers['x-gbf-cache']} body=${ovOff.body.length}`
    );
    check('用例7b 魔改文件本身不会被改动', fs.existsSync(ovAbs));
    cfg.overrideEnable = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    // 重启后的新进程索引是空的：磁盘上已有的对象应被按需接管
    await proxyGet(urlA);
    const aAdopted = await proxyGet(urlA);
    check('用例13b 新进程能接管磁盘上已有的对象', aAdopted.headers['x-gbf-cache'] === 'HIT', `x-gbf-cache=${aAdopted.headers['x-gbf-cache']}`);

    const st = await stats();
    console.log('   统计:', JSON.stringify({ req: st.requests, hit: st.hits, miss: st.misses, bypass: st.bypass, stored: st.stored, overrides: st.overrides, preflights: st.preflights, missNoStore: st.missNoStore, errors: st.errors, cache: st.cache }));
    check('统计：命中数 > 0', st.hits > 0, `hits=${st.hits}`);
    check('统计：进程重启后计数器归零（per-process 语义）', st.overrides === 0 && st.preflights === 0, JSON.stringify({ overrides: st.overrides, preflights: st.preflights }));
    check('统计：verifyIntegrity=false（默认不校验哈希）', st.cache.verifyIntegrity === false);
    check('统计：布局标记为 path-mirror', st.cache.layout === 'path-mirror');
    check('统计：上游错误数在合理范围（<=5）', st.errors <= 5, `errors=${st.errors}`);

    const log = logText();
    check('日志：每行都有级别标记', log.split('\n').filter(Boolean).every((l) => / (DEBUG|INFO|WARN|ERROR) /.test(l)));
    check('日志：INFO HIT', /INFO HIT /.test(log));
    check('日志：INFO OVERRIDE', /INFO OVERRIDE /.test(log));
    check('日志：INFO OPTIONS-HIT', /INFO OPTIONS-HIT /.test(log));
    check('日志：WARN RETRY-STALE', /WARN RETRY-STALE/.test(log));
    check('日志：没有 STORE-ERROR / ENOENT', !/STORE-ERROR/.test(log) && !/ENOENT/.test(log));
    console.log('   ---- 关键日志（前 25 条）----');
    console.log(
      log
        .split('\n')
        .filter((l) => /HIT|MISS|STALE|OVERRIDE|OPTIONS|STORE|ERROR|RETRY|WARN/.test(l))
        .slice(-45)
        .join('\n')
    );

    // ---- 用例 30：后台条件校验（revalidateAfterSeconds>0）要把结果写回 .ext ----
    await stopProxy();
    const cfgPath2 = path.join(tmp, 'config.json');
    const cfg2 = JSON.parse(fs.readFileSync(cfgPath2, 'utf8'));
    cfg2.revalidateAfterSeconds = 5;
    fs.writeFileSync(cfgPath2, JSON.stringify(cfg2, null, 2));
    await startProxy();
    const rvUrl = `${O}/assets/rv.png`;
    await proxyGet(rvUrl); // 首次：MISS → STORE，revalidateAt = 现在 + 5s
    await sleep(300);
    const rvExtPath = diskPath(rel('127.0.0.1/assets/rv.png.ext'));
    const revalidateBefore = JSON.parse(fs.readFileSync(rvExtPath, 'utf8')).revalidateAt;
    await sleep(5500); // 等过窗口
    const rv2 = await proxyGet(rvUrl); // 命中 + 触发后台条件请求（源站回 304）
    await sleep(700);
    const revalidateAfter = JSON.parse(fs.readFileSync(rvExtPath, 'utf8')).revalidateAt;
    check('用例30 命中后触发了后台条件校验', /REVALIDATED-304/.test(logText()), (logText().match(/.*REVALIDATED-304.*/) || [''])[0]);
    check(
      '用例30 后台 304 把 revalidateAt 往后推（写回 .ext）',
      revalidateAfter > revalidateBefore && revalidateBefore > 0,
      `${revalidateBefore} -> ${revalidateAfter}`
    );
    check('用例30 校验期间浏览器仍拿到本地命中', rv2.headers['x-gbf-cache'] === 'HIT', `x-gbf-cache=${rv2.headers['x-gbf-cache']}`);

    // ---- 用例 31：--stop 能停掉后台代理（pid 归属由"实例自证"确认）----
    const pidFileText = fs.existsSync(path.join(tmp, 'runtime', 'logs', 'proxy.pid'))
      ? fs.readFileSync(path.join(tmp, 'runtime', 'logs', 'proxy.pid'), 'utf8').trim()
      : '';
    check('用例31 pid 文件记录的就是当前代理进程', Number(pidFileText) === child.pid, `pidFile=${pidFileText} child=${child.pid}`);
    const stopOut = await new Promise((resolve) => {
      const p = spawn(bin, useExe ? ['--stop'] : [path.join(PROJECT, 'src/main.js'), '--stop'], {
        env: { ...process.env, GBF_CACHE_HOME: tmp },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let o = '';
      p.stdout.on('data', (d) => (o += d));
      p.stderr.on('data', (d) => (o += d));
      p.on('exit', () => resolve(o));
    });
    await sleep(900);
    const portClosed = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: PROXY_PORT });
      const done = (ok) => {
        s.removeAllListeners();
        s.destroy();
        resolve(!ok);
      };
      s.setTimeout(600, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
    check('用例31 --stop 输出了停止结果', /已停止缓存代理|已经不存在|没有在运行/.test(stopOut), stopOut.trim().split('\n').pop());
    check('用例31 --stop 之后端口已关闭', portClosed);
  } finally {
    await stopProxy();
    origin.close();
    rawOrigin.close();
    await sleep(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
