'use strict';

/**
 * GBF 本地缓存代理
 * ------------------------------------------------------------------
 * 浏览器 --(HTTP 代理)--> 本进程 --(你的网络出口 / 本机代理)--> 节点
 *
 * 做的事：
 *   1. 用本地 CA 现场签发证书，解开 HTTPS（MITM），这样才能看到并缓存素材
 *   2. 把静态素材（图片/音频/字体/二进制等）落盘，命中后直接本地回，不再走外网
 *   3. 动态接口（/rest/ 等）一律透传，不缓存，保证账号数据不会读到旧内容
 *   4. 每个响应带 X-GBF-Cache: HIT / MISS / BYPASS 头，方便在 DevTools 里验证
 *
 * 端口：代理 listen.port（默认 18080），统计页 statsPort（默认 18081）
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

// 工作目录：环境变量优先（打包版用它指向项目目录），
// 单文件 exe 用 exe 所在目录，普通 Node 运行用脚本所在目录。
function resolveRoot() {
  if (process.env.GBF_CACHE_HOME) return path.resolve(process.env.GBF_CACHE_HOME);
  try {
    if (require('node:sea').isSea()) return path.dirname(process.execPath);
  } catch {
    /* 不是单文件版，正常 */
  }
  // 源码运行时入口在 src/ 下，项目根目录是上一级（config.json / certs / logs 都在根上）
  return typeof __dirname === 'string' ? path.resolve(__dirname, '..') : path.dirname(process.execPath);
}

const ROOT = resolveRoot();
const CONFIG_PATH = path.join(ROOT, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`找不到配置文件：${CONFIG_PATH}\n请把 config.json 放在同目录，或用环境变量 GBF_CACHE_HOME 指向项目目录。`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const { PathCache, HOP_BY_HOP, isAllZero, shouldStoreBody, isOverridePath } = require('./cache');
const { createPanel } = require('./panel/server');
const { CertStore } = require('./certs');
const { Upstream } = require('./upstream');
const policy = require('./policy');

const argPort = process.argv.find((a) => a.startsWith('--port='));
const argStatsPort = process.argv.find((a) => a.startsWith('--stats-port='));
const argPanelPort = process.argv.find((a) => a.startsWith('--panel-port='));
const LISTEN_PORT = argPort ? Number(argPort.split('=')[1]) : config.listen.port;
const LISTEN_HOST = config.listen.host || '127.0.0.1';
// 指定了 --port 时统计端口自动跟着走，方便同时跑两个实例做测试
const STATS_PORT = argStatsPort
  ? Number(argStatsPort.split('=')[1])
  : argPort
    ? LISTEN_PORT + 1
    : config.statsPort || LISTEN_PORT + 1;

// ---------------------------------------------------------------- 运行模式
// 双击 exe（无参数）= 一键开始玩：后台起代理 + 用带缓存的配置打开 Chrome
// --serve / --daemon  = 只跑代理（daemon 是后台无窗口的那种）
// --stop              = 停掉在后台跑的代理
// --clear-cache       = 清空素材缓存
// --help              = 说明
const isSea = (() => {
  try {
    return require('node:sea').isSea();
  } catch {
    return false;
  }
})();

// 只有一个 exe：双击（不带参数）= 打开控制面板；面板里的“一键启动”＝旧的 playMode（起缓存 + 开 Chrome）。
// 显式给 --serve / --daemon / --port=… / --stop / --clear-cache / --help 时，照旧走命令行模式。
const PANEL_ONLY = process.argv.includes('--panel-only'); // 只起面板服务、不开窗口（自动化测试用）
const PLAY_FLAG = process.argv.includes('--play'); // 一键启动：确保缓存在跑 + 用带缓存的配置打开 Chrome
const panelOthers = process.argv.slice(2).filter((a) => a !== '--play' && !a.startsWith('--panel'));

const MODE = process.argv.includes('--stop')
  ? 'stop'
  : process.argv.includes('--clear-cache')
    ? 'clear'
    : process.argv.includes('--help')
      ? 'help'
      : PLAY_FLAG
        ? 'play'
        : panelOthers.length === 0 || PANEL_ONLY || process.argv.includes('--panel')
          ? 'panel'
          : argPort || process.argv.includes('--serve') || process.argv.includes('--daemon')
            ? 'serve'
            : 'play';

// ---------------------------------------------------------------- 日志/统计

// 面板是个"常驻"进程，它的日志单独一份：否则代理每次重启归档 proxy.log 时，
// 会把面板正在写的文件挪走（面板那条 PANEL 记录就丢了）。
const logPath = abs(MODE === 'panel' ? 'runtime/logs/panel.log' : config.logFile);
fs.mkdirSync(path.dirname(logPath), { recursive: true });

// 日志按大小轮转。原来只有一个只增不减的 proxy.log，长时间玩下来能涨到几百 MB，
// 每个请求都要往里追一行，越写越慢（而 logRequests 会把每一次命中也记下来）。
const LOG_MAX_BYTES = (config.logMaxMB || 32) * 1048576;
let logBytes = 0;
try {
  logBytes = fs.statSync(logPath).size;
} catch {
  /* 还没有日志文件 */
}

/**
 * 每"启动一轮代理"（--serve/--daemon）都开一份新日志：
 * 上一轮的 proxy.log 与 events-*.jsonl 先移到 runtime\logs\prev\ 留档（最多留 10 轮），
 * 新一轮从空文件开始 —— 这样这一轮调优的数据不会和上一轮互相串。
 * 只在真正起代理时做；--stop / --clear-cache / --panel / --help 不动日志。
 */
function archivePreviousRun() {
  const dir = path.dirname(logPath);
  const prevDir = path.join(dir, 'prev');
  const moved = [];
  try {
    fs.mkdirSync(prevDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 19);
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 0) {
      const to = path.join(prevDir, `proxy-${stamp}.log`);
      fs.renameSync(logPath, to);
      moved.push(path.basename(to));
    }
    for (const f of fs.readdirSync(dir)) {
      if (!/^events-.*\.jsonl$/.test(f)) continue;
      const to = path.join(prevDir, f.replace(/\.jsonl$/, `.${stamp}.jsonl`));
      try {
        fs.renameSync(path.join(dir, f), to);
        moved.push(path.basename(to));
      } catch {
        /* 单个文件挪不动就跳过 */
      }
    }
    // 按"轮"清理：一轮 = 同一时间戳的 proxy-*.log + events-*.jsonl（2 个文件），
    // 只保留最近 logKeepRuns 轮（默认 10 轮 = 20 个文件），避免无限增长。
    const keepRuns = Math.max(1, Number(config.logKeepRuns || 10));
    const byStamp = new Map();
    for (const f of fs.readdirSync(prevDir)) {
      const m = /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(f);
      const key = m ? m[1] : 'unknown';
      if (!byStamp.has(key)) byStamp.set(key, []);
      byStamp.get(key).push(path.join(prevDir, f));
    }
    const stamps = [...byStamp.keys()].sort();
    while (stamps.length > keepRuns) {
      const st = stamps.shift();
      for (const p of byStamp.get(st)) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* 归档失败不影响启动：继续往原文件追加即可 */
  }
  return moved;
}

const archivedThisRun = MODE === 'serve' ? archivePreviousRun() : [];

let logStream = fs.createWriteStream(logPath, { flags: 'a' });

function rotateLog() {
  try {
    logStream.end();
    fs.rmSync(logPath + '.1', { force: true }); // Windows 上 rename 不能覆盖已存在的文件
    fs.renameSync(logPath, logPath + '.1');
  } catch {
    /* 轮转失败就继续往原文件写，不影响代理 */
  }
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logBytes = 0;
}

if (logBytes >= LOG_MAX_BYTES) rotateLog();

// 最近请求流水：等于是把浏览器的 Network 面板搬到本地网页上
const recentRequests = [];
const RECENT_MAX = 300;

function humanToBytes(text) {
  const m = /(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/.exec(text || '');
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (m[2] === 'GB') return Math.round(n * 1073741824);
  if (m[2] === 'MB') return Math.round(n * 1048576);
  if (m[2] === 'KB') return Math.round(n * 1024);
  return Math.round(n);
}

// ---- 日志级别 ----
// 每一行都带明确级别，按"事件类型"自动归属：
//   正常命中/入库 = INFO ｜ 需要留意的退化路径（未入库、重试、拉黑）= WARN
//   真正的失败 = ERROR ｜ 高频噪声（透传、隧道、握手）= DEBUG
// 级别是时间戳之后的第二个字段，可以直接 grep：
//   findstr /C:" WARN " runtime\logs\proxy.log
// config.logMinLevel 可以过滤（默认 DEBUG = 全都写，保持原行为）。
const LEVEL_BY_KIND = [
  ['STORE-ERROR', 'ERROR'], ['UPSTREAM-STREAM-ERROR', 'ERROR'], ['UPSTREAM-ERROR', 'ERROR'],
  ['TUNNEL-FAIL', 'ERROR'], ['CERT-ERROR', 'ERROR'], ['TLS-CLIENT-ERROR', 'ERROR'], ['ERROR', 'ERROR'],
  ['MISS-NOSTORE', 'WARN'], ['MISS-TOOBIG', 'WARN'], ['BYPASS-FASTFAIL', 'WARN'],
  ['RETRY-STALE', 'WARN'], ['RETRY-5XX', 'WARN'], ['STALE', 'WARN'], ['BADHOST', 'WARN'],
  ['HIT-304', 'INFO'], ['HIT', 'INFO'], ['MISS->STORE', 'INFO'], ['OVERRIDE', 'INFO'],
  ['OPTIONS-HIT', 'INFO'], ['REVALIDATED-304', 'INFO'], ['REVALIDATED-NEW', 'INFO'],
  ['[start]', 'INFO'], ['[stats]', 'INFO'], ['[latency]', 'INFO'], ['[cache]', 'INFO'],
  ['[upstream]', 'INFO'], ['[warm]', 'INFO'], ['[stop]', 'INFO'],
  ['BYPASS', 'DEBUG'], ['TUNNEL', 'DEBUG'], ['TLS', 'DEBUG'],
];
const LEVEL_ORDER = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const LOG_MIN_LEVEL = LEVEL_ORDER[String(config.logMinLevel || 'DEBUG').toUpperCase()] || 10;
// 网关错误重试前的等待：避免上游已经过载时还立刻补一刀
const RETRY_5XX_DELAY_MS = Math.max(0, Number(config.retry5xxDelayMs || 150));
// 导入缓存包后的"请重扫"哨兵：由 tools/import.mjs 写，代理定期消费
const RESCAN_SENTINEL = '.gbf-rescan-request';

function levelFor(first) {
  for (const [kind, level] of LEVEL_BY_KIND) if (first.startsWith(kind)) return level;
  return 'INFO';
}

// 日志脱敏：Cookie / Authorization / 请求体本来就不记，这里再把查询串里的
// 用户标识与令牌类参数值掩码掉（uid=123 → uid=***），避免日志里留下账号线索。
const SENSITIVE_QUERY = /([?&](?:uid|token|session|sid|password|passwd|auth|key|ticket|code|sig|signature)=)[^&\s]*/gi;

function maskSensitive(value) {
  return String(value).replace(SENSITIVE_QUERY, '$1***');
}

function log(...parts) {
  // 允许 log('WARN', ...) 这样显式指定级别：把级别从正文里摘掉，以它为准。
  let first = String(parts[0] || '');
  const explicit = LEVEL_ORDER[first.toUpperCase()] ? first.toUpperCase() : null;
  if (explicit) {
    parts = parts.slice(1);
    first = String(parts[0] || '');
  }
  const level = explicit || levelFor(first);
  if ((LEVEL_ORDER[level] || 10) < LOG_MIN_LEVEL) return;
  // 一条事件必须占一行：异常栈 / 子进程 stderr 常带换行，折成空格，
  // 免得后续行没有级别前缀，破坏「按级别 grep」和日志校验。
  const line = `${new Date().toISOString()} ${level} ${maskSensitive(parts.join(' ')).replace(/[\r\n]+/g, ' ')}`;
  try {
    const kind = /^(HIT-304|HIT|STALE|MISS-NOSTORE|MISS->STORE|MISS-TOOBIG|OVERRIDE|OPTIONS-HIT|RETRY-5XX|BYPASS-FASTFAIL|BYPASS|TUNNEL-FAIL|TUNNEL|UPSTREAM-ERROR|STORE-ERROR|REVALIDATED-304|REVALIDATED-NEW)/.exec(first);
    if (kind) {
      recentRequests.push({
        t: new Date().toISOString().slice(11, 19),
        kind: kind[1],
        host: String(parts[1] || ''),
        path: maskSensitive(String(parts[2] || '')).slice(0, 120),
        size: humanToBytes(first),
      });
      if (recentRequests.length > RECENT_MAX) recentRequests.shift();
    }
  } catch {
    /* 记录流水失败不影响正常日志 */
  }
  logBytes += Buffer.byteLength(line) + 1;
  if (logBytes >= LOG_MAX_BYTES) rotateLog();
  logStream.write(line + '\n');
  if (config.logConsole !== false) console.log(line);
}

// ---------------------------------------------------------------- 结构化追踪（JSONL）
//
// 人类可读的那行日志保持原样（既有分析脚本不受影响）；这里**额外**写一份机器可读的事件流，
// 用来回答"这个对象第一次未命中、第二次命中了吗""为什么一直命中不了"这类追踪问题。
// 字段与枚举见 tools/report.cjs 头部的说明。
const TRACE_ENABLED = config.traceJsonl !== false;
const TRACE_SESSION = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
let traceSeq = 0;
let traceStream = null;
let traceStreamPath = '';
let traceBytes = 0;

function traceFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(path.dirname(logPath), `events-${day}.jsonl`);
}

function traceSink() {
  const want = traceFilePath();
  if (traceStream && traceStreamPath === want) return traceStream;
  try {
    if (traceStream) traceStream.end();
  } catch {
    /* ignore */
  }
  traceStreamPath = want;
  try {
    traceBytes = fs.statSync(want).size;
  } catch {
    traceBytes = 0;
  }
  traceStream = fs.createWriteStream(want, { flags: 'a' });
  traceStream.on('error', () => {
    /* 追踪写不进去不能影响代理 */
  });
  return traceStream;
}

/** 写一条追踪事件；任何异常都吞掉（追踪是旁路，不能影响请求） */
function emitTrace(evt) {
  if (!TRACE_ENABLED) return;
  try {
    const line = `${JSON.stringify({ session: TRACE_SESSION, seq: ++traceSeq, ...evt })}\n`;
    const bytes = Buffer.byteLength(line);
    const limit = (config.traceMaxMB || 16) * 1048576;
    if (traceBytes + bytes > limit) {
      const cur = traceFilePath();
      try {
        traceStream.end();
        fs.rmSync(`${cur}.1`, { force: true });
        fs.renameSync(cur, `${cur}.1`);
      } catch {
        /* 轮转失败就继续写当前文件 */
      }
      traceStream = null;
      traceBytes = 0;
    }
    traceBytes += bytes;
    traceSink().write(line);
  } catch {
    /* 追踪失败不影响代理 */
  }
}

// ---- 耗时记录：让日志能回答"这一次卡在哪一段" ----
//
// 背景：原来的日志只说"发生了什么"（HIT / BYPASS / RETRY-STALE），
// 完全看不出时间花在哪里。排查"偶尔顿一下"时，最需要知道的就是
// 上游握手多久、首字节多久、下游回写多久 —— 卡顿感来自尾部延迟，不是平均值。
//
// 输出格式（追加在行末，不改变原有字段顺序，兼容既有的分析脚本）：
//   conn=3 tls=142 ttfb=128 up=270 down=1 total=274
// 单位毫秒；拿不到的阶段省略，不写 0 误导。

function ms(v) {
  return v === undefined || v === null ? '' : String(Math.round(v));
}

/** 把各阶段耗时拼成 key=value 串，缺的跳过 */
function timing(fields) {
  const out = [];
  for (const [k, v] of Object.entries(fields)) {
    const s = ms(v);
    if (s !== '') out.push(`${k}=${s}`);
  }
  return out.join(' ');
}

/** 给请求对象挂一个时间线，跨函数传递而不用改一堆签名 */
const REQ_TIMELINE = Symbol('gbf.timeline');
const TIMELINE_ATTR = 'gbfTimeline';
const TIMELINE_COUNT = 'gbfReuseCount';

/** 统计对象上的复用计数（不污染日志字段） */
function bumpReuse(obj) {
  obj[TIMELINE_COUNT] = (obj[TIMELINE_COUNT] || 0) + 1;
}

function timelineOf(obj) {
  if (!obj) return null;
  if (!obj[TIMELINE_ATTR]) obj[TIMELINE_ATTR] = { t0: Date.now() };
  return obj[TIMELINE_ATTR];
}

// ---- 在途请求计数：判断"这一刻有多少请求挤在一起" ----
//
// 这是排查卡顿最关键的上下文。实测发现部分网络出口对短时间高频建连有限速：
// 连续发 6 次，时延从 240ms 单调爬到 1900ms，停 3 秒就恢复。
// 所以想知道"某次卡是不是因为并发太高"，就必须记下当时的并发数。
let inFlight = 0;
let peakInFlight = 0;

function inFlightEnter() {
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  return inFlight;
}
function inFlightLeave() {
  inFlight--;
}

/** 取当前在途数，用于日志 */
function nowInFlight() {
  return inFlight;
}

const stats = {
  startedAt: Date.now(),
  requests: 0,
  hits: 0,
  misses: 0,
  bypass: 0,
  stored: 0,
  revalidations: 0,
  tunnels: 0,
  aliased: 0,
  errors: 0,
  overrides: 0,
  preflights: 0,
  missNoStore: 0,
  stale: 0,
  bytesFromCache: 0,
  bytesFromNetwork: 0,
  hosts: new Map(), // host -> {hits, misses, bypass}
};

const cacheFlights = new Map();

function beginCacheFlight(key) {
  const current = cacheFlights.get(key);
  if (current) return { owner: false, promise: current.promise };
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  const timer = setTimeout(() => finishCacheFlight(key), 30000);
  timer.unref?.();
  cacheFlights.set(key, { promise, resolve, timer });
  return { owner: true, promise };
}

function finishCacheFlight(key) {
  const flight = cacheFlights.get(key);
  if (!flight) return;
  cacheFlights.delete(key);
  clearTimeout(flight.timer);
  flight.resolve();
}

function noteHost(host, kind) {
  let e = stats.hosts.get(host);
  if (!e) {
    e = { hits: 0, misses: 0, bypass: 0 };
    stats.hosts.set(host, e);
  }
  e[kind]++;
}

function human(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'MB';
  return (bytes / 1073741824).toFixed(2) + 'GB';
}

// ---------------------------------------------------------------- 接口记录（临时诊断用）
// config.apiDumpPatterns 非空时才工作；用来把游戏接口的原始响应对照下来，
// 方便分析队伍数据。读完记得清空该配置并删除 logs/api-dump。
let apiDumpSeq = 0;

function shouldDump(target) {
  const pats = config.apiDumpPatterns || [];
  if (!pats.length) return false;
  // 素材文件不记录（那些是图片/音频，没有分析价值，只占地方）
  if (/\.(png|jpe?g|webp|gif|svg|ico|bmp|avif|mp3|m4a|m4s|ogg|oga|opus|wav|aac|flac|mp4|webm|woff2?|ttf|otf|eot)(\?|$)/i.test(target.path)) {
    return false;
  }
  return pats.some((p) => target.url.indexOf(p) >= 0);
}

function writeApiDump(target, status, headers, body) {
  try {
    const dir = path.join(abs(config.apiDumpDir || 'logs/api-dump'), new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const safe = (target.host + target.path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 90);
    const name = String(++apiDumpSeq).padStart(4, '0') + '-' + safe;
    fs.writeFileSync(path.join(dir, name + '.json'), body);
    fs.writeFileSync(
      path.join(dir, name + '.meta.json'),
      JSON.stringify({ url: target.url, status, contentType: headers['content-type'] || '', size: body.length, at: new Date().toISOString() }, null, 2)
    );
    stats.dumped = (stats.dumped || 0) + 1;
  } catch {
    /* 记录失败不影响正常代理 */
  }
}

// ---------------------------------------------------------------- 上游连接

// 上游出口：不启用 TUN/全局路由时，请求交给本机代理软件的端口，由它按规则决定走节点还是直连
const upstream = new Upstream(config.upstream || {});

function makeAgent(protocol, rejectUnauthorized) {
  const AgentClass = protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new AgentClass({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 128,
    // maxFreeSockets 是「每个主机」的空闲连接上限（freeSockets 按 host 分桶）。
    // 原来是 16：实测素材 CDN 一秒内能冲到 13 个并发，已经贴着上限了，
    // 再往上多出来的连接用完就被销毁，下次刷新又得重新握手。
    // 提到 32 给突发留余量；连接超过 keepAliveMsecs 会自然过期，不会无限堆积。
    // maxTotalSockets 兜底总连接数，避免上游换节点后攒一堆死连接。
    maxFreeSockets: 32,
    maxTotalSockets: 160,
    timeout: 60000,
  });
  const originalCreate = agent.createConnection;
  agent.createConnection = (options, cb) => {
    const host = options.host || options.hostname;
    const port = options.port;
    // 这里只有"真的要新建连接"时才会被调用 —— 复用空闲连接不会走到这里。
    // 所以这段时间就是白付的握手成本，必须记下来：实测本机出口到游戏服
    // 建连要 100-250ms，而副本内刷新会连着建几十条，正是卡顿的主要来源。
    const t0 = Date.now();
    connectingNow.add(host);
    const done = (err, socket) => {
      const ms = Date.now() - t0;
      connectingNow.delete(host);
      if (!err && socket) {
        const pending = pendingConnTiming.get(host);
        if (pending) pending.push(ms);
        else pendingConnTiming.set(host, [ms]);
      }
      cb(err, socket);
    };
    if (protocol === 'https:') {
      return upstream.createTlsConnection(host, port, options.servername || host, rejectUnauthorized)(options, done);
    }
    return upstream.createPlainConnection(host, port)(options, done);
  };
  return agent;
}

// 正在建连的上游主机（用于日志里体现"同时在建几条"）
const connectingNow = new Set();
// 刚建好的连接耗时，等待被对应的请求取走（key = host）
const pendingConnTiming = new Map();

/** 取走某个主机的建连耗时（取不到返回 undefined，说明这条是复用连接） */
function takeConnTiming(host) {
  const list = pendingConnTiming.get(host);
  if (!list || !list.length) return undefined;
  const v = list.shift();
  if (!list.length) pendingConnTiming.delete(host);
  return v;
}

let httpAgent = makeAgent('http:', true);
let httpsAgent = makeAgent('https:', !config.insecureUpstream);

// 连接保温：每 keepWarmSeconds 秒对游戏服务器发一个极小的请求，
// 把 TCP + TLS 连接一直留在连接池里。这样你刷新时不用重新握手
// （冷连接要多花 1~2 个往返，按当前节点就是几百毫秒）。
function warmUp() {
  const hosts = config.keepWarmHosts || [];
  if (!hosts.length) return;
  for (const host of hosts) {
    try {
      const req = https.request(
        {
          protocol: 'https:',
          host,
          port: 443,
          method: 'GET',
          path: '/favicon.ico',
          agent: httpsAgent,
          servername: host,
          rejectUnauthorized: !config.insecureUpstream,
          headers: { 'user-agent': 'grancache/keepalive', 'accept-encoding': 'gzip' },
        },
        (res) => res.resume()
      );
      req.setTimeout(15000, () => req.destroy());
      req.on('error', () => {});
      req.end();
    } catch {
      /* 保温失败无所谓 */
    }
  }
}

// 失败快速记忆：某个主机连续失败几次后，短时间内直接回错误，不再傻等上游超时。
//
// ⚠️ 只对“域名根本不存在”（ENOTFOUND / EAI_AGAIN）生效，而且是本机网络里真解析不出来的
// 那种域名才该走这条路。
//
// 之前是不管什么错都累计 3 次就把**整个主机**拉黑 30 秒，后果很严重：
// 上游一抖动（连接被重置、握手被打断，日志里有 292 次），CDN 主机就被拉黑，
// 接下来 30 秒内这个主机上的**所有**素材请求全部立刻返回 502。
// 一台 CDN 上挂着成百上千个素材，一个瞬时抖动被放大成整站雪崩，
// 游戏侧只能不停重试 —— 表现出来就是“越玩越卡”。
// 日志里那 601 次 BYPASS-FASTFAIL 全部集中在素材 CDN 上，就是这么来的。
const FAIL_THRESHOLD = 3;
const FAIL_TTL_MS = 30000;
const DNS_FAIL_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const hostFailures = new Map(); // host -> { count, until }

// 值得原样重试一次的错误：都是“连接没了”这一类，与请求内容无关
const RETRYABLE_CONN_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EPROTO']);
function isRetryableConnError(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_CONN_CODES.has(err.code)) return true;
  return /socket disconnected before secure TLS connection|socket hang up|Client network socket/i.test(
    err.message || ''
  );
}

function isHostMarkedBad(host) {
  const rec = hostFailures.get(host);
  if (!rec) return false;
  if (rec.until && rec.until > Date.now()) return true;
  if (rec.until) hostFailures.delete(host);
  return false;
}

function noteHostFailure(host, err) {
  // 网络抖动不算“这个域名不存在”，别拿它当拉黑依据
  if (!err || !DNS_FAIL_CODES.has(err.code)) return;
  // 素材 CDN 永远不拉黑：一个失败会连带废掉同主机上成百上千个素材
  if (policy.isAssetHost(host, config)) return;
  const rec = hostFailures.get(host) || { count: 0, until: 0 };
  rec.count++;
  if (rec.count >= FAIL_THRESHOLD) {
    rec.until = Date.now() + FAIL_TTL_MS;
    rec.count = 0;
    log(`BADHOST ${host} 本机解析不到，${FAIL_TTL_MS / 1000} 秒内直接跳过`);
  }
  hostFailures.set(host, rec);
}

function noteHostSuccess(host) {
  hostFailures.delete(host);
}

// ---------------------------------------------------------------- 工具

function requestHeadersForUpstream(reqHeaders, host) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'host') continue;
    out[k] = v;
  }
  out.host = host;
  return out;
}

function parseTargetFromPlainRequest(req) {
  // 普通（非 CONNECT）代理请求，URL 是绝对地址
  if (/^https?:\/\//i.test(req.url)) {
    const u = new URL(req.url);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return {
      protocol: u.protocol,
      host: u.hostname,
      port,
      path: u.pathname + u.search,
      url: u.toString(),
    };
  }
  const hostHeader = String(req.headers.host || '');
  const [host, portStr] = hostHeader.split(':');
  return {
    protocol: 'http:',
    host,
    port: portStr ? Number(portStr) : 80,
    path: req.url,
    url: `http://${host}${req.url}`,
  };
}

function targetFromMitm(req) {
  const sni = (req.socket.servername || '').trim();
  const hostHeader = String(req.headers.host || '').split(':')[0];
  const host = sni || hostHeader;
  if (/^https?:\/\//i.test(req.url)) {
    const u = new URL(req.url);
    return { protocol: 'https:', host: u.hostname, port: 443, path: u.pathname + u.search, url: u.toString() };
  }
  return { protocol: 'https:', host, port: 443, path: req.url, url: `https://${host}${req.url}` };
}

// ---------------------------------------------------------------- 主体

const cache = new PathCache({
  dir: abs(config.cacheDir),
  maxBytes: (config.maxCacheGB || 20) * 1073741824,
  revalidateAfterSeconds: config.revalidateAfterSeconds || 0,
  verifyIntegrity: config.verifyIntegrity === true, // 默认关，见 src/cache.js 里的说明
  contentTypeFor: policy.contentTypeForExtension,
  // 让缓存层的"载入/淘汰"日志也走统一日志（带级别、写进 proxy.log、支持 logMinLevel 过滤）
  log: (msg) => log(msg),
});
const certs = new CertStore({
  root: abs('runtime/certs'),
  opensslPath: config.opensslPath,
  prewarmHosts: config.prewarmHosts,
});

let certsReady = false;
let fallbackContext = null;

// 后台条件校验：只在“开启了 revalidateAfterSeconds”时才会用到。
// 先立刻把本地副本给浏览器（不卡加载），同时悄悄问一次服务器有没有更新。
const revalidating = new Set();
function revalidateInBackground(target, key, meta, acceptEncoding) {
  const immortal = !config.revalidateAfterSeconds;
  if (immortal || revalidating.has(key)) return;
  revalidating.add(key);

  const headers = {
    'accept-encoding': acceptEncoding || 'gzip, deflate',
    'user-agent': 'grancache/revalidate',
  };
  const etag = meta.headers && meta.headers.etag;
  const lastModified = meta.headers && meta.headers['last-modified'];
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;

  const mod = target.protocol === 'http:' ? http : https;
  const options = {
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    method: 'GET',
    path: target.path,
    headers,
    agent: target.protocol === 'http:' ? httpAgent : httpsAgent,
    servername: target.host,
  };
  if (target.protocol === 'https:') options.rejectUnauthorized = !config.insecureUpstream;

  const upReq = mod.request(options);
  const finish = () => revalidating.delete(key);

  upReq.on('response', (upRes) => {
    if (upRes.statusCode === 304) {
      // 服务器说“没变”，只把校验时间往后推，内容一个字节都不用重下
      cache.markRevalidated(key).finally(() => {
        stats.revalidations++;
        log('REVALIDATED-304', target.host, target.path);
        finish();
      });
      upRes.resume();
      return;
    }
    if (upRes.statusCode === 200) {
      const chunks = [];
      let size = 0;
      upRes.on('data', (c) => {
        size += c.length;
        chunks.push(c);
      });
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        if (body.length !== meta.size) {
          cache
            .set(key, {
              url: target.url,
              status: 200,
              headers: cache.pickHeaders(upRes.headers),
              contentType: upRes.headers['content-type'] || '',
              expiresAt: 0,
            }, body)
            .then(() => {
              stats.revalidations++;
              log('REVALIDATED-NEW', human(size), target.host, target.path);
            })
            .catch(() => {})
            .finally(finish);
        } else {
          cache.markRevalidated(key).finally(() => {
            stats.revalidations++;
            finish();
          });
        }
      });
      upRes.on('error', finish);
      return;
    }
    upRes.resume();
    finish();
  });
  upReq.on('error', finish);
  upReq.end();
}

function handleRequest(req, res, target) {
  stats.requests++;

  // 这个请求的计时起点。挂在 req 上，后面的各阶段往里填时间戳。
  const tl = timelineOf(req);
  const tEnter = Date.now();
  tl.enter = tEnter;
  // 下游（浏览器→代理）这条连接是新建的还是复用的，决定了要不要付一次握手
  tl.downReuse = typeof req.socket.bytesRead === 'number' && req.socket.bytesRead > 0;
  tl.isTls = !!req.socket.encrypted;
  tl.sni = req.socket.servername || '';

  // 域名改写：有些老插件（比如太郎）和老版本游戏还在用 prd-game-a1~a5-... 这些域名，
  // 但这些域名在全球 DNS 里已经不存在了（只有不带数字的 prd-game-a-... 是真的）。
  // 这里把它们指到真实域名上，路径结构完全一样，图片/音效就能正常取到。
  const origHost = target.host;
  const aliasHost = (config.hostAliases || {})[origHost];
  // 走别名改写的请求 = 浏览器直连必然失败的那些老域名（a1~a5 等在 DNS 里已经不存在）。
  // 它们的内容只能靠"浏览器自己缓存下来"才能在代理停止后继续显示，所以给长缓存（见 respondFromCache）。
  const viaDeadAlias = !!aliasHost;
  if (aliasHost) {
    target = { ...target, host: aliasHost, url: target.url.replace(origHost, aliasHost) };
    stats.aliased++;
  }
  // 编码桶从三个（gzip / br / identity）简化成一个：缓存只存一份，编码记在
  // `.ext.ce`。只有客户端自己能解 gzip 时才向上游要 gzip —— 否则转发给它的
  // 字节它解不开。br 不再单独分桶（素材 CDN 上的图片/音频本就不压缩）。
  const clientAE = String(req.headers['accept-encoding'] || '');
  const clientAcceptsGzip = /\bgzip\b/i.test(clientAE);
  const upstreamEncoding = clientAcceptsGzip ? 'gzip, deflate' : 'identity';
  // stale-if-error 的容忍窗口（RFC 5861 §4）：0 = 关闭，等于维持原行为
  const staleWindowMs = Math.max(0, Number(config.staleIfErrorSeconds || 0) * 1000);
  const host = target.host;
  const excludedPath = policy.shouldBypass(target, config);
  const bypassPath = excludedPath || policy.isPassthroughHost(host, config);
  // 素材主机白名单：这类主机上的响应不看服务器 TTL，直接按本机策略缓存
  const forceAsset = policy.isAssetHost(host, config) && !excludedPath;
  const methodCacheable = req.method === 'GET' || req.method === 'HEAD';
  const noRange = !req.headers.range;
  const wantCache = methodCacheable && noRange && !bypassPath;
  // 缓存键 = 路径镜像的相对路径（<scheme>/<host>/<url 路径>）。候选列表按优先级
  // 排列：本机 host 目录 → 无 query 回退 → cacheHostFallback 目录。
  const cachePaths = wantCache ? policy.cachePaths(target, config) : null;
  const key = cachePaths ? cachePaths[0] : null;

  // ---- 结构化追踪上下文：每个请求最后会落一条事件（见 emitTrace 的字段说明）----
  const skipReasons = [];
  const trace = {
    id: `r${String(++traceSeq).padStart(6, '0')}`,
    method: req.method,
    host,
    path: target.path,
    url: target.url,
    cacheable: !!wantCache,
    key: key || null,
    bypassReason: wantCache
      ? null
      : excludedPath
        ? 'excluded-pattern'
        : policy.isPassthroughHost(host, config)
          ? 'passthrough-host'
          : !methodCacheable
            ? 'method'
            : 'range',
  };
  /** 请求走到"结果已定"的那一刻调用，整条请求只写一次 */
  const finishTrace = (outcome, extra = {}) =>
    emitTrace({
      t: new Date().toISOString(),
      ...trace,
      outcome,
      // 时延与连接复用（调优用）：命中 vs 回源能直接对比；upReuse=false 说明又付了一次建连
      ms: {
        cache: tl.cacheMs,
        up: tl.upMs,
        ttfb: tl.ttfb,
        total: tl.total || Date.now() - tEnter,
        store: tl.storeMs,
      },
      conn: { reuse: tl.upReuse === true, ms: tl.connMs },
      ...(skipReasons.length ? { missReasons: skipReasons } : {}),
      ...extra,
    });

  // 查缓存时的选项：onSkip 把"本机有对象却没能命中"的原因记进追踪事件
  const cacheGetOpts = {
    keepExpired: staleWindowMs > 0,
    onSkip: (k, reason) => skipReasons.push(reason),
  };

  /** 客户端能不能解开这份缓存体的编码（单桶后主要盯 gzip） */
  const canServeEncoding = (hit) => {
    const ce = String((hit.meta.headers && hit.meta.headers['content-encoding']) || hit.meta.ce || '').toLowerCase();
    return !ce || ce === 'identity' || clientAcceptsGzip;
  };

  /** 魔改文件能不能直接发给这个客户端（gzip 魔改包 + 不认 gzip 的客户端 = 跳过） */
  const overrideServable = (ov) => {
    const ce = String(
      (ov.meta && ((ov.meta.headers && ov.meta.headers['content-encoding']) || ov.meta.ce)) || ''
    ).toLowerCase();
    return !ce || ce === 'identity' || clientAcceptsGzip;
  };

  const respondFromCache = (hit) => {
    const tCacheStart = tl.cacheStart || tEnter;
    const tGot = Date.now();
    tl.cacheMs = tGot - tCacheStart;
    stats.hits++;
    noteHost(host, 'hits');
    stats.bytesFromCache += hit.body.length;
    const headers = { ...hit.meta.headers };
    const ageSeconds = Math.floor((Date.now() - hit.meta.storedAt) / 1000);
    headers['x-gbf-cache'] = 'HIT';
    headers['x-gbf-cache-age'] = String(ageSeconds);

    // 让浏览器自己那份缓存也长期有效，省掉“回头问代理”这一趟
    // 关键取舍：已死域名（a1~a5）的素材必须让浏览器长期留着 —— 代理一停，
    // 浏览器直连这些域名只会 NXDOMAIN，只有它自己那份副本还能把图片显示出来。
    // 其它素材仍按短 TTL，避免游戏更新后浏览器一直拿旧图。
    const longLivedByAlias = viaDeadAlias && policy.isStaticAsset(target.path, config);
    headers['cache-control'] = policy.browserCacheControl({
      versioned: forceAsset && policy.isVersionedAsset(target.url, {
        stripQueryParams: config.cacheKeyStripQueryParams,
      }),
      maxAgeSeconds: longLivedByAlias
        ? config.aliasBrowserMaxAgeSeconds || 604800
        : config.browserMaxAgeSeconds || 300,
    });
    delete headers.expires;

    // CORS：命中缓存时按请求方 Origin 回写（参考 frizz925/gbf-proxy 的做法）
    const storedOrigin = headers['access-control-allow-origin'];
    if (storedOrigin && storedOrigin !== '*' && req.headers.origin) {
      headers['access-control-allow-origin'] = req.headers.origin;
    }

    const inm = req.headers['if-none-match'];
    if (inm && headers.etag && inm.split(',').map((s) => s.trim()).includes(headers.etag)) {
      delete headers['content-encoding'];
      res.writeHead(304, headers);
      res.end();
      log(
        'HIT-304',
        host,
        target.path,
        `| ${timing({ cache: tl.cacheMs, total: Date.now() - tEnter })} ^${nowInFlight()}`
      );
      finishTrace('HIT-304', { bytes: 0, fromCache: true });
      return;
    }
    headers['content-length'] = String(hit.body.length);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(hit.body);
    log(
      `HIT ${human(hit.body.length)}`,
      host,
      target.path,
      `| ${timing({ cache: tl.cacheMs, total: Date.now() - tEnter })} ^${nowInFlight()}`
    );

    if (hit.needsRevalidate) revalidateInBackground(target, hit.key, hit.meta, upstreamEncoding);
    finishTrace('HIT', {
      bytes: hit.body.length,
      fromCache: true,
      encoding: headers['content-encoding'] || null,
      needsRevalidate: !!hit.needsRevalidate,
    });
  };

  /**
   * 魔改覆盖层（照搬 ACGPower 的 `_ap` 后缀约定）：文件存在就无条件优先返回，
   * 不检查新鲜度、不写 .ext。两处刻意偏离见 docs/plan-acgpower-cache-mvp.md §3.7 / §3.9：
   *   1. ct/ce 走"魔改自带 .ext → 扩展名表 → octet-stream"，而不是像它那样直接删掉
   *      （缺 Content-Type 会让部分图片不渲染）；
   *   2. 响应改 `cache-control: no-cache` + `etag: "ap-mtime-size"`，否则浏览器里那份
   *      immutable 一年的原图会让魔改"看起来没生效"。
   */
  const respondOverride = (ov) =>
    cache
      .readOverrideBody(ov)
      .then((body) => {
        const meta = ov.meta || {};
        const storedHeaders = meta.headers || {};
        const ce = String(storedHeaders['content-encoding'] || meta.ce || '').toLowerCase();
        tl.cacheMs = Date.now() - (tl.cacheStart || tEnter);
        stats.overrides++;
        noteHost(host, 'hits');
        stats.bytesFromCache += body.length;
        const headers = {
          'content-type': meta.ct || policy.contentTypeForExtension(policy.extensionOf(target.path)),
          'cache-control': 'no-cache',
          'x-gbf-cache': 'OVERRIDE',
          etag: `"ap-${Math.round(ov.mtimeMs)}-${body.length}"`,
        };
        if (ce && ce !== 'identity') headers['content-encoding'] = ce;
        const storedOrigin = storedHeaders['access-control-allow-origin'];
        if (storedOrigin && storedOrigin !== '*' && req.headers.origin) {
          headers['access-control-allow-origin'] = req.headers.origin;
        } else if (storedOrigin) {
          headers['access-control-allow-origin'] = storedOrigin;
        }

        // 浏览器带着同一个 etag 回来问 = 魔改文件没变，只回 304，不重传文件
        const inm = req.headers['if-none-match'];
        if (inm && inm.split(',').map((s) => s.trim()).includes(headers.etag)) {
          res.writeHead(304, headers);
          res.end();
          log(
            'HIT-304',
            host,
            target.path,
            `(魔改) | ${timing({ cache: tl.cacheMs, total: Date.now() - tEnter })} ^${nowInFlight()}`
          );
          finishTrace('OVERRIDE-304', { bytes: 0, fromCache: true, override: true });
          return;
        }
        headers['content-length'] = String(body.length);
        res.writeHead(200, headers);
        if (req.method === 'HEAD') res.end();
        else res.end(body);
        log(
          `OVERRIDE ${human(body.length)}`,
          host,
          target.path,
          `| ${timing({ cache: tl.cacheMs, total: Date.now() - tEnter })} ^${nowInFlight()}`
        );
        finishTrace('OVERRIDE', { bytes: body.length, fromCache: true, override: true, encoding: ce || null });
      })
      .catch(() => {
        // 读魔改文件失败不该放大成错误响应：退回普通缓存/回源
        cache
          .get(cachePaths, cacheGetOpts)
          .then((hit) => (hit && canServeEncoding(hit) ? respondFromCache(hit) : missThenForward()))
          .catch(() => missThenForward());
      });

  const forward = () => {
    if (isHostMarkedBad(target.host)) {
      // 本机解析不到的域名 = RFC 5861 里点名的 "DNS failure" 错误情形：
      // 有旧副本就先顶上，没有才快速失败（不再傻等上游超时）。
      return upstreamFailed('badhost', `本机解析不到 ${target.host}`, 502, () => leaveOnce());
    }

    // 进入转发：这一段的耗时才是"卡"的主体，逐阶段记下来
    tl.sendAt = Date.now();
    tl.inFlight = inFlightEnter();
    tl.missStage = tl.cacheStart ? tl.sendAt - tl.cacheStart : 0;

    const mod = target.protocol === 'http:' ? http : https;
    const outHeaders = requestHeadersForUpstream(req.headers, target.host);
    outHeaders['accept-encoding'] = upstreamEncoding;
    const options = {
      protocol: target.protocol,
      host: target.host,
      port: target.port,
      method: req.method,
      path: target.path,
      headers: outHeaders,
      agent: target.protocol === 'http:' ? httpAgent : httpsAgent,
      servername: target.host,
    };
    if (target.protocol === 'https:') options.rejectUnauthorized = !config.insecureUpstream;

    let finished = false;
    let currentReq = null;
    let currentAttempt = 1; // send() 会更新它，onUpstreamResponse 读它来记日志
    let leaveDone = false;
    let handedOff = false; // 网关错误/失败转交给 upstreamFailed 后，别再被后续事件二次处理
    // 只退一次在途计数（response / error / abort 都可能触发）
    const leaveOnce = () => {
      if (leaveDone) return;
      leaveDone = true;
      inFlightLeave();
    };

    // 上游长连接可能是“半死”的：对端早就悄悄关了，但连接池里还留着一条，
    // 复用它就会报 Client network socket disconnected / ECONNRESET。
    // 对 GET/HEAD 这类幂等请求，第一次失败就换条新连接重试一次，别让浏览器看到报错。
    // （日志里这一类错误出现过 292 次，每一次用户都会感觉“点了没反应，要等一下”）
    const maxAttempts = req.method === 'GET' || req.method === 'HEAD' ? 2 : 1;

    const onUpstreamResponse = (upRes) => {
      noteHostSuccess(target.host);
      // 首字节时刻：从发起请求到拿到响应头，这一段 = 上游连接 + 等服务器
      tl.upHeadersAt = Date.now();
      tl.upMs = tl.upHeadersAt - tl.sendAt;
      // 上游这条连接是复用的还是新建的 —— 直接决定要不要付一次握手
      tl.upReuse = currentReq && currentReq.reusedSocket === true;
      // 新建连接的话，把那次握手耗时取出来（复用连接则取不到）
      if (!tl.upReuse) tl.connMs = takeConnTiming(target.host);
      tl.attempt = currentAttempt;

      // 网关错误（502/503/504）：先单次重试（nginx proxy_next_upstream 的 http_50x 语义），
      // 重试也用完就把决定权交给 upstreamFailed —— 它可能用旧副本顶一次（RFC 5861）。
      // 只对可缓存目标这么做；动态接口的 5xx 照旧原样透传给页面。
      const gatewayError =
        upRes.statusCode === 502 || upRes.statusCode === 503 || upRes.statusCode === 504;
      if (gatewayError && wantCache) {
        handedOff = true;
        upRes.resume();
        upRes.destroy();
        if (config.retryOn5xx !== false && currentAttempt < maxAttempts && !res.headersSent) {
          log(
            `RETRY-5XX (第 ${currentAttempt} 次拿到 ${upRes.statusCode}，${RETRY_5XX_DELAY_MS}ms 后换连接重试一次)`,
            host,
            target.path,
            `| ${timing({ up: Date.now() - tl.sendAt })} in${nowInFlight()}`
          );
          setTimeout(() => send(currentAttempt + 1), RETRY_5XX_DELAY_MS);
          return;
        }
        return upstreamFailed(`http-${upRes.statusCode}`, `上游返回 ${upRes.statusCode}`, upRes.statusCode, leaveOnce);
      }

      const decision = wantCache
        ? policy.decideStore(
            {
              method: req.method,
              statusCode: upRes.statusCode,
              headers: upRes.headers,
              target,
              host: target.host,
              forceAsset,
            },
            config
          )
        : { store: false, ttlSeconds: 0, reason: wantCache ? 'n/a' : bypassPath ? 'excluded' : 'method/range' };

      const headers = cache.pickHeaders(upRes.headers);
      // 已死别名域名（a1~a5 等）的素材：连**第一次回源**也改成长缓存。
      // 原因：这些域名在 DNS 里已经不存在，代理停掉后浏览器直连只会失败，
      // 只有它自己那份副本还能把图片显示出来 —— 所以从第一眼起就得让它留住。
      if (viaDeadAlias && policy.isStaticAsset(target.path, config)) {
        headers['cache-control'] = `public, max-age=${Number(config.aliasBrowserMaxAgeSeconds || 604800)}`;
      }
      // 先按"与内容无关"的条件决定是否打算入库（响应头必须此刻发出去）；
      // 与内容有关的校验（Content-Length 一致、非全零、不超 maxObjectMB）只能在
      // 收到完整 body 后做，失败的记成 MISS-NOSTORE（见下面的 end 处理）。
      const storeIntent = decision.store && req.method === 'GET' && upRes.statusCode === 200;
      headers['x-gbf-cache'] = storeIntent ? 'MISS' : 'BYPASS';

      res.writeHead(upRes.statusCode, headers);
      tl.firstByteAt = Date.now();
      // 首字节时刻（含写回浏览器），浏览器真正开始收数据的时间
      tl.ttfb = tl.firstByteAt - tEnter;

      const maxObject = (config.maxObjectMB || 64) * 1048576;
      const chunks = [];
      let received = 0;
      let keepBuffering = storeIntent;

      const dumpOn = shouldDump(target);
      const dumpChunks = [];
      const dumpCap = (config.apiDumpMaxKB || 2048) * 1024;
      let dumpSize = 0;

      upRes.on('data', (chunk) => {
        received += chunk.length;
        if (dumpOn && dumpSize < dumpCap) {
          dumpChunks.push(chunk);
          dumpSize += chunk.length;
        }
        if (keepBuffering) {
          if (received <= maxObject) chunks.push(chunk);
          else keepBuffering = false;
        }
        if (!res.write(chunk)) {
          upRes.pause();
          res.once('drain', () => upRes.resume());
        }
      });

      upRes.on('end', async () => {
        finished = true;
        if (!res.writableEnded) res.end();
        tl.endAt = Date.now();
        tl.total = tl.endAt - tEnter;
        tl.downMs = tl.endAt - tl.firstByteAt; // 读完并写回浏览器的耗时
        tl.bytes = received;
        leaveOnce();
        stats.bytesFromNetwork += received;
        // 计入时延统计（这是判断"卡不卡"的数据来源）
        recordLatency({
          conn: tl.connMs,
          tls: tl.tlsMs,
          up: tl.upMs,
          ttfb: tl.ttfb,
          body: tl.downMs,
          total: tl.total,
          host: target.host,
          status: upRes.statusCode,
          size: received,
          reuse: tl.upReuse ? 1 : 0,
          retry: tl.attempt > 1 ? tl.attempt - 1 : 0,
        });
        if (tl.upReuse) latency.reuseOk++;
        else latency.newConn++;
        if (tl.attempt > 1) latency.retries += tl.attempt - 1;
        lastLatency = { host: target.host, path: target.path, ...tl };
        if (dumpOn && dumpChunks.length) writeApiDump(target, upRes.statusCode, upRes.headers, Buffer.concat(dumpChunks));

        // 耗时串：把这次请求各阶段摊开，是"为什么卡"的唯一直接证据
        const tStr = `| ${timing({
          conn: tl.connMs,
          tls: tl.tlsMs,
          up: tl.upMs,
          ttfb: tl.ttfb,
          body: tl.downMs,
          total: tl.total,
        })}${tl.upReuse ? ' reuse' : ' newconn'}${tl.attempt > 1 ? ` retry${tl.attempt - 1}` : ''} in${tl.inFlight}`;

        if (storeIntent) {
          // 超过 maxObjectMB 时中途就停止缓冲了，这时 body 不可用；
          // 而空响应是"长度为 0 的 Buffer"，不是 null —— 两者不能混成同一个原因。
          const tooBig = !keepBuffering;
          const body = tooBig ? null : Buffer.concat(chunks);
          // 完整性校验（照搬 ACGPower 的克制条件）：Content-Length 一致 + 非全零 + 不超上限
          const verdict = tooBig
            ? { ok: false, reason: 'too-big' }
            : shouldStoreBody({
                contentLength: upRes.headers['content-length'],
                received,
                allZero: isAllZero(body),
                maxBytes: maxObject,
              });
          if (verdict.ok) {
            // 落盘耗时也算进去：它不阻塞浏览器，但如果很慢会拖累后续请求
            const tStore = Date.now();
            try {
              await cache.set(key, {
                url: target.url,
                status: upRes.statusCode,
                headers: cache.pickHeaders(upRes.headers),
                contentType: upRes.headers['content-type'] || '',
                expiresAt: decision.ttlSeconds ? Date.now() + decision.ttlSeconds * 1000 : 0,
              }, body);
              stats.stored++;
            } catch (err) {
              stats.errors++;
              log('STORE-ERROR', err.message);
            }
            const storeMs = Date.now() - tStore;
            log(
              `MISS->STORE ${human(body.length)} (${decision.reason}, ttl=${decision.ttlSeconds}s)`,
              host,
              target.path,
              `${tStr} store=${storeMs}`
            );
            finishTrace('MISS', {
              bytes: body.length,
              status: upRes.statusCode,
              store: 'stored',
              storeReason: decision.reason,
              ttlSeconds: decision.ttlSeconds,
              encoding: headers['content-encoding'] || null,
            });
          } else {
            // 响应头已经发出去（写的是 MISS），这里只能把真实结果记进日志
            stats.missNoStore++;
            log(`MISS-NOSTORE ${human(received)} (${verdict.reason})`, host, target.path, tStr);
            finishTrace('MISS-NOSTORE', {
              bytes: received,
              status: upRes.statusCode,
              store: 'skipped',
              storeReason: verdict.reason,
            });
          }
          finishCacheFlight(key);
        } else {
          stats.bypass++;
          noteHost(host, 'bypass');
          if (config.logRequests)
            log(
              `BYPASS ${upRes.statusCode} ${human(received)} (${decision.reason})`,
              host,
              target.path,
              tStr
            );
          finishTrace('BYPASS', {
            bytes: received,
            status: upRes.statusCode,
            store: 'skipped',
            storeReason: decision.reason,
          });
          finishCacheFlight(key);
        }
      });

      upRes.on('error', (err) => {
        if (handedOff) return; // 已经交给 upstreamFailed 处理，别再重复响应
        stats.errors++;
        leaveOnce();
        log('UPSTREAM-STREAM-ERROR', err.message, host, target.path, `| ${timing({ up: tl.upMs, total: Date.now() - tEnter })}`);
        if (!res.writableEnded) res.destroy();
      });

      res.on('close', () => {
        if (!finished) upRes.destroy();
      });
    };

    const send = (attemptNo) => {
      currentAttempt = attemptNo;
      const upReq = mod.request(options);
      currentReq = upReq;
      upReq.on('response', onUpstreamResponse);

      upReq.on('error', (err) => {
        // 连接层面的错误 + 还没拿到任何响应 + 请求体已经发完 → 换条新连接重试一次
        const retryable =
          attemptNo < maxAttempts && !res.headersSent && req.readableEnded && isRetryableConnError(err);
        if (retryable) {
          log(
            `RETRY-STALE (第 ${attemptNo} 次失败：${err.code || err.message})`,
            host,
            target.path,
            `| ${timing({ up: Date.now() - tl.sendAt, total: Date.now() - tEnter })} in${nowInFlight()}`
          );
          send(attemptNo + 1);
          return;
        }
        noteHostFailure(target.host, err);
        log(
          'UPSTREAM-ERROR',
          `${target.url} :: ${err.message}`,
          `| ${timing({
            conn: tl.connMs,
            up: tl.upMs || Date.now() - tl.sendAt,
            total: Date.now() - tEnter,
          })}${tl.upReuse ? ' reuse' : ' newconn'} in${nowInFlight()}`
        );
        handedOff = true;
        return upstreamFailed('connect', `连接上游失败：${err.message}`, 502, leaveOnce);
      });

      // 第一次要把请求体透传过去；重试时请求体早就发完了，直接 end。
      // （不能再 pipe 第二次：无 body 请求的 'end' 只会触发一次，重复 pipe 会挂住）
      if (attemptNo === 1) req.pipe(upReq);
      else upReq.end();
    };

    req.on('aborted', () => {
      if (currentReq) currentReq.destroy();
    });
    send(1);
  };

  /**
   * 用"陈旧副本"顶一次（RFC 5861 stale-if-error）。
   * - `Age` 如实反映这份副本有多旧（RFC 9111 已废弃 Warning，所以只发 Age + 我们自己的诊断头）
   * - `cache-control: no-cache`：让浏览器下次仍然回来问，不把旧内容钉在它自己的缓存里
   */
  const respondStale = (old, token) => {
    stats.hits++;
    stats.stale++;
    noteHost(host, 'hits');
    stats.bytesFromCache += old.body.length;
    const headers = { ...old.meta.headers };
    headers['x-gbf-cache'] = 'STALE';
    headers['x-gbf-cache-age'] = String(old.ageSeconds);
    // 头值必须是 ASCII（Node 遇到非 latin1 字符会直接抛），所以这里放机器 token，
    // 人话（中文原因）只写进日志和响应体。
    headers['x-gbf-cache-stale'] = `${token}; stale=${old.staleSeconds}s`;
    headers.age = String(old.ageSeconds);
    headers['cache-control'] = 'no-cache';
    delete headers.expires;
    headers['content-length'] = String(old.body.length);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(old.body);
    log(
      `STALE ${human(old.body.length)} (${token}, 已过期 ${old.staleSeconds}s)`,
      host,
      target.path,
      `| ${timing({ total: Date.now() - tEnter })} ^${nowInFlight()}`
    );
    finishTrace('STALE', { bytes: old.body.length, fromCache: true, staleSeconds: old.staleSeconds });
  };

  /**
   * 上游彻底失败（DNS 失败 / 连接不上 / 网关错误且重试用完）的统一出口：
   * 有旧副本就先顶一次（RFC 5861 stale-if-error），没有才把错误交给浏览器。
   * 只有可缓存目标才允许顶 —— 动态接口的失败必须让页面自己看到。
   */
  const upstreamFailed = (token, detail, statusCode, leaveOnce) => {
    const fail = () => {
      stats.errors++;
      leaveOnce();
      if (!res.headersSent) {
        res.writeHead(statusCode || 502, {
          'content-type': 'text/plain; charset=utf-8',
          'x-gbf-cache': 'ERROR',
        });
      }
      if (!res.writableEnded) res.end('缓存代理无法完成请求：' + detail);
      log(
        'UPSTREAM-ERROR',
        `${detail} ${host}${target.path}`,
        `| ${timing({ total: Date.now() - tEnter })} in${nowInFlight()}`
      );
      finishTrace('ERROR', { bytes: 0, error: detail, status: statusCode || 502 });
      finishCacheFlight(key);
    };
    if (!wantCache || staleWindowMs <= 0) return fail();
    cache
      .getStale(cachePaths, { maxStaleMs: staleWindowMs })
      .then((old) => {
        if (!old) return fail();
        leaveOnce();
        respondStale(old, token);
      })
      .catch(() => fail());
  };

  // ---- 素材主机的 OPTIONS 预检：本地直接答，不再白付一趟外网往返 ----
  // 收窄到「素材 CDN 白名单 + 静态素材扩展名」：assetHostPatterns 里含
  // *.granbluefantasy.jp（动态 API 主机），无差别接管会顶替真实 API 的预检语义，
  // 对带凭据的请求有破坏风险；API 路径的预检照常回源，语义零改动。
  if (
    req.method === 'OPTIONS' &&
    config.optionsPreflightEnable !== false &&
    forceAsset &&
    policy.isStaticAsset(target.path, config)
  ) {
    stats.preflights++;
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'cache-control': `public, max-age=${Number(config.optionsPreflightMaxAge || 604360)}`,
      'content-length': '0',
      'x-gbf-cache': 'OPTIONS-HIT',
    });
    res.end();
    log('OPTIONS-HIT', host, target.path, `| ${timing({ total: Date.now() - tEnter })}`);
    finishTrace('OPTIONS-HIT', { bytes: 0, fromCache: true });
    return;
  }

  /** 未命中：等同一对象的在途请求（请求合单），没有就自己回源 */
  const missThenForward = () => {
    stats.misses++;
    noteHost(host, 'misses');
    const flight = beginCacheFlight(key);
    if (flight.owner) {
      forward();
      return;
    }
    flight.promise
      .then(() => cache.get(cachePaths, cacheGetOpts))
      .then((ready) => (ready && canServeEncoding(ready) ? respondFromCache(ready) : forward()))
      .catch(() => forward());
  };

  if (wantCache) {
    // 记下开始查缓存的时间：cacheMs 就是从"收到请求"到"判定命中/未命中"
    tl.cacheStart = Date.now();
    // 优先级照搬 ACGPower：魔改文件 → 本地缓存 → 回源
    cache
      // overrideEnable=false 时连 stat 都不做（传空候选列表）
      .overrideFor(config.overrideEnable === false ? null : cachePaths)
      .then((ov) => {
        if (ov && overrideServable(ov)) return respondOverride(ov);
        return cache.get(cachePaths, cacheGetOpts).then((hit) => {
          if (hit && canServeEncoding(hit)) respondFromCache(hit);
          else missThenForward();
        });
      })
      .catch(() => {
        tl.cacheError = true;
        missThenForward();
      });
  } else {
    forward();
  }
}

// ---- 明文 HTTP 代理（少见，但保底能转发） ----
const proxyServer = http.createServer((req, res) => {
  try {
    handleRequest(req, res, parseTargetFromPlainRequest(req));
  } catch (err) {
    stats.errors++;
    log('ERROR', err.stack || err.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy error: ' + err.message);
  }
});

// ---- CONNECT：解开 TLS，交给内层 http 服务器解析 ----
const mitmHttp = http.createServer((req, res) => {
  try {
    handleRequest(req, res, targetFromMitm(req));
  } catch (err) {
    stats.errors++;
    log('ERROR', err.stack || err.message);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy error: ' + err.message);
  }
});

// ---- 连接保活时间 ----
// Node 的 http.Server 默认 keepAliveTimeout 只有 **5 秒**：连接闲置 5 秒就被关掉。
// 但 Chrome 的隧道连接池会保留好几分钟，于是它每次复用的都是一条已经被我们关掉的连接：
// 白白浪费一次往返、报一个错，然后再重开一条。日志里最直观的证据是
// 「TLS 新建连接数 360 ≈ 请求数 737」—— 差不多一半请求都在重做握手
// （而每次握手 = 隧道 CONNECT + 上游 TLS + 下游 TLS，好几趟往返）。
// 把空闲超时放到 2 分钟，让两边的时间对得上。
for (const srv of [proxyServer, mitmHttp]) {
  srv.keepAliveTimeout = 120000;
  srv.headersTimeout = 125000; // 必须大于 keepAliveTimeout，否则会被 Node 强制调大
}

const tlsServer = tls.createServer(
  {
    ALPNProtocols: ['http/1.1'],
    SNICallback: (servername, cb) => {
      if (!certsReady) {
        cb(null, fallbackContext);
        return;
      }
      certs
        .getSecureContext(servername)
        .then((ctx) => cb(null, ctx))
        .catch((err) => {
          log('CERT-ERROR', servername, err.message);
          cb(null, fallbackContext);
        });
    },
  },
  (tlsSocket) => {
    tlsSocket.setNoDelay(true);
    // 下游（浏览器→代理）这条 TLS 连接是新建的。记下这次握手花了多久，
    // 以及这个主机上已经建过几条 —— 建得太频繁说明连接池没起作用。
    const tHandshake = Date.now();
    tlsSocket.once('secure', () => {
      dynDownTls(tlsSocket.servername || '(no-sni)', Date.now() - tHandshake);
    });
    if (config.logRequests) {
      const host = tlsSocket.servername || '(no-sni)';
      const n = downConnCount.get(host) || 0;
      downConnCount.set(host, n + 1);
      log('TLS', host, `| 本机第 ${n + 1} 条下游连接`);
    }
    mitmHttp.emit('connection', tlsSocket);
  }
);

// 下游 TLS 握手耗时（原本在连接建立时就记，这里先建表供上面使用）
const downTlsMs = new Map();
const downConnCount = new Map();

function dynDownTls(host, ms) {
  const list = downTlsMs.get(host) || [];
  list.push(ms);
  if (list.length > 50) list.shift();
  downTlsMs.set(host, list);
}

tlsServer.on('tlsClientError', (err, socket) => {
  if (err && err.code !== 'ECONNRESET') log('TLS-CLIENT-ERROR', err.message);
  socket.destroy();
});

proxyServer.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = String(req.url).split(':');
  const port = portStr ? Number(portStr) : 443;
  clientSocket.setNoDelay(true);
  clientSocket.on('error', () => {});

  // 非 443 端口：原样打隧道，不做中间人也不缓存。
  // 碧蓝幻想的 WebSocket（ws.game.granbluefantasy.jp:11240，连队聊天/协同）走这里。
  if (port !== 443) {
    const tTunnel = Date.now();
    upstream
      .connect(host, port)
      .then((upstreamSocket) => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: grancache\r\n\r\n');
        if (head && head.length) upstreamSocket.write(head);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        upstreamSocket.on('error', () => clientSocket.destroy());
        clientSocket.on('close', () => upstreamSocket.destroy());
        stats.tunnels++;
        // 隧道打通耗时 = 上游建连耗时。WebSocket 断了要重连，这里能看出是不是很慢
        log('TUNNEL', `${host}:${port}`, `| conn=${Date.now() - tTunnel}`);
      })
      .catch((err) => {
        stats.errors++;
        log('TUNNEL-FAIL', `${host}:${port} :: ${err.message}`, `| conn=${Date.now() - tTunnel}`);
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
    return;
  }
  clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: grancache\r\n\r\n');
  if (head && head.length) clientSocket.unshift(head);
  clientSocket.on('error', () => {});
  if (!certsReady) {
    // 证书还没准备好：先用兜底证书顶着，稍后再重试
    certs
      .getSecureContext(host)
      .then(() => {
        certsReady = true;
        tlsServer.emit('connection', clientSocket);
      })
      .catch((err) => {
        log('CERT-ERROR', host, err.message);
        clientSocket.destroy();
      });
    return;
  }
  tlsServer.emit('connection', clientSocket);
});

// ---- WebSocket / 其它协议升级：原样隧道，不缓存 ----
function tunnelUpgrade(req, clientSocket, head, target) {
  const mod = target.protocol === 'http:' ? http : https;
  const upReq = mod.request({
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    method: req.method,
    path: target.path,
    headers: requestHeadersForUpstream(req.headers, target.host),
    agent: target.protocol === 'http:' ? httpAgent : httpsAgent,
    servername: target.host,
    rejectUnauthorized: !config.insecureUpstream,
  });

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
      else lines.push(`${k}: ${v}`);
    }
    clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) clientSocket.write(upHead);
    upSocket.pipe(clientSocket);
    clientSocket.pipe(upSocket);
    upSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upSocket.destroy());
  });

  upReq.on('response', (upRes) => {
    // 不是 101，就按普通响应返回
    clientSocket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
    upRes.pipe(clientSocket);
  });

  upReq.on('error', () => clientSocket.destroy());
  if (head && head.length) upReq.write(head);
  upReq.end();
}

proxyServer.on('upgrade', (req, socket, head) => {
  try {
    tunnelUpgrade(req, socket, head, parseTargetFromPlainRequest(req));
  } catch {
    socket.destroy();
  }
});

mitmHttp.on('upgrade', (req, socket, head) => {
  try {
    tunnelUpgrade(req, socket, head, targetFromMitm(req));
  } catch {
    socket.destroy();
  }
});

// ---- 统计页 ----
// PAC：GBF 相关域名走缓存代理；其余流量交给本机代理软件的端口（保持你平时的分流规则），
// 探测不到上游时才直连。代理没启动时浏览器会退回直连，不至于整体打不开网页。
function buildPac() {
  const rest =
    upstream.resolved.type === 'http'
      ? `PROXY 127.0.0.1:${upstream.resolved.port}`
      : 'DIRECT';
  // 页面上的第三方统计/广告脚本，在国内网络里多半被屏蔽或连不上，
  // 正常走要干等好几秒超时（实测有个脚本拖了 11 秒）。这里让它们"立刻失败"。
  const blocked = (config.blockHostPatterns || [])
    .map((p) => `  if (shExpMatch(host, '${p}')) return 'PROXY 127.0.0.1:9';\n`)
    .join('');
  return `function FindProxyForURL(url, host) {
  var P = 'PROXY 127.0.0.1:${LISTEN_PORT}; DIRECT';
${blocked}  // 127.0.0.1:9 是丢弃端口，连不上会立刻失败，不用干等超时
  if (host === 'granbluefantasy.jp' || dnsDomainIs(host, '.granbluefantasy.jp')) return P;
  if (dnsDomainIs(host, '.mbga.jp') || dnsDomainIs(host, '.mobage.jp')) return P;
  if (dnsDomainIs(host, '.granbluefantasy.com') || dnsDomainIs(host, '.cygames.jp')) return P;
  if (shExpMatch(host, 'prd-game-*.akamaized.net')) return P;
  if (shExpMatch(host, '*.gbf.game.mbga.jp')) return P;
  return '${rest}';
}
`;
}

// ---- 时延统计：把每个请求的分段耗时累积起来，供 /stats 输出 ----
//
// 目的是让"卡不卡、稳不稳"变成可查的数字，而不用翻几万行日志。
// 重点看 p90 与 max —— 卡顿感来自尾部延迟，平均值会把问题抹平。
const latency = {
  samples: [],      // 最近的往返样本（环形，只留最近 500 条）
  byPhase: { conn: [], tls: [], up: [], ttfb: [], body: [], total: [] },
  reuseOk: 0,       // 复用上游连接成功的次数
  newConn: 0,       // 新建上游连接的次数
  retries: 0,       // 重试次数
};

function recordLatency(t) {
  latency.samples.push({ at: Date.now(), ...t });
  if (latency.samples.length > 500) latency.samples.shift();
  for (const k of Object.keys(latency.byPhase)) {
    const v = t[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      latency.byPhase[k].push(v);
      if (latency.byPhase[k].length > 500) latency.byPhase[k].shift();
    }
  }
}

function phaseStats() {
  const out = {};
  for (const [k, arr] of Object.entries(latency.byPhase)) {
    if (!arr.length) continue;
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    out[k] = {
      n: s.length,
      min: Math.round(s[0]),
      p50: Math.round(q(0.5)),
      p90: Math.round(q(0.9)),
      p99: Math.round(q(0.99)),
      max: Math.round(s[s.length - 1]),
      mean: Math.round(mean),
      sd: Math.round(sd),
    };
  }
  return out;
}

/** 单次请求的耗时快照，写进日志用 */
let lastLatency = null;

const statsServer = http.createServer((req, res) => {
  if (req.url.startsWith('/proxy.pac')) {
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig; charset=utf-8' });
    res.end(buildPac());
    return;
  }
  const snapshot = {
    pid: process.pid,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    requests: stats.requests,
    hits: stats.hits,
    misses: stats.misses,
    bypass: stats.bypass,
    stored: stats.stored,
    revalidations: stats.revalidations,
    tunnels: stats.tunnels,
    aliased: stats.aliased,
    errors: stats.errors,
    overrides: stats.overrides,
    preflights: stats.preflights,
    missNoStore: stats.missNoStore,
    stale: stats.stale,
    hitRate: stats.hits + stats.misses ? +(stats.hits / (stats.hits + stats.misses) * 100).toFixed(1) : 0,
    bytesFromCache: stats.bytesFromCache,
    bytesFromNetwork: stats.bytesFromNetwork,
    upstream: upstream.describe(),
    cache: cache.stats(),
    latency: {
      ...phaseStats(),
      inflight: nowInFlight(),
      peakInflight: peakInFlight,
      reuse: latency.reuseOk,
      newConn: latency.newConn,
      retries: latency.retries,
    },
    hosts: Object.fromEntries([...stats.hosts.entries()].sort((a, b) => b[1].hits - a[1].hits)),
  };
  if (req.url.startsWith('/log')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ requests: recentRequests.slice(-200).reverse() }));
    return;
  }
  if (req.url.startsWith('/stats')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot, null, 2));
    return;
  }
  const rows = Object.entries(snapshot.hosts)
    .map(([h, v]) => `<tr><td>${h}</td><td>${v.hits}</td><td>${v.misses}</td><td>${v.bypass}</td></tr>`)
    .join('');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>GBF 缓存代理</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;margin:24px;background:#0f1115;color:#e6e6e6}
table{border-collapse:collapse;margin-top:12px}td,th{border:1px solid #333;padding:4px 10px;font-size:13px}
h1{font-size:18px}.big{font-size:26px;color:#7ee787}</style>
<h1>GBF 本地缓存代理</h1>
<p>运行 ${snapshot.uptimeSeconds}s ｜ 请求 ${snapshot.requests} ｜ 命中 <span class="big">${snapshot.hits}</span> ｜ 未命中 ${snapshot.misses} ｜ 透传 ${snapshot.bypass}</p>
<p>命中率 ${snapshot.hitRate}% ｜ 本地读盘 ${human(snapshot.bytesFromCache)} ｜ 外网下载 ${human(snapshot.bytesFromNetwork)}</p>
<p>缓存占用 ${snapshot.cache.megabytes} MB / ${(snapshot.cache.maxBytes / 1073741824).toFixed(0)} GB ｜ 对象 ${snapshot.cache.objects} 个 ｜ 淘汰 ${snapshot.cache.evictions}</p>
<p>魔改命中 ${snapshot.overrides} ｜ 预检本地应答 ${snapshot.preflights} ｜ 回源未入库 ${snapshot.missNoStore}</p>
<p>旧副本顶替 ${snapshot.stale} ｜ 闲置淘汰 ${snapshot.cache.idleEvictions} 个 ｜ 导入按需接管 ${snapshot.cache.adopted} 个</p>
<table><tr><th>host</th><th>命中</th><th>未命中</th><th>透传</th></tr>${rows}</table>
<h2 style="font-size:15px;margin-top:20px">实时请求流水（最近 200 条，每 2 秒刷新）</h2>
<p style="color:#8b93a1;font-size:12px">HIT=本地缓存命中（没走网络） ｜ MISS=走网络下载并存入缓存 ｜ OVERRIDE=魔改文件 ｜ STALE=上游出错、用旧副本顶了一次 ｜ BYPASS=动态接口，不缓存 ｜ TUNNEL=WebSocket 隧道</p>
<table id="live"><tr><th>时间</th><th>结果</th><th>大小</th><th>主机</th><th>路径</th></tr></table>
<p><a style="color:#79c0ff" href="/stats">/stats</a> ｜ <a style="color:#79c0ff" href="/log">/log</a>（JSON）</p>
<script>
function fmt(b){if(!b)return '';if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';return (b/1048576).toFixed(1)+' MB';}
function color(k){return k==='HIT'||k==='HIT-304'||k==='OVERRIDE'||k==='OPTIONS-HIT'?'#7ee787':(k==='STALE'||k==='RETRY-5XX'||k==='RETRY-STALE'||k==='MISS-NOSTORE')?'#ffd166':k==='MISS'||k==='MISS->STORE'?'#ffa657':k.indexOf('ERROR')>=0||k.indexOf('FAIL')>=0?'#ff7b72':'#8b93a1';}
async function tick(){
  try{
    const r=await fetch('/log');const j=await r.json();
    document.getElementById('live').innerHTML='<tr><th>时间</th><th>结果</th><th>大小</th><th>主机</th><th>路径</th></tr>'+
      j.requests.map(x=>'<tr><td>'+x.t+'</td><td style="color:'+color(x.kind)+'">'+x.kind+'</td><td>'+(x.size?fmt(x.size):'')+'</td><td>'+x.host+'</td><td style="color:#8b93a1">'+x.path+'</td></tr>').join('');
  }catch(e){}
}
tick();setInterval(tick,2000);
</script>`);
});

// ---------------------------------------------------------------- 启动

// ---------------------------------------------------------------- 一键开始玩 / 停止 / 清缓存

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortOpen(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(port, totalMs) {
  const until = Date.now() + totalMs;
  while (Date.now() < until) {
    if (await isPortOpen(port)) return true;
    await sleep(250);
  }
  return false;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function isChromeRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    return /chrome\.exe/i.test(out);
  } catch {
    return false;
  }
}

// 等用户按键或者等超时（双击运行时让窗口停一会儿，好让人看清提示）
function waitForEnterOrTimeout(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    try {
      process.stdin.resume();
      process.stdin.once('data', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      /* 没有标准输入就只等超时 */
    }
  });
}

async function playMode() {
  const pacUrl = `http://127.0.0.1:${STATS_PORT}/proxy.pac`;
  console.log('============================================');
  console.log('  碧蓝幻想 缓存加速');
  console.log('============================================');
  console.log('');

  console.log('[1/3] 检查缓存代理...');
  if (await isPortOpen(LISTEN_PORT)) {
    console.log('      已经在运行了');
  } else {
    const relaunchArgs = isSea ? ['--daemon'] : [process.argv[1], '--daemon'];
    const child = spawn(process.execPath, relaunchArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    if (!(await waitForPort(LISTEN_PORT, 10000))) {
      console.error('      启动失败，请查看 logs\\stdout.log');
      process.exitCode = 1;
      await waitForEnterOrTimeout(15000);
      return;
    }
    console.log('      已启动（后台运行）');
  }

  console.log('');
  console.log('[2/3] 检查 Chrome...');
  if (isChromeRunning()) {
    console.log('      发现 Chrome 正在运行。');
    console.log('      请先完全退出 Chrome（包括右下角托盘里的），再重新双击本程序。');
    console.log('      原因：Chrome 只在启动那一刻读取缓存设置。');
    console.log('      （缓存代理已经在后台跑着，不受影响）');
    await waitForEnterOrTimeout(20000);
    return;
  }
  console.log('      Chrome 没有在运行，继续');

  console.log('');
  console.log('[3/3] 打开带缓存的 Chrome...');
  const chrome = findChrome();
  if (!chrome) {
    console.log('      找不到 chrome.exe，请手动打开 Chrome 访问游戏。');
    await waitForEnterOrTimeout(15000);
    return;
  }
  const child = spawn(
    chrome,
    [
      `--proxy-pac-url=${pacUrl}`,
      '--disk-cache-size=2147483648',
      '--disable-quic',
      'https://game.granbluefantasy.jp/',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  console.log('      已打开');
  console.log('');
  console.log(`看缓存效果：http://127.0.0.1:${STATS_PORT}/`);
  console.log('停止缓存：在命令行里运行 Grancache.exe --stop');
  console.log('');
  console.log('这个窗口几秒后自动关闭，代理在后台继续跑。');
  await sleep(7000);
}

function pidFilePath() {
  return path.join(ROOT, 'runtime', 'logs', 'proxy.pid');
}

function writePidFile() {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
    fs.writeFileSync(pidFilePath(), String(process.pid), 'utf8');
  } catch {
    /* ignore */
  }
}

function removePidFile() {
  // 只删"属于自己"的 pid 文件：第二个实例在端口被占时会绑定失败并退出，
  // 它的退出处理器如果无脑删文件，就会把**正在跑的那个实例**的记录抹掉，
  // 之后 --stop 找不到它、面板的“停止”也失效。
  try {
    const cur = Number(String(fs.readFileSync(pidFilePath(), 'utf8')).trim());
    if (cur && cur !== process.pid) return;
    fs.rmSync(pidFilePath(), { force: true });
  } catch {
    /* 文件不存在或读不到：无需处理 */
  }
}

// 判断某个 pid 是不是本程序（exe 版叫 Grancache.exe，源码版是 node.exe）
function isOurProxyProcess(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
      windowsHide: true,
      encoding: 'utf8',
    });
    return /grancache\.exe|gbf-cache-proxy\.exe|node\.exe/i.test(out);
  } catch {
    return false;
  }
}

/**
 * 实例自证：直接问统计端口"你是谁"，回答里的 pid 与 pid 文件一致，才认为这个 pid 是我们的代理。
 * 比 tasklist 更可靠 —— 某些受限环境里 tasklist 会 Access denied，pid 也可能被系统复用。
 */
function probeProxyIdentity(pid) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: LISTEN_HOST, port: STATS_PORT, path: '/stats', timeout: 800 },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            resolve(Number(JSON.parse(b).pid) === Number(pid));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function stopMode() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(pidFilePath(), 'utf8').trim());
  } catch {
    /* 没有运行记录 */
  }
  if (!pid) {
    console.log('缓存代理没有在运行。');
    return;
  }
  // 只凭一个 pid 号就 kill 是有风险的：句柄被系统回收后可能分配给别的进程，
  // 那样就会误杀无关程序（旧版就是直接 kill）。先确认这个 pid 确实是代理自己：
  // 优先让它"自证"（统计端口回 JSON 里的 pid），拿不到再退回 tasklist 兜底。
  if (!(await probeProxyIdentity(pid)) && !isOurProxyProcess(pid)) {
    removePidFile();
    console.log(`记录里的进程 ${pid} 无法确认是本程序（统计端口没有应答、tasklist 也查不到），已清理 pid 文件，未杀任何进程。`);
    return;
  }
  try {
    process.kill(pid);
    removePidFile();
    console.log(`已停止缓存代理（进程 ${pid}）。`);
  } catch (err) {
    removePidFile();
    console.log(`停止失败（可能已经退出了）：${err.message}`);
  }
}

function clearMode() {
  // 路径镜像布局下，真实数据在 <cacheDir>/<scheme>/<host>/... 里，
  // 不再是 <cacheDir>/objects/<2位前缀>/<hash>。所以这里清空 cacheDir 的
  // 全部内容（cacheDir 下只有缓存，证书在单独的 certs/ 目录），
  // 顺带把旧布局遗留的 objects/ 一起清掉。
  // **保留 `_ap` 魔改文件**：那是用户手工放进去的，不该被"清缓存"顺手删掉。
  const dir = abs(config.cacheDir);
  if (!fs.existsSync(dir)) {
    console.log('没有缓存目录，无需清理。');
    return;
  }
  let bytes = 0;
  let count = 0;
  let kept = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        try {
          fs.rmdirSync(p); // 目录空了就顺手删掉；还有魔改文件时 rmdir 会失败，忽略
        } catch {
          /* 目录里还有保留文件 */
        }
        continue;
      }
      if (isOverridePath(e.name)) {
        kept++;
        continue;
      }
      if (e.name === RESCAN_SENTINEL) {
        kept++; // 待处理的重扫请求别被"清缓存"顺手删掉
        continue;
      }
      try {
        bytes += fs.statSync(p).size;
        count++;
      } catch {
        /* ignore */
      }
      fs.rmSync(p, { force: true });
    }
  };
  walk(dir);
  console.log(
    `已清空缓存：${count} 个文件 / ${(bytes / 1048576).toFixed(1)} MB` +
      (kept ? `（保留魔改文件 ${kept} 个）` : '')
  );
}

function helpMode() {
  console.log(`碧蓝幻想 缓存加速

双击本程序 = 一键开始：后台启动缓存代理，然后用带缓存的配置打开 Chrome 和游戏。

命令行参数：
  --serve        只运行缓存代理（前台，能看到日志）
  --daemon       只运行缓存代理（后台，无窗口）
  --stop         停止后台运行的缓存代理
  --clear-cache  清空素材缓存
  --port=18080   换监听端口（统计端口自动取 端口+1）
  --play         一键启动：后台起代理 + 用带缓存的配置打开 Chrome 和游戏（= 面板里的“一键启动”）
  --panel        打开控制面板（图形界面：一键启动 / 只开关缓存 / 清缓存 / 看日志）
  --panel-only   只启动面板服务，不自动打开窗口（调试用）
  --panel-port=18082  换面板端口

文件位置：
  配置      ${path.join(ROOT, 'config.json')}
  素材缓存  ${abs(config.cacheDir)}
  日志      ${path.join(ROOT, 'runtime', 'logs', 'proxy.log')}
  统计页面  http://127.0.0.1:${STATS_PORT}/

魔改素材（只影响你本地看到的画面，不改变任何请求）：
  把改好的文件重命名成「原名_ap.后缀」，放进素材缓存里对应的目录，例如
  ${path.join(abs(config.cacheDir), 'https', 'prd-game-a-granbluefantasy.akamaized.net', 'assets', 'img', '...')}
  线上叫 a.png 就放 a_ap.png。放好后在游戏里 Ctrl+F5 刷一次
  （洗掉浏览器里存着的原图），之后就不用再清了。`);
}

async function main() {
  if (archivedThisRun.length) {
    log(`[start] 上一轮日志已归档到 logs\\prev（${archivedThisRun.length} 个文件）：${archivedThisRun.join(', ')}`);
  }
  await cache.init();
  await certs.init();
  if (certs.caCreated) log('[certs] 首次运行：已自动生成本地 CA（runtime/certs/ca）');
  if (config.autoTrustCa !== false) {
    try {
      if (!(await certs.isTrusted())) {
        await certs.trustCa();
        log('WARN', '[certs] 已把本地 CA 装入「当前用户 → 受信任的根证书颁发机构」（卸载：scripts\\untrust.ps1）');
      }
    } catch (err) {
      log('WARN', `[certs] 自动安装 CA 信任失败：${err.message}（可手工运行 scripts\\trust.ps1）`);
    }
  }
  await upstream.init();
  log(`[upstream] 出口 = ${upstream.describe()}`);
  certsReady = true;
  fallbackContext = await certs.getSecureContext('localhost');

  proxyServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
    // 只有真正监听成功才写 pid 文件：起不来（比如端口被别的实例占着）时
    // 不能留下一个"指向死进程"的 pid —— 那会让 --stop 既停不掉真代理、又清掉记录。
    writePidFile();
    log(`[start] 代理监听 http://${LISTEN_HOST}:${LISTEN_PORT}`);
  });
  statsServer.listen(STATS_PORT, LISTEN_HOST, () => {
    log(`[start] 统计页 http://${LISTEN_HOST}:${STATS_PORT}/`);
  });

  if ((config.keepWarmSeconds || 0) > 0) {
    warmUp();
    setInterval(warmUp, config.keepWarmSeconds * 1000).unref();
    log(`[warm] 每 ${config.keepWarmSeconds} 秒对 ${(config.keepWarmHosts || []).join(', ')} 保温连接`);
  }

  const every = (config.printStatsEverySeconds || 60) * 1000;
  setInterval(() => {
    if (stats.requests === 0) return;
    const ph = phaseStats();
    const fmt = (k) => (ph[k] ? ` ${k}:${ph[k].p50}/${ph[k].p90}/${ph[k].max}` : '');
    log(
      `[stats] 请求=${stats.requests} 命中=${stats.hits} 未命中=${stats.misses} 透传=${stats.bypass} ` +
      `本地读盘=${human(stats.bytesFromCache)} 外网下载=${human(stats.bytesFromNetwork)} ` +
      `磁盘缓存=${cache.stats().megabytes}MB/${cache.stats().objects}个`
    );
    // 时延单独一行，格式 p50/p90/max，单位 ms —— 卡顿看 p90 和 max
    log(
      `[latency] 单位ms 中位/p90/最大` +
      fmt('total') + fmt('up') + fmt('ttfb') + fmt('body') + fmt('conn') + fmt('tls') +
      ` | 上游复用=${latency.reuseOk} 新建=${latency.newConn} 重试=${latency.retries} ` +
      `在途=${nowInFlight()}(峰值${peakInFlight})`
    );
  }, every).unref();

  // ---- 闲置淘汰（借 nginx proxy_cache_path 的 inactive 语义）：默认关闭 ----
  const inactiveMs = Math.max(0, Number(config.inactiveDays || 0) * 86400000);
  if (inactiveMs > 0) {
    const everyIdle = Math.max(1, Number(config.idleSweepMinutes || 30)) * 60000;
    // 分批（idleSweepFiles）删除，避免一次性抛几万个 IO 请求出去
    const sweep = () =>
      cache
        .evictIdle({ maxIdleMs: inactiveMs, limit: Math.max(1, Number(config.idleSweepFiles || 5000)) })
        .catch(() => {});
    setInterval(sweep, everyIdle).unref();
    log(
      `[cache] 每 ${everyIdle / 60000} 分钟做一次闲置淘汰：超过 ${(config.inactiveDays)} 天没被访问的对象会删掉`
    );
  }

  // ---- 导入缓存包后的后台重扫：哨兵文件由导入工具写，这里消费 ----
  const rescanEvery = Math.max(5, Number(config.rescanCheckSeconds || 60)) * 1000;
  setInterval(() => {
    const sentinel = path.join(abs(config.cacheDir), RESCAN_SENTINEL);
    try {
      if (!fs.existsSync(sentinel)) return;
      fs.rmSync(sentinel, { force: true }); // 先删哨兵：扫描失败也不会每轮重复触发
    } catch {
      return;
    }
    cache
      .rescan({ batch: Math.max(1000, Number(config.rescanBatchFiles || 20000)) })
      .then((r) => {
        log(`[cache] 后台重扫完成：扫描 ${r.scanned} 个 .ext，新增接管 ${r.added} 个对象（${r.ms} ms）`);
      })
      .catch((err) => log('ERROR', 'RESCAN-FAIL ' + err.message));
  }, rescanEvery).unref();
}

proxyServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${LISTEN_PORT} 已被占用：代理可能已经在运行了。`);
  } else {
    console.error('代理启动失败：', err);
  }
  process.exit(1);
});

// 统计页端口（默认 = 监听端口 + 1）也可能撞车；不给它兜底的话会直接抛栈退出，
// 用户只看到一堆 at Server.setupListenHandle，看不出是端口占用。
statsServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`统计页端口 ${STATS_PORT} 已被占用：换个端口再试（例如 --port=18090，统计页会跟着变成 18091）。`);
  } else {
    console.error('统计页启动失败：', err);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  log('[stop] 收到中断信号，退出');
  removePidFile();
  process.exit(0);
});

process.on('exit', () => removePidFile());

if (MODE === 'play') {
  playMode()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
      console.error('出错：' + err.message);
      process.exit(1);
    });
} else if (MODE === 'stop') {
  stopMode().finally(() => process.exit(0));
} else if (MODE === 'clear') {
  clearMode();
  process.exit(0);
} else if (MODE === 'help') {
  helpMode();
} else if (MODE === 'panel') {
  createPanel({
    root: ROOT,
    config,
    log,
    isSea,
    findChrome,
    requireFn: require,
    scriptPath: process.argv[1],
    statsPort: STATS_PORT,
    port: argPanelPort ? Number(argPanelPort.split('=')[1]) : undefined,
    openWindow: !PANEL_ONLY,
  });
} else {
  main().catch((err) => {
    console.error('启动失败：', err.message);
    process.exit(1);
  });
}
