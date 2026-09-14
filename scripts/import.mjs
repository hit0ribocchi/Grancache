#!/usr/bin/env node
/**
 * 导入 ACGPower 的本地缓存包（cache/gbf/**）到我们的路径镜像布局。
 *
 * ACGPower 3.x 是 cache/gbf/https/assets/...（带 scheme 层），2.5.1 是 cache/gbf/assets/...
 * 它没有 host 层，而我们多一层 host —— 所以整棵复制到
 * <cacheDir>/https/<config.cacheHostFallback>/ 下即可：
 * 读取时若本机 host 目录未命中，会回退到 cacheHostFallback 目录（见 src/policy.js cachePaths）。
 *
 * 缺 .ext 的文件会按扩展名补一份（ct 查表、size 取实际字节数）——
 * 有了 .ext，运行中的代理会**按需接管**，不用重启。
 *
 * 用法:
 *   node tools/import.mjs --src "D:/ACG/cache/gbf"
 *   node tools/import.mjs --src ... --host prd-game-a-granbluefantasy.akamaized.net
 *   node tools/import.mjs --src ... --dry
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const policy = require(path.join(ROOT, 'src', 'policy.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const srcIdx = argv.indexOf('--src');
const hostIdx = argv.indexOf('--host');
const dirIdx = argv.indexOf('--dir');
const src = srcIdx >= 0 ? path.resolve(argv[srcIdx + 1]) : null;
const host = String(hostIdx >= 0 ? argv[hostIdx + 1] : config.cacheHostFallback || '').toLowerCase();
const cacheDir = path.resolve(dirIdx >= 0 ? argv[dirIdx + 1] : config.cacheDir);

if (!src || !fs.existsSync(src)) {
  console.error('用法: node tools/import.mjs --src <ACGPower 的 cache\\gbf 目录> [--host <host>] [--dir <cacheDir>] [--dry]');
  process.exit(2);
}
if (!host) {
  console.error('缺少目标 host：请加 --host，或在 config.json 里设置 cacheHostFallback');
  process.exit(2);
}

// ACGPower 的 scheme 层（3.x 有，2.5.1 没有 → 按 https 处理）
let scheme = 'https';
let schemeRoot = src;
for (const s of ['https', 'http']) {
  const p = path.join(src, s);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    scheme = s;
    schemeRoot = p;
    break;
  }
}

const dest = path.join(cacheDir, scheme, host);
console.log(`${dry ? '[dry-run] ' : ''}源: ${schemeRoot}`);
console.log(`${dry ? '[dry-run] ' : ''}目标: ${dest}`);

if (dry) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(schemeRoot);
  console.log(`[dry-run] 源目录共 ${n} 个文件，未做任何写入。`);
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
// force:false + errorOnExist:false = 只补缺，不覆盖我们自己已经缓存过的对象
fs.cpSync(schemeRoot, dest, { recursive: true, force: false, errorOnExist: false });

// 补 .ext：ACGPower 的包通常没有旁车文件，缺了就没法命中（读取要求 .ext 存在且合法）
let added = 0;
let kept = 0;
let bytes = 0;
const fill = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      fill(p);
      continue;
    }
    if (e.name.endsWith('.ext')) {
      kept++;
      continue;
    }
    if (fs.existsSync(p + '.ext')) {
      kept++;
      continue;
    }
    const size = fs.statSync(p).size;
    if (size <= 0) continue; // 空文件没有意义，不当缓存对象
    const ext = policy.extensionOf(p);
    const ct = policy.contentTypeForExtension(ext);
    fs.writeFileSync(
      p + '.ext',
      JSON.stringify({
        v: 1,
        url: `https://${host}/${path.relative(dest, p).split(path.sep).join('/')}`,
        at: Math.floor(Date.now() / 1000),
        md5: '',
        ce: '',
        ct,
        size,
        storedAt: Date.now(),
        lastAccess: Date.now(),
        expiresAt: 0,
        revalidateAt: 0,
        headers: { 'content-type': ct },
      })
    );
    added++;
    bytes += size;
  }
};
fill(dest);

console.log(`导入完成：新补 .ext ${added} 个（${(bytes / 1048576).toFixed(1)} MB），已有/保留 ${kept} 个。`);
// 给运行中的代理放一个"请重扫"哨兵：它每 rescanCheckSeconds 秒检查一次，
// 会把新对象分批补进索引（比"每来一个请求才 stat+读 .ext"更平缓）。
try {
  fs.writeFileSync(path.join(cacheDir, '.gbf-rescan-request'), String(Date.now()));
  console.log(`已放置重扫标记，代理最多 ${config.rescanCheckSeconds || 60} 秒后把新对象全部补进索引。`);
} catch {
  // 写不进去也没关系：请求命不中时会按需接管
}
console.log('代理不用重启：下次请求也会按需接管这些对象（走本机 host 目录 → cacheHostFallback 回退）。');
console.log('浏览器里那份旧缓存仍需按 Ctrl+F5 刷一次（尤其是刚做过魔改的素材）。');
