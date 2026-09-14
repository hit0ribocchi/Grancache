'use strict';

/**
 * 磁盘缓存（PathCache）：路径镜像布局 + `.ext` 旁车元数据。
 *
 * 布局（cacheDir = config.cacheDir）：
 *   <cacheDir>/https/<host>/<url 路径>            响应体，可直接浏览、可整包拷贝
 *   <cacheDir>/https/<host>/<url 路径>.ext        JSON 元数据（兼容 ACGPower 字段名）
 *   <cacheDir>/https/<host>/<url 路径的 _ap 变体>  魔改覆盖文件（无条件优先命中）
 *
 * 与旧版（sha256 objects）的区别：键从"内容哈希"换成"相对路径"，于是
 * 目录可读、能手动整理、能导入 ACGPower 的缓存包；代价是读取要走一次
 * 目录查找（仍在页表缓存里，实测差异可忽略）。
 *
 * 淘汰策略：this.index 是 Map，**插入顺序即 LRU 顺序**。每次命中/写入都把
 * 该 key 删掉再插回去（排到队尾），淘汰时从队首往后删，不需要排序。
 * 魔改文件（*_ap.*）**不进索引、不计容量**，否则会被 LRU 当普通对象删掉。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

// 读索引 / 删文件时的并发上限，避免一次性打开太多句柄
const IO_CONCURRENCY = 64;
const DELETE_CONCURRENCY = 32;

const EXT_SUFFIX = '.ext';
// 魔改文件：<name>_ap.<ext> 以及它的元数据 <name>_ap.<ext>.ext
const OVERRIDE_RE = /_ap\.[A-Za-z0-9]{1,8}(?:\.ext)?$/i;

/** 相对路径 → 魔改路径（文件名里插入 _ap 后缀，扩展名保持） */
function overridePathFor(relPath) {
  const s = String(relPath);
  const slash = s.lastIndexOf('/');
  const dir = slash === -1 ? '' : s.slice(0, slash + 1);
  const base = slash === -1 ? s : s.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return `${dir}${base}_ap`;
  return `${dir}${base.slice(0, dot)}_ap${base.slice(dot)}`;
}

function isOverridePath(p) {
  return OVERRIDE_RE.test(String(p));
}

/**
 * 全零检测：命中时的完整性兜底（照搬 ACGPower）。
 * 逐字节早退，真实素材第一个字节就返回 false，热路径上几乎不花钱；
 * 只有"整个文件都是 0"这种真正的坏对象才会走完全程。
 */
function isAllZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * 落盘前的完整性判定（纯函数，便于单测）。
 * - contentLength 缺失（chunked）：放行，只用实际字节数兜底
 * - contentLength 与实际不一致：拒绝（照搬 ACGPower，防半截响应入库）
 * - 全零 / 空响应：拒绝
 */
function shouldStoreBody({ contentLength, received, allZero, maxBytes }) {
  if (!Number.isFinite(received) || received <= 0) return { ok: false, reason: 'empty' };
  if (allZero) return { ok: false, reason: 'all-zero' };
  if (typeof maxBytes === 'number' && maxBytes > 0 && received > maxBytes) {
    return { ok: false, reason: 'too-big' };
  }
  if (contentLength !== undefined && contentLength !== null && contentLength !== '') {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared)) return { ok: false, reason: 'content-length-invalid' };
    if (declared !== received) return { ok: false, reason: 'content-length-mismatch' };
  }
  return { ok: true, reason: 'ok' };
}

class PathCache {
  constructor(opts) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes;
    // 一次淘汰清到上限的这个比例，避免"刚清完马上又超"
    this.watermark = typeof opts.watermark === 'number' ? opts.watermark : 0.85;
    this.revalidateAfterSeconds = opts.revalidateAfterSeconds || 0;
    // 默认**不**在读取时算哈希（见 README）；verifyIntegrity = true 时改用
    // md5 对照 `.ext.md5`（字段名兼容 ACGPower）。
    this.verifyIntegrity = opts.verifyIntegrity === true;
    // 魔改文件的 Content-Type 兜底表（由 src/policy.js 注入，避免循环依赖）
    this.contentTypeFor =
      typeof opts.contentTypeFor === 'function' ? opts.contentTypeFor : () => 'application/octet-stream';
    // 日志出口由调用方注入：src/main.js 传自己的 log()（带级别、会写进 proxy.log），
    // 单测/工具不传就用 console.log。启动扫描耗时这类数字要能被事后查到。
    this.log = typeof opts.log === 'function' ? opts.log : (msg) => console.log(msg);
    this.index = new Map(); // relPath -> meta（Map 的插入顺序 = LRU 顺序）
    this._pendingWrites = new Map(); // relPath -> Promise，串行化同一个对象的并发写入
    this._tmpSeq = 0;
    this.totalBytes = 0;
    this.bootAt = Date.now(); // 闲置淘汰的宽限锚点，见 evictIdle()
    this.evictions = 0;
    this.idleEvictions = 0;
    this.staleHits = 0;
    this.integrityErrors = 0;
    this.prunedDirs = 0;
    this.adopted = 0; // 运行中从磁盘接管进来的对象（导入缓存包 / 手工放入）
    this.ready = false;
  }

  /** 相对路径（POSIX 分隔符）→ 绝对磁盘路径 */
  absPathFor(relPath) {
    return path.join(this.dir, ...String(relPath).split('/'));
  }

  fileFor(relPath) {
    return this.absPathFor(relPath);
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    await this._loadIndex();
    this.ready = true;
  }

  /** 递归收集所有 `.ext` 元数据文件（跳过魔改文件自己的 .ext） */
  async _collectMetaFiles(root, out) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.name.endsWith(EXT_SUFFIX) && !isOverridePath(e.name)) {
          out.push(p);
        }
      }
    }
  }

  async _loadIndex() {
    const metaPaths = [];
    await this._collectMetaFiles(this.dir, metaPaths);

    // 先收集路径再限流并发读（串行 await 一个文件读一个，几十万对象时启动要好几分钟）
    let scanned = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < metaPaths.length) {
        const file = metaPaths[cursor++];
        const relPath = path.relative(this.dir, file.slice(0, -EXT_SUFFIX.length)).split(path.sep).join('/');
        if (isOverridePath(relPath)) continue; // 魔改对象不进索引
        try {
          const meta = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (!meta || typeof meta.size !== 'number') continue;
          // 索引键一律以磁盘上的真实路径为准（.ext 里的 url 只作诊断用）
          meta.relPath = relPath;
          const prev = this.index.get(relPath);
          if (prev) this.totalBytes -= prev.size || 0;
          this.totalBytes += meta.size || 0;
          this.index.set(relPath, meta);
          scanned++;
        } catch {
          // 损坏的元信息直接忽略（下次请求会当未命中处理）
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(IO_CONCURRENCY, metaPaths.length) }, () => worker())
    );

    // 按"最后一次访问时间"重排，让 LRU 顺序在重启后依然正确
    if (this.index.size > 1) {
      const ordered = [...this.index.values()].sort(
        (a, b) => (a.lastAccess || a.storedAt || 0) - (b.lastAccess || b.storedAt || 0)
      );
      this.index.clear();
      for (const meta of ordered) this.index.set(meta.relPath, meta);
    }

    if (scanned) {
      this.log(
        `[cache] 载入已有缓存 ${scanned} 个对象 / ${(this.totalBytes / 1048576).toFixed(1)} MB` +
          `（耗时 ${Date.now() - this.bootAt} ms）`
      );
    }
    if (this.totalBytes > this.maxBytes) await this.evict();
  }

  // 访问一次就把它挪到队尾（Map 的插入顺序 = LRU 顺序）
  _touch(key, meta) {
    meta.lastAccess = Date.now();
    this.index.delete(key);
    this.index.set(key, meta);
  }

  _needsRevalidate(meta) {
    if (!meta.revalidateAt) return false; // 0 = 永不校验（永久缓存）
    return Date.now() > meta.revalidateAt;
  }

  /**
   * 按候选路径依次查找（顺序 = 本机 host → 无 query 回退 → 缓存包 host 回退）。
   * 返回 null 表示未命中；命中时 body 一定是完好的（长度、非全零、可选 md5）。
   */
  async get(candidates, opts = {}) {
    // onSkip：把"本机有对象却没能命中"的原因报出去（expired / unreadable / size-mismatch / all-zero / md5-mismatch），
    // 调用方会把它写进结构化追踪事件（见 tools/report.cjs 的字段枚举）。
    const skip = (key, reason) => {
      if (typeof opts.onSkip === 'function') opts.onSkip(key, reason);
    };
    for (const key of candidates || []) {
      let meta = this.index.get(key);
      if (!meta) {
        // 索引里没有 ≠ 磁盘上没有：导入的 ACGPower 缓存包、用户手工放进来的对象
        // 都不在启动时建立的索引里。这里按需接管（要求 .ext 存在且合法），
        // 否则"导入完还得重启代理"才生效 —— 那不该是使用者的负担。
        meta = await this._adopt(key);
        if (!meta) continue;
      }
      if (meta.expiresAt && meta.expiresAt < Date.now()) {
        skip(key, 'expired');
        // expireMode=ttl 下过期对象默认删掉重取；开了 stale-if-error 时先留着 ——
        // 上游失败还能拿它顶一次（RFC 5861），但留着不代表它算"命中"。
        if (opts.keepExpired) continue;
        this._remove(key, meta);
        continue;
      }
      let body;
      try {
        body = await fsp.readFile(this.absPathFor(key));
      } catch {
        skip(key, 'unreadable');
        this._remove(key, meta);
        continue;
      }
      // 长度对不上说明文件被截断/改写过；全零说明写盘中途出过问题。都当未命中
      if (body.length !== meta.size || body.length === 0) {
        skip(key, 'size-mismatch');
        this._remove(key, meta);
        continue;
      }
      if (isAllZero(body)) {
        skip(key, 'all-zero');
        this._remove(key, meta);
        continue;
      }
      if (this.verifyIntegrity && meta.md5) {
        const actual = crypto.createHash('md5').update(body).digest('hex');
        if (actual !== meta.md5) {
          this.integrityErrors++;
          skip(key, 'md5-mismatch');
          console.error(`[cache] md5 校验失败，丢弃该对象：${meta.url || key}`);
          this._remove(key, meta);
          continue;
        }
      }
      this._touch(key, meta);
      return { key, meta, body, needsRevalidate: this._needsRevalidate(meta) };
    }
    return null;
  }

  /**
   * 取"已过期但还在容忍窗口内"的旧副本（RFC 5861 stale-if-error）。
   * 只在上游出错时调用；**损坏对象照旧删除**，绝不把坏数据当旧数据发出去。
   * 返回体里带 ageSeconds / staleSeconds，供响应头如实标注。
   */
  async getStale(candidates, { maxStaleMs = 0 } = {}) {
    const now = Date.now();
    for (const key of candidates || []) {
      let meta = this.index.get(key);
      if (!meta) {
        meta = await this._adopt(key);
        if (!meta) continue;
      }
      if (!meta.expiresAt || meta.expiresAt >= now) continue; // 没过期的不走这条路
      if (maxStaleMs > 0 && now - meta.expiresAt > maxStaleMs) continue; // 超出窗口不给
      let body;
      try {
        body = await fsp.readFile(this.absPathFor(key));
      } catch {
        this._remove(key, meta);
        continue;
      }
      if (body.length !== meta.size || body.length === 0 || isAllZero(body)) {
        this._remove(key, meta);
        continue;
      }
      if (this.verifyIntegrity && meta.md5) {
        const actual = crypto.createHash('md5').update(body).digest('hex');
        if (actual !== meta.md5) {
          this.integrityErrors++;
          this._remove(key, meta);
          continue;
        }
      }
      this._touch(key, meta);
      this.staleHits++;
      return {
        key,
        meta,
        body,
        ageSeconds: Math.max(0, Math.floor((now - (meta.storedAt || now)) / 1000)),
        staleSeconds: Math.max(0, Math.floor((now - meta.expiresAt) / 1000)),
      };
    }
    return null;
  }

  /** 磁盘上已有合法对象（数据 + .ext）时按需接管进索引 */
  async _adopt(key) {
    const abs = this.absPathFor(key);
    try {
      const st = await fsp.stat(abs);
      if (!st.isFile()) return null;
      const meta = JSON.parse(await fsp.readFile(abs + EXT_SUFFIX, 'utf8'));
      if (!meta || typeof meta.size !== 'number' || meta.size <= 0) return null;
      // 并发请求可能同时走到这里：先查一次，避免把同一个对象计两次容量
      const raced = this.index.get(key);
      if (raced) return raced;
      meta.relPath = key;
      meta.lastAccess = meta.lastAccess || meta.storedAt || Date.now();
      this.index.set(key, meta);
      this.totalBytes += meta.size || 0;
      this.adopted++;
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * 查魔改文件：按候选路径顺序 stat，先命中的那个就是要返回的对象。
   * 返回 { key, abs, size, mtimeMs, meta }；meta 来自 <魔改文件>.ext（可能为 null）。
   */
  async overrideFor(candidates) {
    for (const candidate of candidates || []) {
      const key = overridePathFor(candidate);
      const abs = this.absPathFor(key);
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let meta = null;
      try {
        meta = JSON.parse(await fsp.readFile(abs + EXT_SUFFIX, 'utf8'));
      } catch {
        meta = null;
      }
      return { key, abs, size: st.size, mtimeMs: st.mtimeMs, meta };
    }
    return null;
  }

  async readOverrideBody(ov) {
    return fsp.readFile(ov.abs);
  }

  /** 后台校验过、服务器回 304 时调用：只把校验时间往后推，内容不动 */
  async markRevalidated(key) {
    const meta = this.index.get(key);
    if (!meta) return;
    const now = Date.now();
    meta.at = Math.floor(now / 1000);
    meta.revalidatedAt = now;
    meta.revalidateAt = this.revalidateAfterSeconds ? now + this.revalidateAfterSeconds * 1000 : 0;
    try {
      await fsp.writeFile(this.absPathFor(key) + EXT_SUFFIX, JSON.stringify(meta));
    } catch {
      // 写元信息失败不影响读缓存
    }
  }

  async set(key, meta, body) {
    if (!this.ready) return false;

    // 同一个对象完全可能被并发写入：响应是"先回浏览器、再落盘"的，
    // 紧接着的下一个相同请求会在上一次写完之前就到达。
    // 把同一个 key 的写入串起来；如果前一次已经写了一份同样大小的内容，就不重复写。
    const prevTask = this._pendingWrites.get(key);
    if (prevTask) {
      const prevOk = await prevTask.then(() => true).catch(() => false);
      if (prevOk) {
        const existing = this.index.get(key);
        if (existing && existing.size === body.length) return true;
      }
    }

    const task = this._write(key, meta, body);
    this._pendingWrites.set(key, task);
    try {
      return await task;
    } finally {
      if (this._pendingWrites.get(key) === task) this._pendingWrites.delete(key);
    }
  }

  async _write(key, meta, body) {
    const abs = this.absPathFor(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // 临时文件名带进程号和自增序号，保证任何情况下都不会互相踩
    const tmpData = `${abs}.${process.pid}.${++this._tmpSeq}.tmp`;
    const now = Date.now();
    const headers = meta.headers || {};
    const record = {
      v: 1,
      url: meta.url || '',
      // 以下字段与 ACGPower 的 .ext 同名同义，保证缓存包双向兼容
      LastModified: headers['last-modified'] || meta.lastModified || '',
      ETag: headers.etag || meta.etag || '',
      at: Math.floor(now / 1000),
      md5: this.verifyIntegrity ? crypto.createHash('md5').update(body).digest('hex') : '',
      ce: headers['content-encoding'] || meta.ce || '',
      ct: headers['content-type'] || meta.contentType || '',
      // 以下字段是本项目自用（毫秒）
      size: body.length,
      storedAt: now,
      lastAccess: now,
      expiresAt: meta.expiresAt || 0,
      revalidatedAt: 0,
      revalidateAt: this.revalidateAfterSeconds ? now + this.revalidateAfterSeconds * 1000 : 0,
      headers,
    };
    try {
      await fsp.writeFile(tmpData, body);
      await fsp.rename(tmpData, abs);
      await fsp.writeFile(abs + EXT_SUFFIX, JSON.stringify(record));
    } catch (err) {
      await fsp.rm(tmpData, { force: true }).catch(() => {});
      throw err;
    }

    // 文件 mtime 设为 Last-Modified（照搬 ACGPower），给人工排查和导入工具用。
    // 有的文件系统/时间戳会让 utimes 抛错，这里必须兜底：不能因为它让整次写入失败。
    try {
      const lm = Date.parse(record.LastModified);
      if (Number.isFinite(lm)) await fsp.utimes(abs, new Date(), new Date(lm));
    } catch {
      /* 忽略：mtime 只是给人看的 */
    }

    record.relPath = key;
    const prev = this.index.get(key);
    if (prev) {
      this.totalBytes -= prev.size || 0;
      this.index.delete(key); // 先删再插，保证它排到 LRU 队尾
    }
    this.index.set(key, record);
    this.totalBytes += record.size;

    if (this.totalBytes > this.maxBytes) await this.evict();
    return true;
  }

  /** 删单个对象（读失败、过期、损坏时用）。文件删除是异步的，不阻塞调用方 */
  _remove(key, meta) {
    this.index.delete(key);
    this.totalBytes -= (meta && meta.size) || 0;
    const abs = this.absPathFor(key);
    Promise.all([
      fsp.rm(abs, { force: true }).catch(() => {}),
      fsp.rm(abs + EXT_SUFFIX, { force: true }).catch(() => {}),
    ])
      .then(() => this._pruneEmptyDirs(path.dirname(abs)))
      .catch(() => {});
  }

  /**
   * 向上逐级清理空目录。淘汰/删除只在最深层留下空壳，
   * 不清理的话几十万个空目录会长期占住目录树（资源管理器都会变慢）。
   * rmdir 遇到非空目录会抛错，正好当"到此为止"的信号。
   */
  async _pruneEmptyDirs(dir) {
    let d = dir;
    while (d && d !== this.dir && d.startsWith(this.dir + path.sep)) {
      try {
        await fsp.rmdir(d);
        this.prunedDirs++;
      } catch {
        return;
      }
      d = path.dirname(d);
    }
  }

  async evict() {
    const target = this.maxBytes * this.watermark;
    const doomed = [];
    let bytes = 0;

    // 队首 = 最久未使用。边遍历边删，不用排序也不用复制成大数组
    for (const [key, meta] of this.index) {
      if (this.totalBytes <= target) break;
      doomed.push(key);
      bytes += meta.size || 0;
      this.totalBytes -= meta.size || 0;
      this.index.delete(key);
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < doomed.length) {
        const key = doomed[cursor++];
        const abs = this.absPathFor(key);
        await Promise.all([
          fsp.rm(abs, { force: true }).catch(() => {}),
          fsp.rm(abs + EXT_SUFFIX, { force: true }).catch(() => {}),
        ]);
        await this._pruneEmptyDirs(path.dirname(abs));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DELETE_CONCURRENCY, doomed.length) }, () => worker())
    );

    this.evictions += doomed.length;
    this.log(
      `[cache] 触发淘汰：本轮移除 ${doomed.length} 个对象 / ${(bytes / 1048576).toFixed(1)} MB，` +
      `当前 ${(this.totalBytes / 1048576).toFixed(1)} MB / ${this.index.size} 个（累计已淘汰 ${this.evictions} 个对象）`
    );
  }

  /**
   * 闲置淘汰（借 nginx proxy_cache_path 的 inactive 语义）：
   * "多久没被访问就删"，与容量淘汰互补，防止僵尸对象长期占住 maxCacheGB。
   * - 判定用 lastAccess，并取 max(lastAccess, 进程启动时间)：
   *   刚重启的进程在窗口内不会误删"其实很热、只是 lastAccess 没落盘"的对象；
   * - 分批删除（limit），避免一次抛几万个 IO 请求出去；
   * - 魔改文件不在索引里，天然不会被它删掉。
   */
  async evictIdle({ maxIdleMs, limit = 5000 } = {}) {
    if (!maxIdleMs || maxIdleMs <= 0) return { removed: 0, bytes: 0 };
    const cutoff = Date.now() - maxIdleMs;
    const doomed = [];
    let bytes = 0;
    for (const [key, meta] of this.index) {
      if (doomed.length >= limit) break;
      if (Math.max(meta.lastAccess || 0, this.bootAt) >= cutoff) continue;
      doomed.push(key);
      bytes += meta.size || 0;
    }
    for (const key of doomed) {
      const meta = this.index.get(key);
      if (meta) this._remove(key, meta);
    }
    if (doomed.length) {
      this.idleEvictions += doomed.length;
      this.log(
        `[cache] 闲置淘汰：移除 ${doomed.length} 个对象 / ${(bytes / 1048576).toFixed(1)} MB` +
          `（超过 ${(maxIdleMs / 86400000).toFixed(1)} 天没被访问；累计 ${this.idleEvictions} 个）`
      );
    }
    return { removed: doomed.length, bytes };
  }

  /**
   * 后台重扫：把磁盘上新出现、索引里还没有的对象补进来。
   * 由导入工具写的哨兵文件触发（见 src/main.js 的定时器），这样导入完不用重启代理，
   * 也不会把"每对象一次 stat + 读 .ext"的压力全压到导入后的第一次刷新上。
   * - 只补缺失项，已有条目一律不动（不覆盖、不重排 LRU）；
   * - 每 batch 个对象让出一次事件循环，几十万对象也不会长时间占住事件循环。
   */
  async rescan({ batch = 20000 } = {}) {
    const t0 = Date.now();
    const metaPaths = [];
    await this._collectMetaFiles(this.dir, metaPaths);
    let added = 0;
    let seen = 0;
    for (const file of metaPaths) {
      const relPath = path.relative(this.dir, file.slice(0, -EXT_SUFFIX.length)).split(path.sep).join('/');
      if (isOverridePath(relPath) || this.index.has(relPath)) continue;
      try {
        const meta = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!meta || typeof meta.size !== 'number' || meta.size <= 0) continue;
        meta.relPath = relPath;
        meta.lastAccess = Math.max(meta.lastAccess || 0, meta.storedAt || 0, this.bootAt);
        this.index.set(relPath, meta);
        this.totalBytes += meta.size;
        added++;
      } catch {
        // 损坏的元信息忽略（下次请求会当未命中）
      }
      if (++seen % batch === 0) await new Promise((r) => setImmediate(r));
    }
    return { scanned: metaPaths.length, added, ms: Date.now() - t0 };
  }

  pickHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === 'content-length') continue;
      if (lk === 'alt-svc') continue; // 别让浏览器绕过代理去直连 h3
      out[lk] = v;
    }
    return out;
  }

  stats() {
    return {
      objects: this.index.size,
      bytes: this.totalBytes,
      megabytes: +(this.totalBytes / 1048576).toFixed(1),
      evictions: this.evictions,
      idleEvictions: this.idleEvictions,
      staleHits: this.staleHits,
      integrityErrors: this.integrityErrors,
      prunedDirs: this.prunedDirs,
      adopted: this.adopted,
      maxBytes: this.maxBytes,
      verifyIntegrity: this.verifyIntegrity,
      layout: 'path-mirror',
    };
  }
}

module.exports = {
  PathCache,
  HOP_BY_HOP,
  isAllZero,
  isOverridePath,
  overridePathFor,
  shouldStoreBody,
};
