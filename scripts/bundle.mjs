/**
 * 把 gbf-cache-proxy 打成一个自包含的 JS 文件（无第三方依赖）。
 * 打包成 exe 之前需要先做这一步，因为单文件运行时不能 require 其它文件。
 *
 * 用法: node tools/bundle.mjs [输出文件]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.resolve(process.argv[2] || path.join(projectDir, 'build', 'bundle.js'));

const modules = ['src/cache.js', 'src/certs.js', 'src/panel/server.js', 'src/policy.js', 'src/upstream.js'];

const chunks = [];
chunks.push(`'use strict';
// 自动生成：把内部模块内联进来，方便打成单文件 / 单 exe。请勿手工修改。
const __mods = Object.create(null);
const __loaded = Object.create(null);
function __require(id) {
  if (Object.prototype.hasOwnProperty.call(__mods, id)) {
    if (!__loaded[id]) {
      const m = { exports: {} };
      __loaded[id] = m;
      __mods[id](m, m.exports, __require);
    }
    return __loaded[id].exports;
  }
  return require(id);
}
`);

for (const rel of modules) {
  const src = fs.readFileSync(path.join(projectDir, rel), 'utf8');
  // 键要相对 src/ 目录（入口 src/main.js 里的 require('./cache') 等），
  // 否则 __require 找不到内联模块 —— verify.cjs 会检查这一致性。
  const keyNoExt = './' + path.relative('src', rel).split(path.sep).join('/').replace(/\.js$/, '');
  // 注意：不能写成 __mods[a, b] = ...（那是逗号表达式，只会注册最后一个键）
  chunks.push(
    `__mods[${JSON.stringify(keyNoExt)}] = __mods[${JSON.stringify('./' + rel)}] = function (module, exports, require) {\n${src}\n};\n`
  );
}

// 控制面板的前端产物（ui/dist）内联进来：这样 exe 自带界面，
// 不依赖磁盘上是否还存在 ui 目录。没有 dist（没构建过）就跳过。
const distDir = path.join(projectDir, 'ui', 'dist');
if (fs.existsSync(distDir)) {
  const panelFiles = {};
  const walk = (dir, base = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else panelFiles[rel] = { b64: fs.readFileSync(p).toString('base64') };
    }
  };
  walk(distDir);
  const payload = JSON.stringify({ files: panelFiles });
  chunks.push(
    `__mods['./panel-assets'] = __mods['./panel-assets.js'] = function (module, exports, require) {\n` +
      `  module.exports = JSON.parse(${JSON.stringify(payload)});\n};\n`
  );
  console.log(`已内联控制面板界面：${Object.keys(panelFiles).length} 个文件`);
} else {
  console.log('（未找到 ui/dist，跳过界面内联：源码运行时会读磁盘目录）');
}

// 主脚本也要包一层，否则它里面的 require('./xxx') 会走真正的 require 而找不到文件
chunks.push(
  `__mods['__main__'] = function (module, exports, require) {\n${fs.readFileSync(
    path.join(projectDir, 'src/main.js'),
    'utf8'
  )}\n};\n__require('__main__');\n`
);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, chunks.join('\n'), 'utf8');

const size = fs.statSync(outFile).size;
console.log(`已生成 ${path.relative(process.cwd(), outFile)}（${(size / 1024).toFixed(1)} KB，内联 ${modules.length} 个模块）`);
