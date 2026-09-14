'use strict';

const crypto = require('crypto');

// 决定“什么可以缓存、能存多久”的规则层。
// 核心原则：动态接口一律不碰，静态素材（图片/音频/字体等）优先缓存。
//
// 这些判定跑在每个请求的热路径上，所以 pattern 编译和主机名匹配结果都做缓存：
// 原来每来一个请求都要把 9 条 excludePatterns + 5 条 assetHostPatterns 重新
// new RegExp 一遍，纯属白烧 CPU。

const reCache = new Map();

function cachedRe(pattern, flags) {
  const k = flags + '\u0000' + pattern;
  let re = reCache.get(k);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, flags);
    } catch {
      re = null; // pattern 写错了，当它不匹配
    }
    reCache.set(k, re);
  }
  return re;
}

function escapePattern(pattern) {
  return pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
}

const hostMatchCache = new Map(); // "pattern\0host" -> boolean

function parseCacheControl(value) {
  const out = {};
  if (!value) return out;
  for (const part of String(value).split(',')) {
    const idx = part.indexOf('=');
    const k = (idx === -1 ? part : part.slice(0, idx)).trim().toLowerCase();
    if (!k) continue;
    let v = idx === -1 ? true : part.slice(idx + 1).trim().replace(/^"|"$/g, '');
    out[k] = v;
  }
  return out;
}

function extensionOf(pathname) {
  const m = /\.([A-Za-z0-9]{1,6})(?:$|\?|#)/.exec(pathname || '');
  return m ? m[1].toLowerCase() : '';
}

function shouldBypass(target, config) {
  const s = target.path || '/';
  for (const pat of config.excludePatterns || []) {
    const re = cachedRe(pat, 'i');
    if (re && re.test(s)) return true;
  }
  return false;
}

function isPassthroughHost(host, config) {
  for (const pat of config.passthroughHosts || []) {
    if (pat.startsWith('*.')) {
      if (host === pat.slice(2) || host.endsWith(pat.slice(1))) return true;
    } else if (host === pat) return true;
  }
  return false;
}

// 主机名匹配：支持 "*.example.com"、"prd-game-*.akamaized.net"、"*granblue*" 这类通配
function hostMatches(host, pattern) {
  const k = pattern + '\u0000' + host;
  let hit = hostMatchCache.get(k);
  if (hit === undefined) {
    const re = cachedRe('^' + escapePattern(pattern) + '$', 'i');
    hit = re ? re.test(host) : false;
    // 主机名种类有限，但加个上限兜底，避免异常输入把缓存撑爆
    if (hostMatchCache.size >= 8192) hostMatchCache.clear();
    hostMatchCache.set(k, hit);
  }
  return hit;
}

// 素材 CDN 主机白名单：命中这些主机的响应默认都值得缓存（参考 frizz925/gbf-proxy 的做法）
function isAssetHost(host, config) {
  return (config.assetHostPatterns || []).some((p) => hostMatches(host, p));
}

/**
 * @returns {{store: boolean, ttlSeconds: number, reason: string}}
 */
function decideStore(input, config) {
  const { method, statusCode, headers, target, forceAsset } = input;

  if (method !== 'GET') return { store: false, ttlSeconds: 0, reason: 'method' };
  if (statusCode !== 200) return { store: false, ttlSeconds: 0, reason: 'status' };
  if (headers['set-cookie']) return { store: false, ttlSeconds: 0, reason: 'set-cookie' };

  const contentType = String(headers['content-type'] || '').toLowerCase();
  for (const bad of config.neverCacheContentTypes || []) {
    if (contentType.startsWith(String(bad).toLowerCase())) {
      return { store: false, ttlSeconds: 0, reason: 'content-type:' + bad };
    }
  }

  // 永久模式：连 TTL 都不需要，直接算到底能存多久
  const immortal = (config.expireMode || 'ttl') === 'immortal';

  const cc = parseCacheControl(headers['cache-control']);
  if (cc['no-store'] || cc.private) {
    // private/no-store 说明内容可能跟账号绑定；只有素材主机或静态扩展名才放行
    const allowOverride = forceAsset || (config.aggressiveAssetCache && isStaticAsset(target.path, config));
    if (!allowOverride) {
      return { store: false, ttlSeconds: 0, reason: 'no-store' };
    }
  }

  const vary = String(headers.vary || '');
  if (vary) {
    const fields = vary.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    const unsupported = fields.filter((f) => f !== 'accept-encoding');
    if (unsupported.length) return { store: false, ttlSeconds: 0, reason: 'vary:' + unsupported.join('+') };
  }

  // 素材主机白名单：不看服务器 TTL，直接按本机策略存
  if (forceAsset) {
    return {
      store: true,
      ttlSeconds: immortal ? 0 : config.fallbackTtlSeconds || 2592000,
      reason: 'asset-host',
    };
  }

  let ttl = 0;
  const maxAge = cc['s-maxage'] || cc['max-age'];
  if (maxAge !== undefined && maxAge !== true) {
    const n = parseInt(maxAge, 10);
    if (Number.isFinite(n)) ttl = n;
  } else if (headers.expires) {
    const t = Date.parse(headers.expires);
    if (Number.isFinite(t)) ttl = Math.floor((t - Date.now()) / 1000);
  }

  if (immortal && ttl > 0) {
    return { store: true, ttlSeconds: 0, reason: 'cache-control(immortal)' };
  }

  if (ttl >= (config.minMaxAge || 3600)) {
    return { store: true, ttlSeconds: ttl, reason: 'cache-control' };
  }

  if (config.aggressiveAssetCache && isStaticAsset(target.path, config)) {
    return {
      store: true,
      ttlSeconds: immortal ? 0 : config.fallbackTtlSeconds || 2592000,
      reason: 'asset-extension',
    };
  }

  return { store: false, ttlSeconds: 0, reason: 'not-cacheable' };
}

let extSetSrc = null;
let extSet = null;

function isStaticAsset(pathname, config) {
  const ext = extensionOf(pathname);
  if (!ext) return false;
  const list = config.assetExtensions || [];
  if (extSetSrc !== list) {
    extSetSrc = list;
    extSet = new Set(list.map((e) => String(e).toLowerCase()));
  }
  return extSet.has(ext);
}

// 资源请求有时会附带时间戳/用户标识参数。它们不改变静态素材内容，
// 但如果直接参与缓存键，会让同一张图被重复下载和保存。
//
// 注意：这里对所有可缓存目标都生效（不再只对素材白名单主机）。
// aggressiveAssetCache 命中的普通主机如果带着 ?t=/?uid=，以前会把参数带进
// 缓存键，同一张图存好几份；现在统一剥掉。
function normalizeCacheUrl(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.search) return url;
  const strip = new Set(options.stripQueryParams || ['_', 't', 'uid']);
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (strip.has(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return url;
  return parsed.toString();
}

function isVersionedAsset(url, options = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const strip = new Set(options.stripQueryParams || ['_', 't', 'uid']);
  return [...parsed.searchParams.keys()].some((key) => !strip.has(key));
}

function browserCacheControl({ versioned, maxAgeSeconds = 300 } = {}) {
  if (versioned) return 'public, max-age=31536000, immutable';
  const age = Math.max(0, Math.floor(Number(maxAgeSeconds) || 0));
  return `public, max-age=${age}`;
}

// ---------------------------------------------------------------- 磁盘路径映射
//
// 缓存键 = <scheme>/<host>/<url 路径>，与 ACGPower 的 cache/gbf/ 布局同构
// （新版带 scheme 层，所以它们的缓存包能整棵复制进来）。

// 扩展名 → Content-Type。魔改文件没有 .ext 时靠它给浏览器一个正确的类型；
// 表里没有的扩展名一律 application/octet-stream（照搬 ACGPower 的兜底）。
// 必须覆盖 config.assetExtensions 全集，否则 ktx2/skel/basis 这类引擎资源
// 会被当 octet-stream。
const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4s: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  atlas: 'text/plain; charset=utf-8',
  fnt: 'text/plain; charset=utf-8',
  ktx: 'image/ktx',
  ktx2: 'image/ktx2',
  // 以下引擎格式浏览器不会直接用 MIME 解释（走 fetch + ArrayBuffer），
  // 给二进制默认值，避免被当文本处理
  bin: 'application/octet-stream',
  skel: 'application/octet-stream',
  basis: 'application/octet-stream',
  dds: 'application/octet-stream',
  pvr: 'application/octet-stream',
};

function contentTypeForExtension(ext) {
  return CONTENT_TYPES[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

function sha1hex(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

/** 拆成 [主名, 扩展名]（扩展名最多 12 字符，否则当主名的一部分） */
function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 12) return [name.slice(0, dot), name.slice(dot)];
  return [name, ''];
}

/**
 * 单个路径段的净化：
 * - Windows 非法字符 <>:"|?* 与控制字符 → `_`
 * - 设备名（CON/PRN/AUX/NUL/COM1/LPT1…）加下划线前缀
 * - 只要发生过改写，就附上原文的短哈希 —— 否则 a:b 和 a_b 会撞到同一个文件
 * - 单段超过 100 字符：保留前 60 字符 + 哈希（防 MAX_PATH，正常素材不会触发）
 * 哈希一律插在扩展名之前（a_b--c51e3988.png），保证扩展名还在末尾 ——
 * 否则 Content-Type 推断和 _ap 魔改命名都会失准。
 */
function sanitizeSegment(segment) {
  const s = String(segment);
  if (!s) return '_';
  let out = s.replace(/[<>:"|?*\u0000-\u001f]/g, '_');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out)) out = '_' + out;
  if (out !== s) {
    const [base, ext] = splitExtension(out);
    out = `${base}--${sha1hex(s).slice(0, 8)}${ext}`;
  }
  if (out.length <= 100) return out;
  const [base, ext] = splitExtension(out);
  return `${base.slice(0, 60)}--${sha1hex(out).slice(0, 16)}${ext}`;
}

/** 整条相对路径过长时，把文件名压成哈希（GBF 素材实测不会触发） */
function shortenFullPath(relPath) {
  if (relPath.length <= 200) return relPath;
  const slash = relPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
  const base = slash === -1 ? relPath : relPath.slice(slash + 1);
  const [, ext] = splitExtension(base);
  return `${dir}${sha1hex(relPath).slice(0, 40)}${ext}`;
}

function urlOfTarget(target) {
  if (target && target.url) {
    try {
      return new URL(target.url);
    } catch {
      /* 落到下面自己拼 */
    }
  }
  const scheme = (target && target.protocol) || 'https:';
  const host = (target && target.host) || '';
  const p = (target && target.path) || '/';
  try {
    return new URL(`${scheme}//${host}${p}`);
  } catch {
    return null;
  }
}

/**
 * 把一个请求目标映射成磁盘上的候选相对路径，**按优先级排列**：
 *   1. <scheme>/<host>/<路径>[/__q_<参数>]/<文件名>
 *   2. 若带版本参数：<scheme>/<host>/<路径>/<文件名>
 *      （兼容 ACGPower 缓存包直接丢 query 的布局）
 *   3. 若配置了 cacheHostFallback：把 host 换成回退主机再试上面两条
 *      （导入的 ACGPower 包没有 host 层，只放一份就能服务所有 CDN 别名）
 *
 * 返回值里的每一项都是 POSIX 分隔符的相对路径，直接就是缓存索引的键。
 */
function cachePaths(target, config) {
  const u = urlOfTarget(target);
  if (!u) return null;
  const scheme = u.protocol === 'http:' ? 'http' : 'https';
  const host = String(u.hostname || '').toLowerCase();
  if (!host) return null;

  const segs = u.pathname.split('/').filter((x) => x !== '').map(sanitizeSegment);
  const file = segs.pop() || 'index';

  const strip = new Set((config && config.cacheKeyStripQueryParams) || ['_', 't', 'uid']);
  const rest = [];
  for (const [k, v] of u.searchParams.entries()) if (!strip.has(k)) rest.push(`${k}=${v}`);
  const qDir = rest.length
    ? String((config && config.queryDirPrefix) || '__q_') + sanitizeSegment(rest.join('&'))
    : null;

  const out = [];
  const add = (h, dirs) => {
    const rel = shortenFullPath([scheme, h, ...dirs, file].join('/'));
    if (!out.includes(rel)) out.push(rel);
  };
  add(host, qDir ? [...segs, qDir] : segs);
  if (qDir) add(host, segs);
  const fallback = config && config.cacheHostFallback;
  if (fallback && String(fallback).toLowerCase() !== host) {
    const fb = String(fallback).toLowerCase();
    add(fb, qDir ? [...segs, qDir] : segs);
    if (qDir) add(fb, segs);
  }
  return out;
}

module.exports = {
  parseCacheControl,
  extensionOf,
  shouldBypass,
  isPassthroughHost,
  hostMatches,
  isAssetHost,
  decideStore,
  isStaticAsset,
  normalizeCacheUrl,
  isVersionedAsset,
  browserCacheControl,
  contentTypeForExtension,
  sanitizeSegment,
  cachePaths,
  CONTENT_TYPES,
};
