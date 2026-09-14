'use strict';

const net = require('net');
const tls = require('tls');

/**
 * 上游出口。
 *
 * 为什么需要它：Node 程序默认不会走系统代理。如果 0dcloud 是"规则模式 + 系统代理"
 * （没开 TUN），缓存代理直接连出去就绕过了 0dcloud 的分流，GBF 反而连不上。
 * 所以这里把出口请求交给 0dcloud 的本机端口，由它按规则决定走节点还是直连：
 *
 *   Chrome → 本地缓存代理 → 0dcloud(规则分流) → 节点/直连 → 服务器
 *
 * 支持 http（CONNECT 隧道）和 socks5 两种上游，也支持 direct（TUN 模式下的直连）。
 * mode = "auto" 时会自动探测本机常见代理端口，探不到就退回 direct。
 */

const COMMON_PORTS = [17891, 7890, 7897, 7891, 10809, 10808, 2080, 20171, 1080, 8889, 33210];
const PROBE_TARGETS = [
  ['www.gstatic.com', 443],
  ['www.baidu.com', 443],
];

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// 真正问一句"你是不是 HTTP 代理"，避免把控制端口（比如 mihomo 的 9090）误当代理端口
function httpProxyProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let idx = 0;
    let buffer = '';
    let settled = false;
    const socket = net.connect({ host, port });

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    const tryNext = () => {
      if (idx >= PROBE_TARGETS.length) return finish(false);
      const [h, p] = PROBE_TARGETS[idx++];
      socket.write(`CONNECT ${h}:${p} HTTP/1.1\r\nHost: ${h}:${p}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', tryNext);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const head = buffer.split('\r\n')[0] || '';
      if (/^HTTP\/1\.[01] 200/.test(head)) return finish(true);
      if (/^HTTP\/1\.[01] \d{3}/.test(head)) {
        // 代理回了非 200（比如 502），说明它确实是代理，只是这个目标不通
        if (idx >= PROBE_TARGETS.length) return finish(true);
        buffer = '';
        tryNext();
        return;
      }
      if (buffer.length > 8192) finish(false);
    });
  });
}

class Upstream {
  constructor(opts = {}) {
    this.mode = opts.mode || 'auto'; // auto | direct | http | socks5
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || 0;
    this.candidates = opts.candidates && opts.candidates.length ? opts.candidates : COMMON_PORTS;
    this.timeoutMs = opts.probeTimeoutMs || 1500;
    this.resolved = { type: 'direct', host: this.host, port: 0 };
    this.failures = 0;
    this.probing = null;
  }

  get activePort() {
    return this.resolved.type === 'direct' ? 0 : this.resolved.port;
  }

  describe() {
    if (this.resolved.type === 'direct') return 'direct（直连，TUN 模式可用）';
    return `${this.resolved.type}://${this.resolved.host}:${this.resolved.port}`;
  }

  async init() {
    if (this.mode === 'direct') {
      this.resolved = { type: 'direct', host: this.host, port: 0 };
      return this.resolved;
    }
    if ((this.mode === 'http' || this.mode === 'socks5') && this.port) {
      const type = this.mode;
      if (type === 'http' && !(await httpProxyProbe(this.host, this.port, this.timeoutMs))) {
        console.error(`[upstream] ${this.host}:${this.port} 不像一个可用的 HTTP 代理，仍然按配置使用`);
      }
      this.resolved = { type, host: this.host, port: this.port };
      return this.resolved;
    }
    return this.autoDetect();
  }

  async autoDetect() {
    for (const port of this.candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await tcpProbe(this.host, port, 300))) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await httpProxyProbe(this.host, port, this.timeoutMs)) {
        this.resolved = { type: 'http', host: this.host, port };
        this.failures = 0;
        return this.resolved;
      }
    }
    this.resolved = { type: 'direct', host: this.host, port: 0 };
    return this.resolved;
  }

  noteSuccess() {
    this.failures = 0;
  }

  noteFailure() {
    this.failures++;
    // 上游挂了（比如 0dcloud 重启了），过一会儿重新探测
    if (this.failures >= 5 && !this.probing) {
      this.probing = this.autoDetect()
        .catch(() => this.resolved)
        .finally(() => {
          this.probing = null;
        });
    }
  }

  /**
   * 真正建立到目标主机的连接（已在需要时穿过上游）
   * @param {string} targetHost
   * @param {number} targetPort
   * @returns {Promise<net.Socket>}
   */
  connect(targetHost, targetPort) {
    const r = this.resolved;
    if (r.type === 'direct') {
      return new Promise((resolve, reject) => {
        const socket = net.connect({ host: targetHost, port: targetPort });
        socket.once('connect', () => resolve(socket));
        socket.once('error', (err) => {
          this.noteFailure();
          reject(err);
        });
      });
    }
    if (r.type === 'socks5') return this._connectSocks5(r, targetHost, targetPort);
    return this._connectHttp(r, targetHost, targetPort);
  }

  _connectHttp(r, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const socket = net.connect({ host: r.host, port: r.port });
      const fail = (err) => {
        socket.removeAllListeners();
        socket.destroy();
        // 上游隧道建不起来，累加失败计数；连续失败会自动重探端口，
        // 免得 0dcloud 重启/换端口之后代理一直死在旧端口上。
        this.noteFailure();
        reject(err);
      };
      socket.setTimeout(this.timeoutMs * 8, () => fail(new Error('上游代理连接超时')));
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.write(
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`
        );
      });
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        if (!buffer.includes('\r\n\r\n')) {
          if (buffer.length > 8192) fail(new Error('上游代理响应异常'));
          return;
        }
        socket.removeListener('data', onData);
        socket.setTimeout(0);
        const head = buffer.split('\r\n')[0] || '';
        if (/^HTTP\/1\.[01] 200/.test(head)) {
          const rest = buffer.slice(buffer.indexOf('\r\n\r\n') + 4);
          if (rest.length) socket.unshift(Buffer.from(rest, 'latin1'));
          this.noteSuccess();
          resolve(socket);
        } else {
          fail(new Error(`上游代理拒绝：${head.trim()}`));
        }
      };
      socket.on('data', onData);
    });
  }

  _connectSocks5(r, targetHost, targetPort) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: r.host, port: r.port });
      let stage = 0;
      const fail = (err) => {
        socket.removeAllListeners();
        socket.destroy();
        this.noteFailure();
        reject(err);
      };
      socket.setTimeout(this.timeoutMs * 8, () => fail(new Error('SOCKS5 连接超时')));
      socket.once('error', fail);
      socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
      socket.on('data', (chunk) => {
        if (stage === 0) {
          if (chunk[0] !== 0x05 || chunk[1] !== 0x00) return fail(new Error('SOCKS5 握手失败'));
          stage = 1;
          const hostBuf = Buffer.from(targetHost, 'utf8');
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]);
          socket.write(req);
          return;
        }
        if (chunk[1] === 0x00) {
          socket.removeAllListeners('data');
          socket.setTimeout(0);
          this.noteSuccess();
          resolve(socket);
        } else {
          fail(new Error(`SOCKS5 连接失败，代码 ${chunk[1]}`));
        }
      });
    });
  }

  /**
   * 给 https 请求用的 socket 工厂：先穿过上游，再在上面做 TLS。
   * Node 的 https.Agent 期望拿到一个"已经握好 TLS"的 socket，所以这里要自己包一层。
   */
  createTlsConnection(targetHost, targetPort, servername, rejectUnauthorized) {
    return (options, cb) => {
      // cb 只能回调一次：原来那句 tlsSocket.once('error', err => cb(err)) 是"永久"挂着不摘的，
      // 握手成功后 socket 再正常断开会二次调用 cb，把 Agent 的连接记账搞乱。
      let settled = false;
      const done = (err, socket) => {
        if (settled) return;
        settled = true;
        cb(err, socket);
      };
      this.connect(targetHost, targetPort)
        .then((raw) => {
          const tlsSocket = tls.connect(
            {
              socket: raw,
              servername: servername || targetHost,
              rejectUnauthorized: rejectUnauthorized !== false,
            },
            () => done(null, tlsSocket)
          );
          // 用 on 而不是 once：既保证不重复回调，也保证 socket 的 error 永远有人接，
          // 不会因为"没有 error 监听"把整个代理进程打崩。
          tlsSocket.on('error', (err) => {
            if (settled) return;
            this.noteFailure();
            done(err);
          });
        })
        .catch((err) => {
          this.noteFailure();
          done(err);
        });
    };
  }

  /** 给 http 请求用的 socket 工厂 */
  createPlainConnection(targetHost, targetPort) {
    return (options, cb) => {
      this.connect(targetHost, targetPort).then((socket) => cb(null, socket)).catch((err) => cb(err));
    };
  }
}

module.exports = { Upstream, httpProxyProbe, COMMON_PORTS };
