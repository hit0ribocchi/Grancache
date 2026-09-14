/**
 * 缓存存储方式对比基准：文件系统 vs SQLite vs 纯内存。
 * 用真实缓存里的素材跑，回答"要不要换成 SQLite / Redis"这个问题。
 *
 * 用法: node tools/disk.mjs <cacheDir> [样本数]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cacheDir = process.argv[2];
const limit = Number(process.argv[3] || 400);
if (!cacheDir) {
  console.error('用法: node tools/disk.mjs <cacheDir> [样本数]');
  process.exit(2);
}

// 数据文件 = 缓存目录下所有的文件，排除旁车元数据（.ext）、临时文件与魔改文件。
// 这样新旧两种布局（objects/<hash>.data 与 <scheme>/<host>/<path>）都能直接跑。
function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(p, out);
    else if (
      !entry.name.endsWith('.ext') &&
      !entry.name.endsWith('.tmp') &&
      !/_ap\.[A-Za-z0-9]{1,8}$/i.test(entry.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

const files = collect(cacheDir, []).slice(0, limit);
if (!files.length) {
  console.error('缓存里还没有对象，先玩一会儿游戏再来测');
  process.exit(1);
}
const totalBytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`样本: ${files.length} 个对象, 共 ${(totalBytes / 1048576).toFixed(2)} MB, 平均 ${(totalBytes / files.length / 1024).toFixed(1)} KB\n`);

function stats(times, label) {
  times.sort((a, b) => a - b);
  const pick = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const mbps = totalBytes / 1048576 / (times.reduce((a, b) => a + b, 0) / 1000);
  console.log(
    `${label.padEnd(26)} 平均 ${mean.toFixed(3)} ms  中位 ${pick(0.5).toFixed(3)} ms  p95 ${pick(0.95).toFixed(3)} ms  吞吐 ${mbps.toFixed(0)} MB/s`
  );
}

// ---------- A. 现在的做法：每个对象一个文件 ----------
{
  const times = [];
  for (const f of files) {
    const t = performance.now();
    fs.readFileSync(f);
    times.push(performance.now() - t);
  }
  stats(times, 'A 文件系统(当前)');
}

// ---------- B. SQLite ----------
let sqliteNote = '';
try {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = path.join(os.tmpdir(), `bench-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('PRAGMA mmap_size = 268435456');
  db.exec('CREATE TABLE blobs (key TEXT PRIMARY KEY, body BLOB)');
  const ins = db.prepare('INSERT INTO blobs (key, body) VALUES (?, ?)');
  for (const f of files) ins.run(path.basename(f, '.data'), fs.readFileSync(f));
  const sel = db.prepare('SELECT body FROM blobs WHERE key = ?');
  for (const f of files) sel.get(path.basename(f, '.data')); // 预热
  const times = [];
  for (const f of files) {
    const t = performance.now();
    sel.get(path.basename(f, '.data'));
    times.push(performance.now() - t);
  }
  stats(times, 'B SQLite(单文件)');
  db.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(dbPath + '-wal', { force: true });
  fs.rmSync(dbPath + '-shm', { force: true });
} catch (err) {
  sqliteNote = `（跳过 SQLite：${err.message}）`;
}

// ---------- C. 纯内存（等价于 Redis 的核心收益） ----------
{
  const mem = new Map();
  for (const f of files) mem.set(path.basename(f, '.data'), fs.readFileSync(f));
  const times = [];
  for (const f of files) {
    const t = performance.now();
    mem.get(path.basename(f, '.data'));
    times.push(performance.now() - t);
  }
  stats(times, 'C 纯内存 Map');
}

if (sqliteNote) console.log('\n' + sqliteNote);
