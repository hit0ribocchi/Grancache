'use strict';
/**
 * 量化 PathCache 的两笔新开销（残留风险里"未实测"的那两项）：
 *   1. 启动建索引：N 个对象要多久（旧 objects 布局同样是"每对象一个小 JSON"）
 *   2. 命中路径上多出来的 stat：魔改查找（overrideFor）+ 主机回退候选
 *
 * 全程临时目录，不碰 D:/gbf-cache 和真实 config.json。
 * 用法: node tools/micro.cjs [对象数，默认 10000]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PathCache } = require(path.join(ROOT, 'src', 'cache.js'));
const policy = require(path.join(ROOT, 'src', 'policy.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const N = Math.max(100, Number(process.argv[2] || 10000));
const READS = 3000;
const BODY = Buffer.alloc(4096, 7);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-bench-'));
const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const fmt = (v) => (v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : Math.round(v).toString());

function plant(i) {
  const rel = `https/prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/batch${i >> 8}/${i}.png`;
  const abs = path.join(tmp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, BODY);
  fs.writeFileSync(
    abs + '.ext',
    JSON.stringify({
      v: 1,
      url: 'https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/' + i + '.png',
      at: Math.floor(Date.now() / 1000),
      size: BODY.length,
      storedAt: Date.now() - 86400000,
      lastAccess: Date.now() - 86400000,
      expiresAt: 0,
      ct: 'image/png',
      ce: '',
      headers: { 'content-type': 'image/png' },
    })
  );
  return rel;
}

(async () => {
  console.log(`临时目录: ${tmp}`);
  console.log(`造 ${N} 个对象（每个 ${BODY.length / 1024} KB + 一个 .ext）...`);
  const tGen0 = Date.now();
  const rels = [];
  for (let i = 0; i < N; i++) rels.push(plant(i));
  console.log(`  生成耗时 ${Date.now() - tGen0} ms，占用约 ${((N * (BODY.length + 900)) / 1048576).toFixed(1)} MB`);

  const cache = new PathCache({ dir: tmp, maxBytes: 20 * 1073741824, contentTypeFor: policy.contentTypeForExtension });
  const t0 = Date.now();
  await cache.init();
  const initMs = Date.now() - t0;
  console.log(`\n[1] 启动建索引：${initMs} ms（${(initMs / N).toFixed(3)} ms/对象，${cache.stats().objects} 个对象）`);
  console.log(`    对照：旧 objects 布局同样是"每个对象一个小 JSON"，量级相同`);

  // 命中路径：单候选（本机 host）
  const one = [];
  for (let i = 0; i < READS; i++) {
    const key = rels[(i * 7919) % N];
    const t = performance.now();
    await cache.get([key], { keepExpired: true });
    one.push(performance.now() - t);
  }
  // 命中路径：候选里带主机回退（proxy 传入的真实形态）
  const two = [];
  for (let i = 0; i < READS; i++) {
    const key = rels[(i * 7919) % N];
    const cand = [key, key.replace('https/', `https/${config.cacheHostFallback}/`)];
    const t = performance.now();
    await cache.get(cand, { keepExpired: true });
    two.push(performance.now() - t);
  }
  // 魔改查找：无魔改文件（每次 1 次 stat，命中页表缓存）
  const ov = [];
  for (let i = 0; i < READS; i++) {
    const key = rels[(i * 7919) % N];
    const t = performance.now();
    await cache.overrideFor([key]);
    ov.push(performance.now() - t);
  }
  console.log(`\n[2] 命中路径（单位 ms，p50/p90/p99）`);
  console.log(`    只看缓存命中          ${fmt(pct(one, 0.5))} / ${fmt(pct(one, 0.9))} / ${fmt(pct(one, 0.99))}`);
  console.log(`    缓存 + 主机回退候选    ${fmt(pct(two, 0.5))} / ${fmt(pct(two, 0.9))} / ${fmt(pct(two, 0.99))}`);
  console.log(`    魔改查找（1 次 stat）  ${fmt(pct(ov, 0.5))} / ${fmt(pct(ov, 0.9))} / ${fmt(pct(ov, 0.99))}`);
  const overhead = pct(ov, 0.5) + (pct(two, 0.5) - pct(one, 0.5));
  const lo = (overhead / 440) * 100;
  const hi = (overhead / 150) * 100;
  console.log(
    `    两项合计 p50 约 ${fmt(overhead)} ms —— 占一次网络回源（150~440 ms）的 ${lo.toFixed(3)}%~${hi.toFixed(3)}%`
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n完成（临时目录已清理）');
})().catch((e) => {
  console.error('基准失败:', e);
  process.exit(1);
});
