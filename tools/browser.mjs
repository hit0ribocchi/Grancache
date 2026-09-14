/**
 * 缓存代理的浏览器端到端验证（用固定等待时间，不依赖 Chrome 的虚拟时间，避免卡住）。
 * 连续跑两次：第一个是空缓存，第二个是全新的浏览器配置（Chrome 自身没缓存），
 * 这样测出来的差距才真正来自"我们的本地缓存"。
 *
 * 用法: node tools/browser.mjs <chrome.exe> <url> [statsUrl]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , chromePath, url, statsUrlArg] = process.argv;
const statsUrl = statsUrlArg || 'http://127.0.0.1:18081/stats';
const pac = 'http://127.0.0.1:18081/proxy.pac';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stats() {
  const r = await fetch(statsUrl);
  return r.json();
}

async function runOnce(label, port) {
  const profile = mkdtempSync(path.join(tmpdir(), 'proxy-e2e-'));
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--proxy-pac-url=${pac}`,
      '--disable-quic',
      `--remote-debugging-port=${port}`,
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const before = await stats();
  let ws;
  try {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = list.find((t) => t.type === 'page');
      } catch {
        /* retry */
      }
      if (!page) await sleep(400);
    }
    if (!page) throw new Error('等不到调试端口');

    ws = await new Promise((res, rej) => {
      const s = new WebSocket(page.webSocketDebuggerUrl);
      s.addEventListener('open', () => res(s));
      s.addEventListener('error', () => rej(new Error('ws')));
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, { resolve, reject });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

    await send('Runtime.enable');
    await send('Page.enable');
    const t0 = Date.now();
    await send('Page.navigate', { url });
    await sleep(22000);
    const html = await evaluate(
      `JSON.stringify({ready: document.readyState, resources: performance.getEntriesByType('resource').length, hasGameRoot: !!document.querySelector('#root, .contents, canvas')})`
    );
    const after = await stats();
    const wall = (Date.now() - t0) / 1000;

    const hit = after.hits - before.hits;
    const miss = after.misses - before.misses;
    const bypass = after.bypass - before.bypass;
    const net = (after.bytesFromNetwork - before.bytesFromNetwork) / 1048576;
    const cached = (after.bytesFromCache - before.bytesFromCache) / 1048576;
    console.log(
      `${label}: 命中=${hit} 未命中=${miss} 透传=${bypass} | 本地读=${cached.toFixed(2)}MB 外网下载=${net.toFixed(2)}MB | 页面=${html}`
    );
    return { hit, miss, bypass, net, cached };
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
    await sleep(1500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

const a = await runOnce('第一次(空缓存)   ', 9341);
const b = await runOnce('第二次(全新配置) ', 9342);
console.log(`\n对比: 外网下载 ${a.net.toFixed(2)}MB -> ${b.net.toFixed(2)}MB，本地读盘 ${a.cached.toFixed(2)}MB -> ${b.cached.toFixed(2)}MB，命中 ${a.hit} -> ${b.hit}`);
process.exit(0);
