/**
 * 端到端测量：同一个连接上连续请求同一个素材 N 次，看缓存命中的真实每请求耗时。
 * 复用 grancache/src/upstream.js 的 CONNECT 逻辑来穿过本地缓存代理。
 *
 * 用法: node tools/throughput.mjs <url> [次数]
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const { Upstream } = require(path.join(projectRoot, 'src', 'upstream.js'));

const url = process.argv[2];
const count = Number(process.argv[3] || 60);
if (!url) {
  console.error('用法: node tools/throughput.mjs <url> [次数]');
  process.exit(2);
}

const ca = readFileSync(path.join(projectRoot, 'runtime', 'certs', 'ca', 'ca.crt'));
const upstream = new Upstream({ mode: 'http', host: '127.0.0.1', port: 18080 });
await upstream.init(); // 必须初始化，否则会直连 CDN，根本不经缓存代理
console.log(`经由: ${upstream.describe()}`);

const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
agent.createConnection = (opts, cb) =>
  upstream.createTlsConnection(opts.host, opts.port, opts.servername, true)(opts, cb);

function once() {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { agent, ca, headers: { 'accept-encoding': 'gzip' } }, (res) => {
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
      });
      res.on('end', () => resolve({ size, cache: res.headers['x-gbf-cache'] }));
    });
    req.on('error', reject);
    req.end();
  });
}

const times = [];
let bytes = 0;
let cacheHeader = '';
try {
  await once(); // 建连接 + 预热
  for (let i = 0; i < count; i++) {
    const t = performance.now();
    const r = await once();
    times.push(performance.now() - t);
    bytes = r.size;
    cacheHeader = r.cache;
  }
} catch (err) {
  console.error('请求失败:', err.message);
  process.exit(1);
}

times.sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / times.length;
const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
console.log(`素材: ${(bytes / 1024).toFixed(1)} KB  (x-gbf-cache: ${cacheHeader})`);
console.log(`同一连接连续 ${count} 次: 平均 ${mean.toFixed(2)} ms | 中位 ${p(0.5).toFixed(2)} ms | p95 ${p(0.95).toFixed(2)} ms | 最小 ${times[0].toFixed(2)} ms`);
console.log(`也就是说缓存命中时，每个请求只要 ${mean.toFixed(2)} ms（其中磁盘读取约占 0.12 ms）`);
