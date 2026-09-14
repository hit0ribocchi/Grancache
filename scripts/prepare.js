'use strict';

/**
 * 预生成所有会用到的域名证书。
 * 目的是让运行期不再需要 openssl（打包成单文件 exe 后就没有 openssl 可用了）。
 * 由 tools/certs.ps1 在生成 CA 之后自动调用。
 */

const path = require('path');
const { CertStore } = require('../certs');

const ROOT = path.join(__dirname, '..');
const config = require(path.join(ROOT, 'config.json'));

(async () => {
  const store = new CertStore({
    root: path.join(ROOT, 'runtime', 'certs'),
    opensslPath: config.opensslPath,
    prewarmHosts: config.prewarmHosts,
  });
  await store.init();
  console.log(`已预生成 ${(config.prewarmHosts || []).length} 张域名证书：`);
  for (const host of config.prewarmHosts || []) console.log('  - ' + host);
})().catch((err) => {
  console.error('预生成证书失败：' + err.message);
  process.exit(1);
});
