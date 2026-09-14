/**
 * 诊断脚本：看看碧蓝幻想的素材到底是通过什么方式加载的
 * （XHR / fetch / img / script / 还是 Web Worker 里的请求）。
 * 用法: node tools/cdp.mjs <chrome.exe> <url>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , chromePath, url] = process.argv;
const port = 9335;
const profile = mkdtempSync(path.join(tmpdir(), 'gbf-probe-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  chromePath,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1280,800', 'about:blank'],
  { stdio: 'ignore' }
);

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  throw new Error('no target');
}

const EXPR = `(() => {
  const res = performance.getEntriesByType('resource');
  const byType = {};
  for (const r of res) byType[r.initiatorType] = (byType[r.initiatorType] || 0) + 1;
  const assetish = res
    .filter((r) => /akamaized|\\.png|\\.jpg|\\.mp3|\\.css|\\.js/i.test(r.name))
    .map((r) => ({ t: r.initiatorType, n: r.name.replace(/^https:\\/\\/[^/]+/, ''), size: r.transferSize || 0 }));
  const workers = (window.__gbfProbeWorkers || []);
  return { total: res.length, byType, assetCount: assetish.length, sample: assetish.slice(0, 12), workers };
})()`;

try {
  const target = await waitForTarget();
  const ws = await new Promise((res, rej) => {
    const s = new WebSocket(target.webSocketDebuggerUrl);
    s.addEventListener('open', () => res(s));
    s.addEventListener('error', () => rej(new Error('ws')));
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');
  // 顺便记录页面创建了哪些 Worker
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__gbfProbeWorkers = [];
      const OW = window.Worker;
      window.Worker = function (...a) { window.__gbfProbeWorkers.push(String(a[0])); return new OW(...a); };
      window.Worker.prototype = OW.prototype;`,
  });
  await send('Page.navigate', { url });
  await sleep(20000);
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result.value, null, 2));
} catch (err) {
  console.error('失败:', err.message);
  process.exitCode = 1;
} finally {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(), 500);
}
