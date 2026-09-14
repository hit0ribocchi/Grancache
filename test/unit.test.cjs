'use strict';
/**
 * 离线单测（不碰 D:/gbf-cache、不碰真实 config.json，全用临时目录）：
 *   1. PathCache：路径镜像布局、.ext 字段、LRU 水位淘汰、重启恢复、
 *      截断/全零对象按未命中处理、魔改文件不进索引不被淘汰、空目录清理
 *   2. shouldStoreBody：Content-Length 一致 / chunked / 全零 / 超限 / 空响应
 *   3. lib/policy：cachePaths 的 query 目录化、参数剥离、主机回退、路径净化，
 *      以及扩展名 → Content-Type 表覆盖 config.assetExtensions 全集
 *
 * 用法: node tools/unit.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const { PathCache, shouldStoreBody, overridePathFor, isOverridePath } = require(path.join(ROOT, 'src', 'cache.js'));
const policy = require(path.join(ROOT, 'src', 'policy.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-cache-test-'));
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 非全零的假响应体（真实素材绝不会全 0，用 n%250+1 保证每份内容都不同）
const body = (n) => Buffer.alloc(10 * 1024, (n % 250) + 1);
// 路径镜像下的相对路径（POSIX 分隔符）
const rel = (i, host = 'prd-game-a-granbluefantasy.akamaized.net') =>
  `https/${host}/assets/img/sp/${i}.png`;
const metaFor = (i) => ({
  url: `https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/${i}.png`,
  headers: {
    'content-type': 'image/png',
    etag: `"e${i}"`,
    'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
  },
});

(async () => {
  console.log('临时目录:', tmp);
  // 上限 100KB，水位 0.85 -> 清到 85KB
  const cache = new PathCache({
    dir: tmp,
    maxBytes: 100 * 1024,
    watermark: 0.85,
    contentTypeFor: policy.contentTypeForExtension,
  });
  await cache.init();
  check('初始为空', cache.stats().objects === 0);

  // 写入 10 个对象 x 10KB = 100KB，正好不超
  for (let i = 0; i < 10; i++) {
    await cache.set(rel(i), metaFor(i), body(i));
    await sleep(2); // 让 lastAccess 有先后（重启恢复要按它重排）
  }
  check('写入 10 个不淘汰', cache.stats().evictions === 0, `objects=${cache.stats().objects}`);
  check('字节统计正确', cache.stats().bytes === 100 * 1024, `${cache.stats().bytes}`);

  // 路径镜像：文件真的落在 https/<host>/assets/img/sp/ 下
  const fileName = path.join(tmp, 'https', 'prd-game-a-granbluefantasy.akamaized.net', 'assets', 'img', 'sp', '3.png');
  check('数据文件按 URL 路径镜像落盘', fs.existsSync(fileName), fileName);
  check('.ext 旁车文件存在', fs.existsSync(fileName + '.ext'));
  check('目录里没有旧的 objects/ 布局', !fs.existsSync(path.join(tmp, 'objects')));

  // .ext 字段（兼容 ACGPower 的字段名 + 本项目自用字段）
  const ext = JSON.parse(fs.readFileSync(fileName + '.ext', 'utf8'));
  check('.ext 有 v/url/ct/ce/size/at', ext.v === 1 && !!ext.url && ext.ct === 'image/png' && ext.size === 10 * 1024 && typeof ext.at === 'number', JSON.stringify(Object.keys(ext).slice(0, 8)));
  check('.ext 保留完整响应头', ext.headers && ext.headers.etag === '"e3"');
  check('.ext 的 ETag/LastModified 字段与 ACGPower 同名', ext.ETag === '"e3"' && /2015/.test(ext.LastModified));
  check('文件 mtime 被设成 Last-Modified', Math.abs(fs.statSync(fileName).mtimeMs - Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')) < 2000);
  check('默认不写 md5（verifyIntegrity 关）', ext.md5 === '');

  // 魔改文件：不进索引、不被淘汰（review 阻断 #1 的回归）
  const ovPath = path.join(tmp, 'https', 'prd-game-a-granbluefantasy.akamaized.net', 'assets', 'img', 'sp', '3_ap.png');
  fs.writeFileSync(ovPath, Buffer.from('OVERRIDE-BYTES'));
  check('魔改文件不算缓存对象', cache.stats().objects === 10, `objects=${cache.stats().objects}`);
  check('魔改路径识别正确', isOverridePath('3_ap.png') && overridePathFor('https/a/b.png') === 'https/a/b_ap.png');

  // 命中 k0/k1/k2，它们应该被挪到 LRU 队尾（最不该被淘汰）
  for (const i of [0, 1, 2]) {
    const hit = await cache.get([rel(i)]);
    check(`命中 ${i}.png`, !!hit && hit.body.equals(body(i)));
  }
  check('命中不触发淘汰', cache.stats().evictions === 0);
  check('命中会回放 .ext 里的 content-encoding 信息', !cache.index.get(rel(0)).headers['content-encoding']);

  // 再写 2 个 -> 120KB > 100KB，触发淘汰，目标 85KB
  // 最久未用的是 3、4（0/1/2 刚被访问过，3 有魔改文件但缓存体本身照常参与淘汰）
  await cache.set(rel(10), metaFor(10), body(10));
  await cache.set(rel(11), metaFor(11), body(11));
  const st = cache.stats();
  console.log('   淘汰后:', JSON.stringify(st));
  check('触发了淘汰', st.evictions > 0, `evictions=${st.evictions}`);
  check('清到了水位以下', st.bytes <= 100 * 1024, `${st.bytes}`);
  check('没清过头（还在 85KB 附近）', st.bytes >= 60 * 1024, `${st.bytes}`);

  const still = [];
  for (const i of [0, 1, 2, 3, 4, 10, 11]) {
    still.push(`${i}=${(await cache.get([rel(i)])) ? '在' : '没了'}`);
  }
  console.log('   ' + still.join('  '));
  check('最近访问过的 0.png 保留', !!(await cache.get([rel(0)])));
  check('最近访问过的 2.png 保留', !!(await cache.get([rel(2)])));
  check('最久未用的 4.png 被淘汰', !(await cache.get([rel(4)])));
  check('魔改文件在淘汰后依然存在', fs.existsSync(ovPath));

  // 截断 / 全零：都当未命中，并把坏对象删掉
  const alive = [...cache.index.keys()];
  const victim = alive[alive.length - 1];
  fs.writeFileSync(cache.absPathFor(victim), Buffer.alloc(5));
  check('数据被截断时当未命中', (await cache.get([victim])) === null);
  await sleep(50);
  check('截断对象被删除', !fs.existsSync(cache.absPathFor(victim)));

  const victim2 = [...cache.index.keys()][0];
  fs.writeFileSync(cache.absPathFor(victim2), Buffer.alloc(10 * 1024, 0));
  check('全零对象当未命中', (await cache.get([victim2])) === null);
  await sleep(50);
  check('全零对象被删除', !fs.existsSync(cache.absPathFor(victim2)));

  // 空目录清理：删掉最后一个对象后，它所在的目录链不该留空壳
  const deepKey = 'https/only.test/assets/deep/dir/one.png';
  await cache.set(deepKey, { url: 'https://only.test/assets/deep/dir/one.png' }, body(1));
  const deepDir = path.dirname(cache.absPathFor(deepKey));
  cache._remove(deepKey, cache.index.get(deepKey));
  for (let i = 0; i < 20 && fs.existsSync(deepDir); i++) await sleep(25);
  check('淘汰/删除后逐级清理空目录', !fs.existsSync(deepDir), deepDir);

  // 重启恢复：索引从 .ext 重建，LRU 顺序按**持久化的** lastAccess 重排。
  // 注意：命中触发的 lastAccess 只存在内存里（每次命中都写盘会拖垮热路径），
  // 所以重启后看到的是"最后一次写入/校验时间"的顺序 —— 这是刻意保留的旧行为。
  const orderBefore = [...cache.index.keys()];
  const stBefore = cache.stats();
  const cache2 = new PathCache({
    dir: tmp,
    maxBytes: 100 * 1024,
    watermark: 0.85,
    contentTypeFor: policy.contentTypeForExtension,
  });
  await cache2.init();
  check('重启后索引数量一致', cache2.stats().objects === stBefore.objects, `${cache2.stats().objects} vs ${stBefore.objects}`);
  check('重启后字节数一致', cache2.stats().bytes === stBefore.bytes, `${cache2.stats().bytes} vs ${stBefore.bytes}`);
  const orderAfter = [...cache2.index.keys()];
  const lastAccesses = orderAfter.map((k) => cache2.index.get(k).lastAccess);
  check('重启后对象集合不变', JSON.stringify([...orderAfter].sort()) === JSON.stringify([...orderBefore].sort()));
  check(
    '重启后索引按持久化的 lastAccess 升序（队首 = 最久没用）',
    lastAccesses.every((v, i) => i === 0 || lastAccesses[i - 1] <= v),
    JSON.stringify(lastAccesses)
  );
  check('重启后魔改文件仍不在索引里', ![...cache2.index.keys()].some((k) => isOverridePath(k)));
  check('默认关闭读取时校验', cache2.verifyIntegrity === false);
  const hitAfterRestart = await cache2.get([orderBefore[0]]);
  check('重启后仍能命中', !!hitAfterRestart);

  // ---- shouldStoreBody 判定矩阵（覆盖 §3.5 的入库条件）----
  const cases = [
    ['长度一致 → 入库', { contentLength: '100', received: 100, allZero: false, maxBytes: 1000 }, true],
    ['长度不一致 → 不入库', { contentLength: '100', received: 80, allZero: false, maxBytes: 1000 }, false],
    ['chunked（无 content-length）→ 入库', { contentLength: undefined, received: 80, allZero: false, maxBytes: 1000 }, true],
    ['全零 → 不入库', { contentLength: '80', received: 80, allZero: true, maxBytes: 1000 }, false],
    ['超 maxObjectMB → 不入库', { contentLength: '5000', received: 5000, allZero: false, maxBytes: 1000 }, false],
    ['空响应 → 不入库', { contentLength: '0', received: 0, allZero: true, maxBytes: 1000 }, false],
    ['content-length 非法 → 不入库', { contentLength: 'abc', received: 80, allZero: false, maxBytes: 1000 }, false],
  ];
  for (const [name, input, expect] of cases) {
    const verdict = shouldStoreBody(input);
    check('落盘判定：' + name, verdict.ok === expect, `ok=${verdict.ok} reason=${verdict.reason}`);
  }

  // ---- lib/policy：路径映射 ----
  const p1 = policy.cachePaths(
    { protocol: 'https:', host: 'game.granbluefantasy.jp', path: '/assets/img/a.png?_=123&t=456&uid=789', url: 'https://game.granbluefantasy.jp/assets/img/a.png?_=123&t=456&uid=789' },
    config
  );
  check(
    '剥离时间戳/uid：候选里没有 __q_ 目录、没有 query 残留',
    p1[0] === 'https/game.granbluefantasy.jp/assets/img/a.png' && p1.every((p) => !p.includes('__q_') && !p.includes('?')),
    JSON.stringify(p1)
  );
  check(
    '候选列表带 cacheHostFallback 回退项',
    p1.includes(`https/${config.cacheHostFallback}/assets/img/a.png`),
    JSON.stringify(p1)
  );

  const p2 = policy.cachePaths(
    { protocol: 'https:', host: 'game.granbluefantasy.jp', path: '/assets/img/a.png?v=2', url: 'https://game.granbluefantasy.jp/assets/img/a.png?v=2' },
    config
  );
  check(
    '版本参数 → __q_ 目录在前、无 query 回退在后',
    p2[0] === 'https/game.granbluefantasy.jp/assets/img/__q_v=2/a.png' &&
      p2[1] === 'https/game.granbluefantasy.jp/assets/img/a.png',
    JSON.stringify(p2)
  );

  const p3 = policy.cachePaths(
    { protocol: 'https:', host: 'prd-game-a1-granbluefantasy.akamaized.net', path: '/assets/img/b.png', url: 'https://prd-game-a1-granbluefantasy.akamaized.net/assets/img/b.png' },
    config
  );
  check('主机回退：候选里带 cacheHostFallback 目录', p3.includes(`https/${config.cacheHostFallback}/assets/img/b.png`), JSON.stringify(p3));

  const p4 = policy.cachePaths(
    { protocol: 'https:', host: 'x.test', path: '/assets/a:b.png', url: 'https://x.test/assets/a:b.png' },
    config
  );
  check('非法字符被净化且不撞名', !p4[0].includes(':') && /a_b--[0-9a-f]{8}\.png$/.test(p4[0]), p4[0]);
  check('设备名（con.png）加前缀', /^_con--[0-9a-f]{8}\.png$/.test(policy.sanitizeSegment('con.png')), policy.sanitizeSegment('con.png'));
  check('正常素材名不被改写', policy.sanitizeSegment('2015000000.png') === '2015000000.png');

  // Content-Type 表必须覆盖 config.assetExtensions 全集
  const missing = (config.assetExtensions || []).filter((e) => !policy.CONTENT_TYPES[String(e).toLowerCase()]);
  check('Content-Type 表覆盖 assetExtensions 全集', missing.length === 0, missing.join(','));
  check('表里没有的扩展名兜底为 octet-stream', policy.contentTypeForExtension('zzz') === 'application/octet-stream');
  check('ktx2 有明确 MIME（不是 octet-stream）', policy.contentTypeForExtension('ktx2') !== 'application/octet-stream');

  // ---- getStale / evictIdle / rescan（本轮新增的残留风险修复）----
  const cache3 = new PathCache({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-stale-')),
    maxBytes: 10 * 1024 * 1024,
    contentTypeFor: policy.contentTypeForExtension,
  });
  await cache3.init();

  // 过期对象：默认会删；keepExpired=true 时留着，但不算命中
  const expired = 'https/x.test/assets/img/expired.png';
  await cache3.set(expired, { ...metaFor(1), expiresAt: Date.now() - 5000 }, body(1));
  const missNoKeep = await cache3.get([expired]);
  await sleep(50); // 删除是异步的（不阻塞读路径）
  check('未开启 keepExpired 时过期对象被删并按未命中', missNoKeep === null && !fs.existsSync(cache3.absPathFor(expired)));
  await cache3.set(expired, { ...metaFor(1), expiresAt: Date.now() - 5000 }, body(1));
  check('keepExpired=true 时保留过期对象、但仍不算命中', (await cache3.get([expired], { keepExpired: true })) === null && fs.existsSync(cache3.absPathFor(expired)));
  const stale = await cache3.getStale([expired], { maxStaleMs: 60000 });
  check('getStale 能取到窗口内的旧副本', !!stale && stale.body.equals(body(1)) && stale.staleSeconds >= 4, JSON.stringify({ staleSeconds: stale && stale.staleSeconds, age: stale && stale.ageSeconds }));
  check('getStale 超出窗口就不给', (await cache3.getStale([expired], { maxStaleMs: 1 })) === null);
  const freshKey = 'https/x.test/assets/img/fresh.png';
  await cache3.set(freshKey, { ...metaFor(3) }, body(3));
  check('还没过期的对象不走 stale 通道', (await cache3.getStale([freshKey], { maxStaleMs: 60000 })) === null);

  // 反例：过期 + 内容损坏 → 删除并拒绝，绝不拿坏数据顶
  const brokenKey = 'https/x.test/assets/img/broken.png';
  await cache3.set(brokenKey, { ...metaFor(2), expiresAt: Date.now() - 5000 }, body(2));
  fs.writeFileSync(cache3.absPathFor(brokenKey), Buffer.alloc(9)); // 截断
  check('损坏的过期对象不会被当成旧副本发出去', (await cache3.getStale([brokenKey], { maxStaleMs: 60000 })) === null);
  await sleep(50);
  check('损坏对象同时被删除', !fs.existsSync(cache3.absPathFor(brokenKey)));

  // 闲置淘汰：只删"很久没被访问"的，进程启动时间也算一次访问（宽限）
  const idleOld = 'https/idle.test/assets/img/old.png';
  const idleNew = 'https/idle.test/assets/img/new.png';
  await cache3.set(idleOld, { url: 'https://idle.test/old.png' }, body(3));
  await cache3.set(idleNew, { url: 'https://idle.test/new.png' }, body(4));
  cache3.index.get(idleOld).lastAccess = Date.now() - 10 * 86400000;
  cache3.index.get(idleNew).lastAccess = Date.now();
  const idle1 = await cache3.evictIdle({ maxIdleMs: 5 * 86400000, limit: 100 });
  check('启动宽限：刚启动的进程不会淘汰任何对象', idle1.removed === 0, JSON.stringify(idle1));
  cache3.bootAt = Date.now() - 10 * 86400000; // 模拟"进程已经跑了很久"
  const idle2 = await cache3.evictIdle({ maxIdleMs: 5 * 86400000, limit: 100 });
  await sleep(50);
  check('闲置淘汰只删很久没访问的', idle2.removed === 1 && !fs.existsSync(cache3.absPathFor(idleOld)), JSON.stringify(idle2));
  check('最近访问过的对象留下', fs.existsSync(cache3.absPathFor(idleNew)));
  check('闲置淘汰不动魔改文件', fs.existsSync(path.join(cache3.dir, ...overridePathFor('https/idle.test/assets/img/new.png').split('/'))) === false);

  // 后台重扫：把磁盘上新出现、索引里没有的对象补进来
  const before = cache3.stats().objects;
  const plantedRel = 'https/rescan.test/assets/img/imported.png';
  const plantedAbs = cache3.absPathFor(plantedRel);
  fs.mkdirSync(path.dirname(plantedAbs), { recursive: true });
  fs.writeFileSync(plantedAbs, body(5));
  fs.writeFileSync(plantedAbs + '.ext', JSON.stringify({ v: 1, url: 'https://rescan.test/imported.png', size: body(5).length, storedAt: Date.now(), lastAccess: Date.now(), ct: 'image/png', headers: { 'content-type': 'image/png' } }));
  const rs = await cache3.rescan({ batch: 1 });
  check('rescan 把新对象补进索引', cache3.stats().objects === before + 1 && rs.added === 1, JSON.stringify(rs));
  check('rescan 之后能命中该对象', !!(await cache3.get([plantedRel])));
  const rs2 = await cache3.rescan({ batch: 1 });
  check('rescan 幂等：第二次不重复加', rs2.added === 0 && cache3.stats().objects === before + 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(cache3.dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
