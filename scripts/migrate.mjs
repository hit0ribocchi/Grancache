#!/usr/bin/env node
/**
 * 旧缓存迁移：objects/<2位前缀>/<sha256>.{data,json}
 *            → <cacheDir>/<scheme>/<host>/<url 路径> + 同名 .ext
 *
 * - 数据文件用 rename（同盘秒级），跨盘（EXDEV）自动降级 copy + 删除；
 * - 生成 .ext，字段与 ACGPower 同名同义（v/LastModified/ETag/at/md5/ce/ct）；
 * - **不删除** objects 目录本身，迁移完确认无误后由你手动删；
 * - 已经存在的新布局文件不会被覆盖。
 *
 * 用法:
 *   node tools/migrate.mjs                 # 用 config.json 的 cacheDir
 *   node tools/migrate.mjs --dir D:/gbf-cache
 *   node tools/migrate.mjs --dry           # 只统计，不动文件
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const policy = require(path.join(ROOT, 'src', 'policy.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const dirIdx = argv.indexOf('--dir');
const cacheDir = path.resolve(dirIdx >= 0 ? argv[dirIdx + 1] : config.cacheDir);
const objectsDir = path.join(cacheDir, 'objects');

if (!fs.existsSync(objectsDir)) {
  console.log(`没有旧布局目录，无需迁移：${objectsDir}`);
  process.exit(0);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

async function moveData(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

async function writeExt(abs, meta) {
  const headers = meta.headers || {};
  const record = {
    v: 1,
    url: meta.url || '',
    LastModified: headers['last-modified'] || '',
    ETag: headers.etag || '',
    at: Math.floor((meta.storedAt || Date.now()) / 1000),
    md5: '',
    ce: headers['content-encoding'] || '',
    ct: meta.contentType || headers['content-type'] || '',
    size: meta.size,
    storedAt: meta.storedAt || Date.now(),
    lastAccess: meta.lastAccess || meta.storedAt || Date.now(),
    expiresAt: meta.expiresAt || 0,
    revalidatedAt: meta.revalidatedAt || 0,
    revalidateAt: meta.revalidateAt || 0,
    headers,
  };
  await fsp.writeFile(abs + '.ext', JSON.stringify(record));
  try {
    const lm = Date.parse(record.LastModified);
    if (Number.isFinite(lm)) await fsp.utimes(abs, new Date(), new Date(lm));
  } catch {
    /* mtime 只是给人看的 */
  }
}

const aliases = config.hostAliases || {};
const files = walk(objectsDir);
let moved = 0;
let skipped = 0;
let missing = 0;
let bytes = 0;

for (const metaPath of files) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    skipped++;
    continue;
  }
  if (!meta || !meta.key || !meta.url) {
    skipped++;
    continue;
  }
  const dataOld = path.join(objectsDir, meta.key.slice(0, 2), meta.key + '.data');
  if (!fs.existsSync(dataOld)) {
    missing++;
    continue;
  }

  // 老缓存里的 url 可能还是 prd-game-a1~a5-... 这些已经不存在的别名主机，先按 hostAliases 改写
  let url = meta.url;
  try {
    const u = new URL(url);
    if (aliases[u.hostname]) {
      u.hostname = aliases[u.hostname];
      url = u.toString();
    }
  } catch {
    skipped++;
    continue;
  }

  const candidates = policy.cachePaths({ url }, config);
  if (!candidates || !candidates.length) {
    skipped++;
    continue;
  }
  const rel = candidates[0];
  const abs = path.join(cacheDir, ...rel.split('/'));
  const size = fs.statSync(dataOld).size;
  if (fs.existsSync(abs)) {
    skipped++;
    continue;
  }
  if (dry) {
    moved++;
    bytes += size;
    continue;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await moveData(dataOld, abs);
  await writeExt(abs, { ...meta, url, size });
  fs.rmSync(metaPath, { force: true });
  moved++;
  bytes += size;
}

console.log(
  `${dry ? '[dry-run] ' : ''}迁移完成：成功 ${moved} 个 / ${(bytes / 1048576).toFixed(1)} MB，` +
    `跳过 ${skipped} 个（已有新布局或元信息损坏），数据文件缺失 ${missing} 个`
);
console.log(`旧目录保留在 ${objectsDir}，确认新布局可用后再手动删除。`);
