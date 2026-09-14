'use strict';
/**
 * 结构化追踪报告：读 logs/events-*.jsonl，回答"素材到底有没有被缓存住"。
 * 字段与枚举的完整说明见 docs/plan-acgpower-cache-mvp.md 的"阶段 11"。
 *
 * 关键字段：key（缓存对象身份）、outcome（HIT/MISS/BYPASS/...）、store/storeReason、
 * missReasons（本机有对象却没命中的原因）、bytes/status/encoding/staleSeconds。
 *
 * 用法:
 *   node tools\report.cjs                # 今天的事件文件
 *   node tools\report.cjs --file <path>  # 指定文件
 *   node tools\report.cjs --top 20       # 明细列前 N 条
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const topIdx = args.indexOf('--top');
const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 10;
const allSessions = args.includes('--all'); // 默认只看"最近一次运行"的事件
const sessionIdx = args.indexOf('--session');
const wantSession = sessionIdx >= 0 ? args[sessionIdx + 1] : null;

function defaultFile() {
  const dir = path.join(ROOT, 'logs');
  const today = path.join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (fs.existsSync(today)) return today;
  const all = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^events-.*\.jsonl$/.test(f))
        .map((f) => path.join(dir, f))
        .sort()
    : [];
  return all[all.length - 1] || null;
}

const file = fileIdx >= 0 ? path.resolve(args[fileIdx + 1]) : defaultFile();
if (!file || !fs.existsSync(file)) {
  console.error('找不到事件文件（先让代理跑一次，会生成 logs\\events-YYYY-MM-DD.jsonl）');
  process.exit(2);
}

let events = fs
  .readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// 默认只分析最近一次运行的会话：这样"这一轮调优"的数据不会和上一轮串在一起。
// 想看全部用 --all；想指定某一轮用 --session <id>（id 在报告头部会列出来）。
const sessions = [...new Set(events.map((e) => e.session))];
if (wantSession) events = events.filter((e) => e.session === wantSession);
else if (!allSessions && sessions.length > 1) events = events.filter((e) => e.session === sessions[sessions.length - 1]);

const tally = (pairs) => {
  const out = {};
  for (const k of pairs) if (k) out[k] = (out[k] || 0) + 1;
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
};
const line = (k, v) => console.log(`  ${String(k).padEnd(30)} ${v}`);

const byKey = new Map();
for (const e of events) {
  if (!e.key) continue;
  if (!byKey.has(e.key)) byKey.set(e.key, []);
  byKey.get(e.key).push(e);
}

const warmMiss = [];
const neverHit = [];
const missThenHit = [];
for (const [key, list] of byKey) {
  const served = list.some((e) => ['HIT', 'HIT-304', 'OVERRIDE', 'OVERRIDE-304'].includes(e.outcome));
  for (const e of list) for (const r of e.missReasons || []) warmMiss.push(r);
  const mi = list.findIndex((e) => e.outcome === 'MISS');
  const hi = list.findIndex((e) => ['HIT', 'HIT-304'].includes(e.outcome));
  if (mi >= 0 && hi > mi) {
    missThenHit.push({ key, gapMs: Date.parse(list[hi].t) - Date.parse(list[mi].t), n: list.length });
  }
  if (!served && mi >= 0) {
    neverHit.push({ key, n: list.length, first: list[0].outcome, store: `${list[mi].store || '-'}:${list[mi].storeReason || '?'}` });
  }
}

console.log(`事件文件: ${file}`);
console.log(
  `事件数: ${events.length} ｜ 有身份的可缓存对象: ${byKey.size} ｜ 会话: ${[...new Set(events.map((e) => e.session))].join(', ')}\n`
);
if (!allSessions && sessions.length > 1) {
  console.log(`（本文件里有 ${sessions.length} 轮：${sessions.join(', ')}；上面只统计最后一轮。看全部加 --all，指定某一轮加 --session <id>）\n`);
}

console.log('=== 结果分布（outcome）===');
for (const [k, v] of tally(events.map((e) => e.outcome))) line(k, v);

console.log('\n=== 不可缓存的原因（bypassReason）===');
const bp = tally(events.filter((e) => !e.cacheable).map((e) => e.bypassReason || 'unknown'));
if (!bp.length) console.log('  （没有）');
for (const [k, v] of bp) line(k, v);

console.log('\n=== 写入结果（store:reason）===');
const st = tally(events.filter((e) => e.store).map((e) => `${e.store}:${e.storeReason || '?'}`));
if (!st.length) console.log('  （没有）');
for (const [k, v] of st) line(k, v);

console.log('\n=== 关键追踪问题 ===');
line('先 MISS 后 HIT 的对象数', missThenHit.length);
line('只 MISS、从未命中的对象数', neverHit.length);
const wm = tally(warmMiss);
if (wm.length) {
  console.log('  "本机有对象却没命中"的原因:');
  for (const [k, v] of wm) line(`  ${k}`, v);
}
if (missThenHit.length) {
  console.log(`\n  —— 先 MISS 后 HIT（前 ${Math.min(top, missThenHit.length)} 条）——`);
  for (const r of missThenHit.sort((a, b) => b.gapMs - a.gapMs).slice(0, top)) {
    console.log(`   ${String(r.gapMs).padStart(8)} ms 后命中 ｜ 共 ${String(r.n).padStart(3)} 次 ｜ ${r.key}`);
  }
}
if (neverHit.length) {
  console.log(`\n  —— 从未命中（前 ${Math.min(top, neverHit.length)} 条）——`);
  for (const r of neverHit.slice(0, top)) {
    console.log(`   首次=${r.first} 请求数=${r.n} 写入=${r.store} ｜ ${r.key}`);
  }
}

// ---------------------------------------------------------------- 调优视角
const pct = (arr, q) => {
  const s = [...arr].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : NaN;
};
const msOf = (e) => (e.ms && Number.isFinite(e.ms.total) ? e.ms.total : null);
const isLocal = (e) => ['HIT', 'HIT-304', 'OVERRIDE', 'OVERRIDE-304', 'STALE'].includes(e.outcome);
const localMs = events.filter(isLocal).map(msOf).filter((v) => v !== null);
const netMs = events.filter((e) => e.outcome === 'MISS').map(msOf).filter((v) => v !== null);
const allMs = events.map(msOf).filter((v) => v !== null);

console.log('\n=== 调优视角 ===');
console.log('  【时延】单位 ms，p50 / p90 / max');
const line2 = (k, arr) =>
  console.log(
    `  ${k.padEnd(30)} ${String(pct(arr, 0.5)).padStart(5)} / ${String(pct(arr, 0.9)).padStart(5)} / ${String(pct(arr, 1)).padStart(5)}   样本 ${arr.length}`
  );
if (localMs.length) line2('本地命中', localMs);
if (netMs.length) line2('回源（MISS）', netMs);
line2('全部请求', allMs);
const reuse = events.filter((e) => e.conn).map((e) => e.conn.reuse);
if (reuse.length) {
  const r = reuse.filter(Boolean).length;
  console.log(`  ${'上游连接复用'.padEnd(30)} ${r}/${reuse.length}（${((r / reuse.length) * 100).toFixed(0)}% 复用；复用率低 = 在建连上白花时间）`);
}

// 每主机命中率（找"哪个域名的素材老是回源"）
const hostStat = new Map();
for (const e of events) {
  if (!e.cacheable) continue;
  const h = hostStat.get(e.host) || { req: 0, hit: 0, miss: 0 };
  h.req++;
  if (isLocal(e)) h.hit++;
  else if (e.outcome === 'MISS') h.miss++;
  hostStat.set(e.host, h);
}
if (hostStat.size) {
  console.log('\n  【按主机的命中率】（低 = 这个域名下还有可缓存的素材在反复回源）');
  for (const [h, v] of [...hostStat.entries()].sort((a, b) => a[1].hit / a[1].req - b[1].hit / b[1].req).slice(0, 8)) {
    console.log(`   ${String(((v.hit / v.req) * 100).toFixed(0)).padStart(3)}%  命中 ${String(v.hit).padStart(4)} / 回源 ${String(v.miss).padStart(4)} / 请求 ${String(v.req).padStart(4)} ｜ ${h}`);
  }
}

// 反复未命中的对象：调优的第一批候选（预热、加索引、或查为什么不入库）
const repeated = [...byKey.entries()]
  .map(([key, list]) => ({ key, miss: list.filter((e) => e.outcome === 'MISS').length, hit: list.filter(isLocal).length, n: list.length }))
  .filter((r) => r.miss > 0)
  .sort((a, b) => b.miss - a.miss)
  .slice(0, top);
if (repeated.length) {
  console.log('\n  【多次回源的对象 Top】（同一个 key 反复 MISS = 缓存没起作用，优先查）');
  for (const r of repeated) {
    console.log(`   MISS ${String(r.miss).padStart(3)} 次 ｜ 命中 ${String(r.hit).padStart(3)} ｜ 请求 ${String(r.n).padStart(3)} ｜ ${r.key}`);
  }
}

// 最慢的请求
const slowest = events.filter((e) => msOf(e) !== null).sort((a, b) => msOf(b) - msOf(a)).slice(0, Math.min(5, top));
if (slowest.length) {
  console.log('\n  【最慢的请求】');
  for (const e of slowest) {
    console.log(
      `   ${String(msOf(e)).padStart(6)} ms ｜ ${e.outcome.padEnd(12)} ｜ up=${String(e.ms.up ?? '-').padStart(5)} 复用=${e.conn ? e.conn.reuse : '?'} ｜ ${e.host}${e.path.slice(0, 48)}`
    );
  }
}
console.log('');
