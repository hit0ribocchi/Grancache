'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message += `\n命令: ${cmd} ${args.join(' ')}\n${stderr || stdout}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

// 按 SNI 现场签发叶子证书（用本地 CA 签名），按主机名缓存到磁盘。
// 这就是“明文看得到 HTTPS 内容”的前提，只在本机使用。
class CertStore {
  constructor(opts) {
    this.root = opts.root;
    this.caDir = path.join(this.root, 'ca');
    this.leafDir = path.join(this.root, 'leaf');
    this.openssl = opts.opensslPath;
    this.prewarmHosts = opts.prewarmHosts || [];
    this.contexts = new Map();
    this.pending = new Map();
    this.caCertPem = '';
    this.caKeyPem = '';
  }

  get caCertPath() {
    return path.join(this.caDir, 'ca.crt');
  }

  get caKeyPath() {
    return path.join(this.caDir, 'ca.key');
  }

  async init() {
    if (!fs.existsSync(this.caCertPath) || !fs.existsSync(this.caKeyPath)) {
      throw new Error(
        `找不到本地 CA 证书，请先运行 tools/certs.ps1。\n期望文件：${this.caCertPath}`
      );
    }
    this.caCertPem = await fsp.readFile(this.caCertPath, 'utf8');
    this.caKeyPem = await fsp.readFile(this.caKeyPath, 'utf8');
    await fsp.mkdir(this.leafDir, { recursive: true });

    for (const host of this.prewarmHosts) {
      try {
        await this.getSecureContext(host);
      } catch (err) {
        console.error(`[certs] 预生成证书失败 ${host}: ${err.message}`);
      }
    }
  }

  _files(host) {
    const safe = host.replace(/[^A-Za-z0-9._-]/g, '_');
    return {
      crt: path.join(this.leafDir, safe + '.crt'),
      key: path.join(this.leafDir, safe + '.key'),
    };
  }

  async _validCachedCert(crtPath, keyPath) {
    try {
      const [crt, key] = await Promise.all([fsp.readFile(crtPath, 'utf8'), fsp.readFile(keyPath, 'utf8')]);
      const info = new crypto.X509Certificate(crt);
      const notAfter = Date.parse(info.validTo);
      if (!Number.isFinite(notAfter) || notAfter - Date.now() < 7 * 86400 * 1000) return null;
      return { crt, key };
    } catch {
      return null;
    }
  }

  async getSecureContext(host) {
    const name = host && host.includes('.') ? host : 'localhost';
    if (this.contexts.has(name)) return this.contexts.get(name);
    if (this.pending.has(name)) return this.pending.get(name);

    const task = this._build(name)
      .then((ctx) => {
        this.contexts.set(name, ctx);
        this.pending.delete(name);
        return ctx;
      })
      .catch((err) => {
        this.pending.delete(name);
        throw err;
      });
    this.pending.set(name, task);
    return task;
  }

  async _build(host) {
    const { crt: crtPath, key: keyPath } = this._files(host);
    let pair = await this._validCachedCert(crtPath, keyPath);
    if (!pair) {
      pair = await this._sign(host, crtPath, keyPath);
    }
    return require('tls').createSecureContext({ cert: pair.crt, key: pair.key });
  }

  async _sign(host, crtPath, keyPath) {
    const tmpDir = path.join(this.leafDir, '.tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const csr = path.join(tmpDir, stamp + '.csr');
    const ext = path.join(tmpDir, stamp + '.cnf');
    const tmpKey = path.join(tmpDir, stamp + '.key');

    const altName = host.startsWith('*.') ? `DNS:${host},DNS:${host.slice(2)}` : `DNS:${host}`;
    const extBody = [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${altName}`,
      '',
    ].join('\n');
    await fsp.writeFile(ext, extBody);

    const openssl = this.openssl;
    await run(openssl, [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', tmpKey, '-out', csr, '-subj', `/CN=${host}`,
    ]);
    await run(openssl, [
      'x509', '-req', '-in', csr,
      '-CA', this.caCertPath, '-CAkey', this.caKeyPath, '-CAcreateserial',
      '-out', crtPath, '-days', '825', '-sha256', '-extfile', ext,
    ]);
    await fsp.copyFile(tmpKey, keyPath);
    await fsp.rm(csr, { force: true }).catch(() => {});
    await fsp.rm(ext, { force: true }).catch(() => {});
    await fsp.rm(tmpKey, { force: true }).catch(() => {});

    const crt = await fsp.readFile(crtPath, 'utf8');
    const key = await fsp.readFile(keyPath, 'utf8');
    return { crt, key };
  }
}

module.exports = { CertStore };
