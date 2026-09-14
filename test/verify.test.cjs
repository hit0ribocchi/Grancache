'use strict';
/**
 * 打包前的离线自检（不需要联网、不需要停代理、不碰项目里的 build/）：
 *   1. tools/bundle.mjs 登记的 lib 模块，是否覆盖 src/main.js 与 lib 里**全部**内部 require
 *      —— 漏一个，打出来的 exe 一启动就是 "Cannot find module"；
 *   2. 真跑一次内联 → 语法检查 → 关键新符号是否在里面；
 *   3. 用临时工作目录 `node bundle.js --help` 实跑一遍，确认内联产物能启动。
 *
 * 用法: node tools/verify.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

// ---- 1. bundle.mjs 的模块清单 vs 源码里的内部 require ----
const bundleSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'bundle.mjs'), 'utf8');
const listMatch = /const modules = \[([^\]]*)\]/.exec(bundleSrc);
const modules = listMatch ? [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
check('bundle.mjs 里有 modules 清单', modules.length > 0, modules.join(', '));

const norm = (s) => String(s).replace(/^\.\//, '').replace(/\.js$/, '');
// bundle.mjs 登记的键相对 src/（入口 src/main.js 的 require('./cache') 等），
// 所以比对时把清单里的 'src/' 前缀去掉再比。
const registered = new Set(modules.map((m) => norm(m).replace(/^src\//, '')));
const internal = new Set();
for (const rel of ['src/main.js', ...modules]) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const r of src.matchAll(/require\((['"])(\.\.?\/[^'"]+)\1\)/g)) internal.add(r[2]);
}
const missing = [...internal].filter((r) => !registered.has(norm(r)));
check('源码里所有内部 require 都登记在 bundle.mjs 里', missing.length === 0, missing.join(', ') || `共 ${internal.size} 个`);

// ---- 2. 真跑一次内联（输出到临时目录）----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-bundle-'));
const out = path.join(tmp, 'bundle.js');
const run = spawnSync(NODE, [path.join(ROOT, 'scripts', 'bundle.mjs'), out], { encoding: 'utf8' });
check('bundle.mjs 执行成功', run.status === 0, ((run.stderr || run.stdout || '').trim().split('\n').pop() || ''));
const js = fs.readFileSync(out, 'utf8');
check('内联产物能过语法检查', spawnSync(NODE, ['--check', out]).status === 0);

const symbols = [
  'PathCache', 'getStale', 'evictIdle', 'rescan(', 'shouldStoreBody', 'cachePaths',
  'respondStale', 'upstreamFailed', 'RESCAN_SENTINEL', 'RETRY-5XX', 'OVERRIDE', 'OPTIONS-HIT',
];
const absent = symbols.filter((s) => !js.includes(s));
check('内联产物含本轮全部关键符号', absent.length === 0, absent.join(', ') || `${symbols.length} 个符号齐全`);

// ---- 3. 内联产物实跑（--help 模式：只读配置、不监听端口）----
fs.cpSync(path.join(ROOT, 'config.json'), path.join(tmp, 'config.json'));
const help = spawnSync(NODE, [out, '--help'], {
  cwd: tmp,
  env: { ...process.env, GBF_CACHE_HOME: tmp },
  encoding: 'utf8',
});
const helpText = (help.stdout || '') + (help.stderr || '');
check('内联产物能启动（node bundle.js --help 退出码 0）', help.status === 0, `exit=${help.status}`);
check('内联产物没有 Cannot find module', !/Cannot find module/.test(helpText), (helpText.match(/Cannot find module.*/) || [''])[0]);
check('--help 输出了新的命令行说明', /--clear-cache/.test(helpText) && /魔改素材/.test(helpText));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
