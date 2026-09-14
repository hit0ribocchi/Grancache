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
    // 首次运行自动化：没有 CA 就现场生成（openssl 一般随 Git for Windows 安装）
    this.caCreated = await this.ensureCa();
    if (!fs.existsSync(this.caCertPath) || !fs.existsSync(this.caKeyPath)) {
      throw new Error(
        '找不到本地 CA 证书。请先运行两步：\n' +
          '  1) scripts\\certs.ps1  —— 用 openssl 本机生成 CA 与游戏域名证书\n' +
          '  2) scripts\\trust.ps1  —— 把 CA 装进「当前用户 → 受信任的根证书颁发机构」（不需要管理员）\n' +
          `期望文件：${this.caCertPath}`
      );
    }
    this.caCertPem = await fsp.readFile(this.caCertPath, 'utf8');
    this.caKeyPem = await fsp.readFile(this.caKeyPath, 'utf8');
    await fsp.mkdir(this.leafDir, { recursive: true });
    await this.prewarmCerts();
  }

  /**
   * 缺 CA 时用 openssl 现场生成（幂等）。找不到 openssl 就返回 false，
   * 由 init() 抛出带指引的错误。生成物：runtime/certs/ca/{ca.key,ca.crt,ca.der}
   */
  async ensureCa() {
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) return false;
    const openssl = this.resolveOpenssl();
    if (!openssl) return false;
    await fsp.mkdir(this.caDir, { recursive: true });
    await run(openssl, ['genrsa', '-out', this.caKeyPath, '2048']);
    await run(openssl, [
      'req', '-x509', '-new', '-nodes', '-key', this.caKeyPath, '-sha256', '-days', '3650',
      '-subj', '/CN=Grancache Local CA/O=Grancache', '-out', this.caCertPath,
    ]);
    await run(openssl, ['x509', '-in', this.caCertPath, '-outform', 'der', '-out', path.join(this.caDir, 'ca.der')]);
    return true;
  }

  /** openssl 在哪：config.opensslPath → Git for Windows 默认路径 → PATH */
  resolveOpenssl() {
    const cands = [this.openssl, 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'openssl'];
    for (const c of cands) {
      if (!c) continue;
      if (c === 'openssl' || fs.existsSync(c)) return c;
    }
    return null;
  }

  /** 这张 CA 的 Windows 指纹（SHA-1，去冒号） */
  caThumbprint() {
    if (!this._thumb) {
      const pem = this.caCertPem || fs.readFileSync(this.caCertPath, 'utf8');
      this._thumb = new crypto.X509Certificate(pem).fingerprint.replace(/:/g, '').toUpperCase();
    }
    return this._thumb;
  }

  /** 是否已经在「当前用户 → 受信任的根证书颁发机构」里 */
  async isTrusted() {
    const ps =
      `if (Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${this.caThumbprint()}' }) { 'trusted' } else { 'missing' }`;
    try {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      return /trusted/.test(String(out));
    } catch {
      return false;
    }
  }

  /**
   * 把 CA 装进当前用户的受信任根（不需要管理员权限）。
   * 用 certutil -user，避免依赖 PowerShell 的 PKI 模块。
   */
  async trustCa() {
    const der = path.join(this.caDir, 'ca.der');
    if (!fs.existsSync(der)) {
      await run(this.resolveOpenssl() || 'openssl', ['x509', '-in', this.caCertPath, '-outform', 'der', '-out', der]);
    }
    await run('certutil.exe', ['-user', '-addstore', '-f', 'Root', der]);
    return true;
  }

  /** 预生成 prewarmHosts 的叶子证书（比每次现场签发快，也让 exe 在没有 openssl 时更稳） */
  async prewarmCerts() {
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
