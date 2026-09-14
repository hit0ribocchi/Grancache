'use strict';
// 日志审计：把 proxy.log 里的缓存命中/素材路径/非 200 响应摊开看。
// 用来定位"太郎插件图片加载不出来"这类问题。
//
// 用法: node tools/audit.cjs [logPath]
const fs = require('fs');
const path = require('path');

const logPath = process.argv[2] || path.join(__dirname, '..', 'runtime', 'logs', 'proxy.log');
const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);

// 行格式: <ISO时间> <LEVEL>? <VERB> <size?> (<reason>)? <host> <path> | <timing>
// LEVEL 是新加的（DEBUG/INFO/WARN/ERROR），老日志没有这一列，所以写成可选。
const RE = /^(\S+)\s+(?:(?:DEBUG|INFO|WARN|ERROR)\s+)?(BYPASS|MISS->STORE|MISS-TOOBIG|MISS-NOSTORE|OVERRIDE|OPTIONS-HIT|HIT-304|HIT|REVALIDATED-NEW|REVALIDATED-304|STORE-ERROR|UPSTREAM-ERROR|UPSTREAM-STREAM-ERROR|RETRY-STALE|BYPASS-FASTFAIL|SERVE)\b(.*)$/;
const PATH_RE = /\s([a-z0-9.-]+\.[a-z]{2,})\s(\/\S*)/i;

const rows = [];
for (const line of lines) {
  const m = RE.exec(line);
  if (!m) continue;
  const [, ts, verb, rest] = m;
  const p = PATH_RE.exec(rest);
  const status = /^\s+(\d{3})\s/.exec(rest);
  rows.push({
    ts,
    verb,
    status: status ? status[1] : '',
    host: p ? p[1] : '',
    path: p ? p[2].split('?')[0] : '',
    raw: line,
  });
}

const verbCount = {};
for (const r of rows) verbCount[r.verb] = (verbCount[r.verb] || 0) + 1;

console.log(`日志共 ${lines.length} 行，识别出 ${rows.length} 条请求记录`);
console.log('动词分布:', JSON.stringify(verbCount));
console.log('');

// ---- 1) 所有 HIT（真正走缓存的）----
const hits = rows.filter((r) => r.verb === 'HIT' || r.verb === 'HIT-304');
console.log(`=== HIT 明细（共 ${hits.length} 条，按路径去重）===`);
const hitByPath = new Map();
for (const h of hits) {
  const k = h.host + h.path;
  hitByPath.set(k, (hitByPath.get(k) || 0) + 1);
}
for (const [k, n] of [...hitByPath].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);
console.log('');

// ---- 2) 素材路径的缓存表现 ----
const isAssetPath = (p) => /\.(png|jpe?g|webp|gif|svg|ico|bmp|avif|mp3|m4a|ogg|wav|aac|mp4|webm|woff2?|ttf|otf|css|js|bin|atlas|skel)$/i.test(p);
const buckets = new Map(); // 前缀 -> {count,hit,store,bypass}
for (const r of rows) {
  if (!isAssetPath(r.path)) continue;
  const mm = /^(\/(?:assets\/img_mid|assets\/img|assets\/sound|sp\/assets|assets\/[a-z_]+|sp\/[a-z_]+))/.exec(r.path);
  const prefix = mm ? mm[1] : '(其他素材)';
  let b = buckets.get(prefix);
  if (!b) { b = { count: 0, HIT: 0, STORE: 0, BYPASS: 0, other: 0 }; buckets.set(prefix, b); }
  b.count++;
  if (r.verb === 'HIT' || r.verb === 'HIT-304') b.HIT++;
  else if (r.verb === 'MISS->STORE') b.STORE++;
  else if (r.verb === 'BYPASS') b.BYPASS++;
  else b.other++;
}
console.log('=== 素材路径缓存表现 ===');
console.log('前缀\t\t总\tHIT\tSTORE\tBYPASS\t其他');
for (const [k, b] of [...buckets].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${k.padEnd(22)}\t${b.count}\t${b.HIT}\t${b.STORE}\t${b.BYPASS}\t${b.other}`);
}
console.log('');

// ---- 3) 非 200 / 非 2xx 响应 ----
console.log('=== 非 2xx 响应 ===');
const bad = rows.filter((r) => r.status && !/^2/.test(r.status));
if (!bad.length) console.log('  （无）');
for (const b of bad.slice(0, 60)) console.log(`  ${b.status} ${b.verb} ${b.host}${b.path}`);
console.log('');

// ---- 4) 被 BYPASS 的素材（理论上应该缓存却没缓存的）----
console.log('=== 被 BYPASS 的素材类请求 ===');
const skipped = rows.filter((r) => r.verb === 'BYPASS' && isAssetPath(r.path));
if (!skipped.length) console.log('  （无）');
for (const s of skipped.slice(0, 60)) {
  const reason = /\(([^)]*)\)/.exec(s.raw);
  console.log(`  ${s.status} ${s.host}${s.path}  reason=${reason ? reason[1] : '?'}`);
}
console.log('');

// ---- 5) 同一路径重复 STORE（本该命中却每次都 MISS）----
console.log('=== 重复 STORE 的素材（同一路径存了 ≥2 次，说明缓存键没稳定命中）===');
const storeByPath = new Map();
for (const r of rows) {
  if (r.verb !== 'MISS->STORE') continue;
  const k = r.host + r.path;
  storeByPath.set(k, (storeByPath.get(k) || 0) + 1);
}
const repeats = [...storeByPath].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
if (!repeats.length) console.log('  （无）');
for (const [k, n] of repeats.slice(0, 40)) console.log(`  ${n}\t${k}`);
console.log('');

// ---- 6) 主机汇总 ----
console.log('=== 主机请求量 ===');
const hostCount = new Map();
for (const r of rows) if (r.host) hostCount.set(r.host, (hostCount.get(r.host) || 0) + 1);
for (const [h, n] of [...hostCount].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${h}`);
