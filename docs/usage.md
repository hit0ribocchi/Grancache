# 使用说明

本文是 Grancache 的详细使用文档。快速上手见 [README](../README.md)。

## 工作原理

Grancache 在你本机跑一个 HTTPS 缓存代理，Chrome 通过它访问游戏：

```
平时：      Chrome  →  你的网络出口（直连 / 分流代理）  →  节点  →  服务器
装上之后：  Chrome  →  Grancache（本地 MITM + 磁盘缓存）  →  你的网络出口  →  节点  →  服务器
                          ├─ 素材：命中就本地回，不回源
                          ├─ 动态接口：原样透传（绝不缓存）
                          └─ WebSocket：原样打隧道
```

- **为什么要 MITM**：只有解开 HTTPS、看清请求 URL，才能按路径缓存素材。Grancache 用本机 CA 现场签发证书，出站请求仍交给本机已有的网络出口，不需要改动你的网络设置。
- **出口怎么定**：默认 `upstream.mode = "auto"`，会探测本机常见代理端口；探测到就用它做 CONNECT 隧道 / socks5，探不到就直连。也可以显式指定 `host`/`port`，或写死 `mode: "direct"`（例如已开 TUN）。
- **只缓存该缓存的**：素材主机（`assetHostPatterns`）按本机策略长缓存；动态接口（`/rest/`、`.json`、`.html`、带 `Set-Cookie`）一律透传。
- **只碰碧蓝幻想**：只有碧蓝幻想的域名会被解密并缓存（`granbluefantasy.jp`、`*.mbga.jp`、`prd-game-*.akamaized.net` 等，见 `src/policy.js` 的 `GBF_HOST_PATTERNS`）；**其它域名一律原样隧道放行**，不解密、不缓存、不记录内容，面板上「非 GBF 域名放行」那一行就是它的计数。
- **让已经开着的浏览器也生效**：只给启动的那个 Chrome 加代理参数是不够的（已经开着的浏览器不知道有代理）。开启 `systemProxy`（默认开）后，Grancache 会把 **Windows 系统代理的 PAC** 指向自己，于是所有读系统代理设置的浏览器都会按 PAC 分流——GBF 域名走本地缓存，其它流量照旧交回原来的出口。应用前的原值会快照到 `runtime/system-proxy.json`，`--stop` / 退出时自动还原；只动 `AutoConfigURL` 一个值，不碰 `ProxyEnable` / `ProxyServer`。

## 缓存目录

素材按 **路径镜像** 落盘，目录结构可读、可手动整理、可整包拷贝：

```
<cacheDir>\
  https\
    prd-game-a-granbluefantasy.akamaized.net\
      assets\img\sp\assets\npc\my\3040001000.png        素材本体
      assets\img\sp\assets\npc\my\3040001000.png.ext    元数据（v/ETag/at/ce/ct…）
      assets\img\sp\assets\npc\my\3040001000_ap.png     魔改文件（存在即优先返回）
```

把某个素材命名为 `原名_ap.后缀` 放进对应目录，即可**无条件优先命中**（不参与淘汰，清缓存也会保留）。放好之后在游戏里按一次 **Ctrl+F5**，此后代理由 `no-cache` + ETag 保证魔改始终生效。

## 命令行

| 命令 | 作用 |
|---|---|
| `Grancache.exe` | 打开控制面板（默认行为） |
| `Grancache.exe --play` | 一键启动：确保缓存在跑 + 用带缓存配置打开 Chrome 进游戏 |
| `Grancache.exe --serve` / `--daemon` | 只跑缓存代理（前台带日志 / 后台无窗口） |
| `Grancache.exe --stop` | 停止后台代理（有 pid 归属校验，不会误杀） |
| `Grancache.exe --clear-cache` | 清空素材缓存（保留 `_ap` 魔改文件） |
| `Grancache.exe --panel` / `--panel-only` / `--panel-port=18082` | 起面板（开窗口 / 不开窗口 / 换端口） |
| `Grancache.exe --system-proxy=on` | 接管系统代理（PAC）：让已经开着的浏览器也走缓存（只分流碧蓝幻想域名） |
| `Grancache.exe --system-proxy=off` | 还原系统代理设置（`--stop` 时也会自动还原） |
| `Grancache.exe --port=18080` | 换代理端口（统计端口自动 = 端口 + 1） |
| `Grancache.exe --help` | 查看全部选项 |

## 配置（`config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `cacheDir` | `D:/gbf-cache` | 素材缓存目录（可换盘，改完把旧目录内容移过去） |
| `maxCacheGB` / `maxObjectMB` | `20` / `64` | 总容量上限（LRU 淘汰） / 单对象上限 |
| `assetHostPatterns` | 见文件 | 素材主机白名单：命中即按本机策略缓存 |
| `excludePatterns` | `/rest/` 等 | 绝不缓存的路径 |
| `expireMode` / `revalidateAfterSeconds` | `immortal` / `0` | 永久缓存 / 到期后台条件校验 |
| `verifyIntegrity` | `false` | 命中时按 md5 校验（更安全、略慢） |
| `autoTrustCa` | `true` | 首次运行自动生成并信任本地 CA |
| `systemProxy` | `true` | 启动代理时接管系统代理（PAC），让已开着的浏览器也走缓存；`false` 则只对命令行启动的 Chrome 生效 |
| `overrideEnable` / `optionsPreflightEnable` | `true` | 魔改层 / OPTIONS 本地应答 |
| `staleIfErrorSeconds` / `retryOn5xx` | `0` / `true` | 旧副本顶替窗口 / 网关错误单次重试 |
| `inactiveDays` | `0` | 闲置淘汰（nginx `inactive` 语义，0 = 关） |
| `traceJsonl` / `logKeepRuns` | `true` / `10` | 结构化事件流 / 归档保留轮数 |
| `logMinLevel` | `DEBUG` | 日志级别（DEBUG/INFO/WARN/ERROR） |
| `upstream` | `auto` | 出口探测（候选端口列表、探测超时） |

## 目录结构

```
src\       main.js（入口：CLI/模式/日志/归档/追踪）· cache / policy / certs / upstream · panel\server.js（面板本地服务）
test\      unit / verify / migrate / trace / panel / e2e（纯离线，用临时目录）
tools\     研发工具：report（追踪报告）· latency · audit · bench · disk · throughput · micro · cdp · browser · probe
scripts\   构建与运维：build.ps1（SEA 打包）· bundle.mjs · icon · certs · trust / untrust · prepare · migrate · import · patch
ui\        控制面板前端（React + Ant Design + Vite），构建产物内联进 exe
runtime\   运行期数据：certs\（CA 与叶子证书）· logs\（proxy.log / panel.log / events-*.jsonl / prev\）
docs\      设计与使用文档
```

## 可观测性（调优用）

| 看什么 | 在哪 |
|---|---|
| 实时请求流水 / 命中率 / 缓存占用 | <http://127.0.0.1:18081/>（`/stats`、`/log` 是 JSON） |
| 人读日志（带级别与分段耗时） | `runtime\logs\proxy.log`（`conn=/up=/ttfb=/total=/store=`），上一轮在 `prev\` |
| 结构化事件（一次请求一条） | `runtime\logs\events-YYYY-MM-DD.jsonl` |
| 追踪报告 | `npm run report` —— 「先 MISS 后 HIT」「从未命中」「有对象却没命中（expired/长度不符/全零）」「按主机命中率」「最慢请求」 |
| 时延基准 | `npm run bench` |

每次启动代理都会新开一轮日志，上一轮自动归档到 `runtime\logs\prev\`（默认留 `logKeepRuns` 轮，互不串档）。

## 常见问题

**为什么命中率不高？** 界面卡顿主要来自**不可缓存的动态接口**（每次几百毫秒、多次串行）；素材缓存只加速素材。`npm run report` 里的「不可缓存原因」能看清哪些请求按设计就是透传的。

**为什么魔改文件放了没生效？** 浏览器自己那份缓存会先命中。放好文件后在游戏里按一次 **Ctrl+F5** 即可。

**Chrome 必须先退出？** 是。Chrome 只在启动那一刻读代理设置，所以「一键启动」会先检查；已开着 Chrome 时请完全退出（含托盘）再点。

**某素材加载不出来？** 少数素材域名可能已失效（DNS 解析不到）。Grancache 在运行时会用主机别名改写救回来；若你的浏览器扩展把它写死在旧域名上，可运行 `scripts\patch.ps1` 把扩展源码里的域名改成真实域名，然后在 `chrome://extensions` 点一次「重新加载」。

**端口被占用 / 启不起来？** 日志会直接提示（`端口 18080 已被占用`、`统计页端口 18081 已被占用`）；用 `--port=18090` 换一组端口即可。

**素材是旧的？** 素材按 URL 永久缓存；游戏大版本更新后如有异常，`--clear-cache` 清一次（魔改文件保留），或在浏览器里 Ctrl+F5。

## 迁移与导入

- 换机器：直接把整个 `cacheDir` 拷过去即可（路径镜像，不依赖索引）。
- 导入 ACGPower 缓存包：`node scripts\import.mjs`（回退主机目录由 `cacheHostFallback` 指定）。
- 旧版 `objects/` 布局迁移：`npm run migrate`。

## 安全与隐私

- CA 私钥在 `runtime\certs\ca\ca.key`，只装在你自己的 Windows 账户下（`certutil -user`），**不要外传**；仓库已 gitignore。
- 卸载/恢复：`scripts\untrust.ps1` 取消信任，再删除 `runtime\certs` 即完全恢复。
- **账号数据不缓存**：`/rest/` 等动态接口、带 `Set-Cookie` 的响应一律原样透传。
- **日志脱敏**：`uid`/`token`/`session` 等查询参数的值掩码为 `***`；Cookie / Authorization / 请求体从不记录。
- 面板控制服务只监听 `127.0.0.1`，写操作需要一次性令牌（跨站网页调不动）。
- 魔改只改你本地看到的画面，不改变任何发往服务器的请求；是否使用请自行判断风险。

## 已知限制

- **只加速素材**，不降低战斗/界面的延迟（那部分是不可缓存的动态接口往返）。
- **Windows 专用**（PowerShell 脚本、SEA exe、Chrome 启动方式）。
- 首次进游戏仍需联网下载素材。
