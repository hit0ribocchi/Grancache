// 端到端时延基准测试：完全走代理（127.0.0.1:18080），模拟浏览器发起的真实请求。
//
// 目的：回答"卡不卡"和"稳不稳定"，所以每类请求都跑 N 次，输出
//   min / 中位 / p90 / max / 标准差 / 抖动（max-min）
// 而不只是平均值 —— 卡顿感来自尾部延迟（p90/max），不是平均。
//
// 用法：
//   node tools/bench.mjs             # 默认每项 12 次
//   node tools/bench.mjs 20          # 每项 20 次
//   node tools/bench.mjs 12 direct   # 绕过代理，测原始链路做对照
//
// 注意：被测 URL 里的 _= / t= 是游戏的缓存击穿参数，这里保留原样，
// 因为它们正是决定"能不能命中"的输入。

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const PROXY = { host: '127.0.0.1', port: 18080 };
const ROUNDS = Number(process.argv[2]) || 12;
const USE_DIRECT = process.argv[3] === 'direct';

// ---- 测试用例：按"优化空间"分类 ----
const CASES = [
  {
    name: '缓存命中（素材 CDN）',
    host: 'prd-game-a-granbluefantasy.akamaized.net',
    path: '/assets/img/sp/ui/icon/status/x64/status_1302.png',
    expect: 'HIT',
    note: '应 <10ms，若偏高说明读盘或 LRU 有问题',
  },
  {
    name: '素材 CDN 未缓存',
    host: 'prd-game-a-granbluefantasy.akamaized.net',
    path: '/assets/img/sp/ui/icon/status/x64/status_7604_1.png',
    expect: 'MISS/HIT',
    note: '走上游，反映 CDN 回源速度',
  },
  {
    name: '游戏动态页（不可缓存）',
    host: 'game.granbluefantasy.jp',
    path: '/',
    expect: 'BYPASS',
    note: '核心指标：副本内刷新的主成本就在这里',
  },
  {
    name: '游戏接口（/rest/）',
    host: 'game.granbluefantasy.jp',
    path: '/rest/sound/quest_map_bgm?location_id=normal&_=1789232665694&t=1789232665694',
    expect: 'BYPASS',
    note: '实时接口，必须走上游',
  },
  {
    name: '埋点（已屏蔽）',
    host: 'event-api.analytics.mbga.jp',
    path: '/nbpf',
    expect: 'blocked',
    note: 'PAC 里指向 127.0.0.1:9，应立刻失败（<5ms）',
  },
];

// ---- 单次请求：手工做 CONNECT + TLS，能精确分段计时 ----
function once({ host, path }) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const timings = { connect: 0, tls: 0, ttfb: 0, total: 0 };
    let sock;

    const finish = (result) => {
      try {
        sock?.destroy();
      } catch {}
      resolve(result);
    };

    const onError = (node, err) => {
      timings.total = performance.now() - t0;
      finish({ ...timings, status: 0, bytes: 0, err: node + ':' + (err.code || err.message) });
    };

    // 直连模式：跳过代理，直接对目标建 TLS
    if (USE_DIRECT) {
      const ts = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
        timings.tls = performance.now() - t0;
        send(ts);
      });
      ts.once('error', (e) => onError('tls', e));
      ts.once('secureConnect', () => {
        timings.connect = timings.tls;
      });
      sock = ts;
      return;
    }

    sock = net.connect(PROXY);
    sock.once('error', (e) => onError('proxy', e));
    sock.setTimeout(20000, () => onError('timeout', new Error('timeout')));
    sock.once('connect', () => {
      timings.connect = performance.now() - t0;
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      let buf = '';
      const onData = (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          sock.removeListener('data', onData);
          // 代理拒绝了 CONNECT（如埋点被指向丢弃端口）
          if (!/^HTTP\/1\.[01] 200/.test(buf)) {
            timings.total = performance.now() - t0;
            return finish({ ...timings, status: Number((buf.match(/ (\d{3}) /) || [])[1]) || 0, bytes: 0, err: 'connect-refused' });
          }
          const ts = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
            timings.tls = performance.now() - t0;
            send(ts);
          });
          ts.once('error', (e) => onError('tls', e));
        }
      };
      sock.on('data', onData);
    });

    function send(ts) {
      const tReq = performance.now();
      ts.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n` +
          `Accept-Encoding: gzip\r\nAccept: */*\r\nUser-Agent: bench-latency\r\n\r\n`
      );
      let bytes = 0;
      let headerEnd = -1;
      let status = 0;
      let firstByteAt = 0;
      const onData = (d) => {
        if (firstByteAt === 0) firstByteAt = performance.now();
        bytes += d.length;
        if (headerEnd < 0) {
          headerEnd = d.indexOf('\r\n\r\n');
          if (headerEnd >= 0) {
            status = Number((d.toString('latin1', 0, 64).match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]) || 0;
          }
        }
      };
      ts.on('data', onData);
      const done = () => {
        timings.ttfb = firstByteAt ? firstByteAt - tReq : 0;
        timings.total = performance.now() - t0;
        finish({ ...timings, status, bytes, err: '' });
      };
      ts.once('end', done);
      ts.once('close', done);
      ts.once('error', (e) => onError('body', e));
    }
  });
}

function stats(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return {
    min: s[0],
    p50: q(0.5),
    p90: q(0.9),
    max: s[s.length - 1],
    mean,
    sd,
    jitter: s[s.length - 1] - s[0],
  };
}

const r1 = (n) => Math.round(n * 10) / 10;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(`\n端到端时延基准  |  ${USE_DIRECT ? '直连（对照）' : '经代理 127.0.0.1:18080'}  |  每项 ${ROUNDS} 次`);
console.log('='.repeat(96));

const summary = [];

for (const c of CASES) {
  const results = [];
  for (let i = 0; i < ROUNDS; i++) results.push(await once(c));

  const ok = results.filter((r) => r.status >= 200 && r.status < 400);
  const failed = results.filter((r) => !(r.status >= 200 && r.status < 400));

  const t = stats(ok.map((r) => r.total));
  const ttfb = stats(ok.map((r) => r.ttfb));

  console.log(`\n${c.name}`);
  console.log(`  ${c.host}${c.path.slice(0, 52)}`);
  console.log(`  预期: ${c.expect}    ${c.note}`);

  if (!t) {
    console.log(`  全部失败 (${failed.length} 次)  样本: ${failed.slice(0, 2).map((f) => f.err).join(', ')}`);
    summary.push({ name: c.name, ok: 0, fail: failed.length });
    continue;
  }

  console.log(
    `  成功 ${ok.length}/${results.length}   状态码 ${[...new Set(ok.map((r) => r.status))].join('/')}`
  );
  console.log(
    `  总时延   最小 ${padL(r1(t.min), 7)}  中位 ${padL(r1(t.p50), 7)}  p90 ${padL(r1(t.p90), 7)}  最大 ${padL(r1(t.max), 7)}  ms`
  );
  console.log(
    `           均值 ${padL(r1(t.mean), 7)}  标准差 ${padL(r1(t.sd), 5)}   抖动 ${padL(r1(t.jitter), 7)}  ms`
  );
  if (ttfb && ttfb.mean > 0) {
    console.log(`  首字节   中位 ${padL(r1(ttfb.p50), 7)}  p90 ${padL(r1(ttfb.p90), 7)}  ms   （连接+TLS+等上游）`);
  }
  if (failed.length) console.log(`  失败 ${failed.length} 次: ${[...new Set(failed.map((f) => f.err))].join(', ')}`);

  summary.push({ name: c.name, ...t, ok: ok.length, fail: failed.length, ttfb: ttfb?.p50 });
}

// ---- 汇总表：给"是否更快更稳"一个一眼可比的视图 ----
console.log('\n' + '='.repeat(96));
console.log('汇总（总时延 ms）');
console.log(
  pad('测试项', 26) + padL('中位', 8) + padL('p90', 8) + padL('最大', 8) + padL('标准差', 9) + padL('成功', 8)
);
console.log('-'.repeat(96));
for (const s of summary) {
  if (!s.ok && s.p50 === undefined) {
    console.log(pad(s.name, 26) + padL('-', 8) + padL('-', 8) + padL('-', 8) + padL('-', 9) + padL(`0/${s.fail}`, 8));
    continue;
  }
  console.log(
    pad(s.name, 26) +
      padL(r1(s.p50), 8) +
      padL(r1(s.p90), 8) +
      padL(r1(s.max), 8) +
      padL(r1(s.sd), 9) +
      padL(`${s.ok}/${s.ok + s.fail}`, 8)
  );
}
console.log('-'.repeat(96));
console.log('判读：p90/最大 决定卡顿感；标准差/抖动决定"稳不稳"。p90 明显高于中位 = 有偶发卡顿。');
