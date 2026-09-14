#!/usr/bin/env node
/*
 * 从 runtime/logs/proxy.log 里读出带分段耗时的请求，做卡顿归因。
 *
 * 用法：
 *   node tools/latency.cjs              # 分析最近一次代理启动之后的所有请求
 *   node tools/latency.cjs 500          # 只取最后 500 条带耗时的请求
 *   node tools/latency.cjs --since 17:46
 *
 * 判读要点（详见 README 的「实测归因结论」）：
 *   - 卡顿看 p90 / max，不看平均值
 *   - newconn 的 conn 耗时若远高于 reuse 的 up，说明建连是主要成本
 *   - 慢建连若按时间聚集而非按并发度聚集，那是上游/出口侧的问题，代理改不了
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'runtime', 'logs', 'proxy.log');

const args = process.argv.slice(2);
let limit = 0;
let since = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--since') since = args[++i];
  else if (/^\d+$/.test(args[i])) limit = Number(args[i]);
}

function readTail(file, maxBytes = 4 * 1024 * 1024) {
  const st = fs.statSync(file);
  const take = Math.min(maxBytes, st.size);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(take);
  fs.readSync(fd, buf, 0, take, st.size - take);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

function pick(line, key) {
  const m = line.match(new RegExp(`\\b${key}=(\\d+)`));
  return m ? Number(m[1]) : null;
}

function pickFlag(line, key) {
  const m = line.match(new RegExp(`\\b${key}(\\d+)\\b`));
  return m ? Number(m[1]) : null;
}

function hostOf(line) {
  const m = line.match(/\)\s+(\S+)\s+\//);
  if (m) return m[1];
  const m2 = line.match(/^(?:HIT|MISS->STORE|REVALIDATE-\S+)\s+\S+\s+(\S+)\s+\//);
  if (m2) return m2[1];
  return '(未识别)';
}

// 日志第二列是新加的级别（DEBUG/INFO/WARN/ERROR）。解析动词/主机名时要先把它剥掉，
// 否则老脚本会把 "INFO" 当成状态码。老格式（没有级别列）不受影响。
const stripLevel = (line) => String(line).replace(/^(\S+ )((?:DEBUG|INFO|WARN|ERROR) )/, '$1');

function stats(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const at = (q) => a[Math.min(a.length - 1, Math.floor(a.length * q))];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
  return {
    n: a.length,
    min: a[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: a[a.length - 1],
    mean: Math.round(mean),
    sd: Math.round(sd),
  };
}

const fmt = (s) =>
  s ? `${String(s.p50).padStart(5)} / ${String(s.p90).padStart(5)} / ${String(s.p99).padStart(5)} / ${String(s.max).padStart(6)}` : '                     ';

if (!fs.existsSync(LOG)) {
  console.error(`找不到日志：${LOG}`);
  process.exit(1);
}

const text = readTail(LOG);
const allLines = text.split(/\r?\n/).filter((l) => /^\d{4}-/.test(l));

// 找到最后一次 `[start] 代理监听` 的位置，只分析这之后的
let startIdx = 0;
for (let i = allLines.length - 1; i >= 0; i--) {
  if (/\[start\] 代理监听/.test(allLines[i])) {
    startIdx = i;
    break;
  }
}

let lines = allLines.slice(startIdx);
if (since) lines = lines.filter((l) => l.slice(11, 16) >= since);

const rows = [];
for (const l of lines) {
  const total = pick(l, 'total');
  if (total === null) continue;
  rows.push({
    raw: l,
    ts: l.match(/^(\S+)/)[1],
    host: hostOf(stripLevel(l)),
    total,
    conn: pick(l, 'conn'),
    up: pick(l, 'up'),
    ttfb: pick(l, 'ttfb'),
    body: pick(l, 'body'),
    cache: pick(l, 'cache'),
    store: pick(l, 'store'),
    newconn: /\bnewconn\b/.test(l),
    reuse: /\breuse\b/.test(l),
    retry: pickFlag(l, 'retry'),
    inflight: pickFlag(l, 'in'),
    status: (stripLevel(l).match(/^\S+ (\S+) (\S+)\s/) || [])[1] || '',
    kind: (stripLevel(l).match(/^\S+ (BYPASS|HIT|HIT-304|MISS->STORE|MISS-NOSTORE|OVERRIDE|OPTIONS-HIT|REVALIDATE-\S+)/) || [])[1] || '',
  });
}

if (limit > 0) rows.splice(0, Math.max(0, rows.length - limit));

if (!rows.length) {
  console.log('没有找到带分段耗时的日志行。');
  console.log('如果你的代理是老版本 exe，日志行尾不会带 `| conn=... up=... total=...`，需要重新打包。');
  process.exit(0);
}

const started = allLines[startIdx] ? allLines[startIdx].slice(11, 19) : '?';
console.log(`日志：${LOG}`);
console.log(`本次代理启动：${started}`);
console.log(`带耗时请求：${rows.length} 条\n`);

console.log('==== 各阶段时延（p50 / p90 / p99 / max，单位 ms）====');
console.log(`  total    ${fmt(stats(rows.map((r) => r.total)))}`);
console.log(`  up       ${fmt(stats(rows.map((r) => r.up).filter((v) => v !== null)))}`);
console.log(`  body     ${fmt(stats(rows.map((r) => r.body).filter((v) => v !== null)))}`);
console.log(`  conn     ${fmt(stats(rows.map((r) => r.conn).filter((v) => v !== null)))}`);
console.log(`  cache    ${fmt(stats(rows.map((r) => r.cache).filter((v) => v !== null)))}`);
console.log(`  store    ${fmt(stats(rows.map((r) => r.store).filter((v) => v !== null)))}`);

const nc = rows.filter((r) => r.newconn);
const ru = rows.filter((r) => r.reuse);
console.log(`\n==== 新建连接 vs 复用连接 ====`);
console.log(`  新建 ${String(nc.length).padStart(4)} 条  total ${fmt(stats(nc.map((r) => r.total)))}`);
console.log(`  复用 ${String(ru.length).padStart(4)} 条  total ${fmt(stats(ru.map((r) => r.total)))}`);
if (nc.length) {
  const connTimes = stats(nc.map((r) => r.conn).filter((v) => v !== null));
  console.log(`  其中建连本身（conn）：${fmt(connTimes)}`);
}
const retries = rows.reduce((s, r) => s + (r.retry || 0), 0);
if (retries) console.log(`  重试次数合计：${retries}`);

console.log(`\n==== 各主机 ====`);
console.log('  主机                                         请求   新建   复用   total p50 / p90 / p99 / max');
const byHost = new Map();
for (const r of rows) {
  if (!byHost.has(r.host)) byHost.set(r.host, []);
  byHost.get(r.host).push(r);
}
for (const [h, a] of [...byHost].sort((x, y) => y[1].length - x[1].length)) {
  console.log(
    `  ${h.padEnd(44)} ${String(a.length).padStart(5)} ${String(a.filter((r) => r.newconn).length).padStart(5)} ` +
      `${String(a.filter((r) => r.reuse).length).padStart(5)}   ${fmt(stats(a.map((r) => r.total)))}`
  );
}

console.log(`\n==== 最慢 15 条 ====`);
for (const r of [...rows].sort((a, b) => b.total - a.total).slice(0, 15)) {
  const flags = [r.newconn ? 'newconn' : r.reuse ? 'reuse' : '', r.conn !== null ? `conn=${r.conn}` : '', r.inflight !== null ? `in${r.inflight}` : '']
    .filter(Boolean)
    .join(' ');
  console.log(
    `  ${String(r.total).padStart(6)}ms  ${r.ts.slice(11, 23)}  ${r.host.padEnd(34)} ${r.kind.padEnd(13)} ${flags}`
  );
}

// 时间聚集性：慢请求是否按窗口扎堆（而非按并发度）
const slowCut = stats(rows.map((r) => r.total)).p90;
const slow = rows.filter((r) => r.total >= slowCut);
const window = (r, ms) => rows.filter((x) => Math.abs(new Date(x.ts) - new Date(r.ts)) <= ms && x !== r).length;
if (slow.length >= 3) {
  const avgSlow = slow.reduce((s, r) => s + window(r, 1500), 0) / slow.length;
  const fast = rows.filter((r) => r.total < slowCut);
  const avgFast = fast.length ? fast.reduce((s, r) => s + window(r, 1500), 0) / fast.length : 0;
  console.log(`\n==== 聚集性检验（判断是自身并发还是上游问题）====`);
  console.log(`  慢请求（>= p90=${slowCut}ms）出现时，前后 1.5s 内的请求数均值：${avgSlow.toFixed(1)}`);
  console.log(`  快请求出现时，前后 1.5s 内的请求数均值：${avgFast.toFixed(1)}`);
  console.log(
    avgSlow > avgFast * 1.5
      ? '  → 慢请求明显扎堆：说明是"一瞬间请求多了"，可考虑压低并发'
      : '  → 快慢请求的并发环境差不多：说明是上游/出口在那个瞬间变慢，代理侧改不了'
  );
}

// 最重要的判据：单次"刷新"的墙钟 vs 各请求耗时之和
// 两者接近 → 游戏串行发请求，卡 = 几十次往返的累加（这就是"卡"的本质）
// 墙钟远小于和 → 并发良好
console.log(`\n==== 单次刷新的墙钟 vs 请求耗时之和（最关键）====`);
const sorted = [...rows].sort((a, b) => new Date(a.ts) - new Date(b.ts));
const sessions = [];
let cur = [];
for (const r of sorted) {
  const ts = new Date(r.ts).getTime();
  if (cur.length && ts - new Date(cur[cur.length - 1].ts).getTime() > 3000) {
    sessions.push(cur);
    cur = [];
  }
  cur.push(r);
}
if (cur.length) sessions.push(cur);
sessions.sort((a, b) => b.length - a.length);

console.log('  时刻       请求数   墙钟    耗时之和  最慢    串行度');
for (const s of sessions.slice(0, 5)) {
  const wall = (new Date(s[s.length - 1].ts) - new Date(s[0].ts)) / 1000;
  const sum = s.reduce((a, r) => a + r.total, 0) / 1000;
  const mx = Math.max(...s.map((r) => r.total));
  const ratio = wall > 0 ? sum / wall : 0;
  console.log(
    `  ${s[0].ts.slice(11, 19)}  ${String(s.length).padStart(5)}  ${wall.toFixed(1).padStart(6)}s  ` +
      `${sum.toFixed(1).padStart(8)}s  ${String(mx).padStart(6)}ms  ${ratio.toFixed(2)}`
  );
}
const big = sessions.filter((s) => s.length >= 10).sort((a, b) => b.length - a.length)[0];
if (big) {
  const wall = (new Date(big[big.length - 1].ts) - new Date(big[0].ts)) / 1000;
  const sum = big.reduce((a, r) => a + r.total, 0) / 1000;
  const nc = big.filter((r) => !r.newconn && !r.reuse).length;
  console.log('');
  console.log(`  最大的一次刷新：${big.length} 个请求，墙钟 ${wall.toFixed(1)}s，耗时之和 ${sum.toFixed(1)}s`);
  console.log(
    sum / (wall || 1) > 0.8
      ? '  → 串行度接近 1：游戏是串行发请求的，卡 = 几十次往返的累加'
      : '  → 串行度明显小于 1：请求有并发，不是纯串行累加'
  );
  console.log(`  → 缓存命中 ${big.filter((r) => r.kind === 'HIT').length} 个，透传 ${big.filter((r) => r.kind === 'BYPASS').length} 个`);
  console.log('  → 透传的是不能缓存的动态接口（/rest/、/party/、带 Set-Cookie 的页面），');
  console.log('    代理缓存的素材本来就不阻塞界面 → 再加缓存救不了这个卡，只能降低单次 RTT。');
}

console.log(`\n判读：卡顿看 p90 和 max。若 conn 高而 up 不高 → 建连慢；`);
console.log(`      若 conn 正常但 up 高 → 发出去等响应慢，是上游或出口的问题（换节点）。`);
