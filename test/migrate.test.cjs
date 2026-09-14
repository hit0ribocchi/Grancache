'use strict';
/**
 * 迁移/导入工具的离线自测（全程临时目录，不碰真实缓存）：
 *   1. tools/migrate.mjs：旧 objects/<hash>.{data,json} → 新路径镜像，
 *      含别名主机改写、.ext 生成、旧元信息清理、幂等（再跑一次是 0 个）
 *   2. tools/import.mjs：ACGPower 包（无 host 层、无 .ext）
 *      → 我们的布局（落到 cacheHostFallback 下）+ 自动补 .ext，已有的 .ext 不被覆盖
 *
 * 用法: node tools/migrate.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const fallbackHost = config.cacheHostFallback;

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-tools-'));
const cacheDir = path.join(tmp, 'cache');
const objectsDir = path.join(cacheDir, 'objects');

/** 造一个旧布局（sha256 objects）对象 */
function plantOld(url, bodyBuf) {
  const key = crypto.createHash('sha256').update(`GET ${url} ae=gzip`).digest('hex');
  const dir = path.join(objectsDir, key.slice(0, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key + '.data'), bodyBuf);
  fs.writeFileSync(
    path.join(dir, key + '.json'),
    JSON.stringify({
      key,
      url,
      status: 200,
      headers: {
        'content-type': 'image/png',
        etag: '"old1"',
        'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
      },
      contentType: 'image/png',
      size: bodyBuf.length,
      integrity: 'sha256-deadbeef',
      storedAt: Date.now() - 1000,
      lastAccess: Date.now() - 1000,
      expiresAt: 0,
      revalidatedAt: 0,
      revalidateAt: 0,
    })
  );
}

const countFiles = (dir) => {
  let n = 0;
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
};

(async () => {
  console.log('临时目录:', tmp);
  const b1 = Buffer.alloc(2048, 3);
  const b2 = Buffer.alloc(1024, 4);
  plantOld('https://prd-game-a1-granbluefantasy.akamaized.net/assets/img/sp/old1.png', b1);
  plantOld('https://game.granbluefantasy.jp/assets/img/sp/old2.png', b2);
  check('造了 2 个旧对象（4 个文件）', countFiles(objectsDir) === 4, `files=${countFiles(objectsDir)}`);

  // ---- 迁移 ----
  const out1 = execFileSync(NODE, [path.join(ROOT, 'scripts', 'migrate.mjs'), '--dir', cacheDir], {
    encoding: 'utf8',
  });
  console.log('   ' + out1.trim().split('\n')[0]);
  check('迁移：统计为成功 2 个', /迁移完成：成功 2 个/.test(out1), out1.trim().split('\n')[0]);

  const p1 = path.join(cacheDir, 'https', 'prd-game-a-granbluefantasy.akamaized.net', 'assets', 'img', 'sp', 'old1.png');
  const p2 = path.join(cacheDir, 'https', 'game.granbluefantasy.jp', 'assets', 'img', 'sp', 'old2.png');
  check('迁移：别名主机（a1）改写到真实主机目录', fs.existsSync(p1));
  check('迁移：普通主机按原路径落盘', fs.existsSync(p2));
  check('迁移：内容字节一致', fs.readFileSync(p1).equals(b1) && fs.readFileSync(p2).equals(b2));
  check('迁移：文件 mtime 被设为 Last-Modified', Math.abs(fs.statSync(p2).mtimeMs - Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')) < 2000);

  const e2 = JSON.parse(fs.readFileSync(p2 + '.ext', 'utf8'));
  check(
    '迁移：生成 .ext（v/size/ct/ETag/headers 齐全）',
    e2.v === 1 && e2.size === b2.length && e2.ct === 'image/png' && e2.ETag === '"old1"' && !!e2.headers,
    JSON.stringify({ v: e2.v, size: e2.size, ct: e2.ct, ETag: e2.ETag })
  );
  check('迁移：旧 objects 里不再留文件（可安全手动删目录）', countFiles(objectsDir) === 0, `files=${countFiles(objectsDir)}`);

  const out1b = execFileSync(NODE, [path.join(ROOT, 'scripts', 'migrate.mjs'), '--dir', cacheDir], {
    encoding: 'utf8',
  });
  check('迁移：幂等（再跑一次 0 个）', /迁移完成：成功 0 个/.test(out1b), out1b.trim().split('\n')[0]);

  // ---- 导入 ACGPower 缓存包 ----
  const src = path.join(tmp, 'acg', 'cache', 'gbf');
  const srcAssets = path.join(src, 'https', 'assets', 'img', 'sp');
  fs.mkdirSync(srcAssets, { recursive: true });
  const b3 = Buffer.alloc(3333, 6);
  const b4 = Buffer.alloc(444, 8);
  fs.writeFileSync(path.join(srcAssets, 'mod.png'), b3); // 无 .ext
  fs.writeFileSync(path.join(srcAssets, 'withet.png'), b4); // 自带 .ext
  fs.writeFileSync(
    path.join(srcAssets, 'withet.png.ext'),
    JSON.stringify({ v: 1, ct: 'image/png', ce: '', size: b4.length, at: 1, md5: '', ETag: '"ap1"' })
  );

  const out2 = execFileSync(NODE, [path.join(ROOT, 'scripts', 'import.mjs'), '--src', src, '--dir', cacheDir], {
    encoding: 'utf8',
  });
  console.log('   ' + out2.trim().split('\n').pop());
  const destAssets = path.join(cacheDir, 'https', fallbackHost, 'assets', 'img', 'sp');
  check('导入：落到 cacheHostFallback 目录（没有 host 层也能被主机回退命中）', fs.existsSync(path.join(destAssets, 'mod.png')));
  check('导入：内容字节一致', fs.readFileSync(path.join(destAssets, 'mod.png')).equals(b3));

  const genExt = JSON.parse(fs.readFileSync(path.join(destAssets, 'mod.png.ext'), 'utf8'));
  check(
    '导入：缺 .ext 的按扩展名补一份（可被运行中的代理按需接管）',
    genExt.v === 1 && genExt.size === b3.length && genExt.ct === 'image/png',
    JSON.stringify({ v: genExt.v, size: genExt.size, ct: genExt.ct })
  );
  const keptExt = JSON.parse(fs.readFileSync(path.join(destAssets, 'withet.png.ext'), 'utf8'));
  check('导入：自带的 .ext 不被覆盖', keptExt.ETag === '"ap1"' && keptExt.size === b4.length);
  check('导入：输出统计里报告新补 1 个 .ext', /新补 \.ext 1 个/.test(out2), out2.trim().split('\n').slice(-3)[0]);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
