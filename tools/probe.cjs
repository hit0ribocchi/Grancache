// 临时验证脚本：确认新增的时延日志真的能打出有用信息。
// 用临时代理目录起 --serve，发几个真实请求，然后把日志原文打印出来。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE = process.execPath;
const PORT = 18998;
const PROJ = path.resolve(__dirname, '..');
// 临时工作目录放系统临时目录，别往项目/.backup-orig 里写：
// 证书从项目拷一份，配置按临时目录改写（缓存/日志都落在临时目录里）
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gbf-probe-'));
fs.cpSync(path.join(PROJ, 'runtime', 'certs'), path.join(T, 'runtime', 'certs'), { recursive: true });
fs.mkdirSync(path.join(T, 'logs'), { recursive: true });
{
  const cfg = JSON.parse(fs.readFileSync(path.join(PROJ, 'config.json'), 'utf8'));
  cfg.listen = { host: '127.0.0.1', port: PORT };
  cfg.statsPort = PORT + 1;
  cfg.cacheDir = path.join(T, 'cache');
  cfg.logFile = path.join(T, 'runtime', 'logs', 'proxy.log');
  fs.writeFileSync(path.join(T, 'config.json'), JSON.stringify(cfg, null, 2));
}

fs.rmSync(path.join(T, 'runtime', 'logs', 'proxy.log'), { force: true });

const child = spawn(NODE, [path.join(PROJ, 'src', 'main.js'), '--serve'], {
  env: { ...process.env, GBF_CACHE_HOME: T },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => process.stderr.write(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(host, p) {
  return new Promise((res) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: 'http://' + host + p,
        headers: { host, 'user-agent': 'probe', 'accept-encoding': 'gzip' },
      },
      (resp) => {
        let n = 0;
        resp.on('data', (d) => (n += d.length));
        resp.on('end', () => res({ status: resp.statusCode, n, xg: resp.headers['x-gbf-cache'] || '' }));
      }
    );
    r.on('error', (e) => res({ err: e.message }));
    r.setTimeout(20000, () => {
      r.destroy();
      res({ err: 'timeout' });
    });
    r.end();
  });
}

(async () => {
  await sleep(3000);
  const cases = [
    ['prd-game-a-granbluefantasy.akamaized.net', '/assets/img/sp/ui/icon/status/x64/status_1302.png'],
    ['prd-game-a-granbluefantasy.akamaized.net', '/assets/img/sp/ui/icon/status/x64/status_1302.png'],
    ['game.granbluefantasy.jp', '/'],
    ['game.granbluefantasy.jp', '/rest/sound/quest_map_bgm?location_id=normal'],
  ];
  console.log('=== 请求结果 ===');
  for (const [h, p] of cases) {
    const r = await get(h, p);
    const st = r.status === undefined ? 'ERR' : String(r.status);
    const nn = r.n === undefined ? 0 : r.n;
    console.log('  ' + st + '  ' + nn + 'B  x-gbf-cache=' + (r.xg || '-') + '  ' + h + p.slice(0, 36));
  }
  await sleep(1500);
  console.log('');
  console.log('########## 新日志输出（原文）##########');
  const log = fs.readFileSync(path.join(T, 'runtime', 'logs', 'proxy.log'), 'utf8');
  console.log(log.trim());
  child.kill();
  process.exit(0);
})();
