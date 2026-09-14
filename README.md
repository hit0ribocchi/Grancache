# Grancache

> 碧蓝幻想（Granblue Fantasy）的**本地游戏缓存代理**：把素材缓存在本机硬盘，第二次进游戏直接本地读；带一个图形控制面板。
> A local HTTPS cache proxy + control panel for Granblue Fantasy. **Windows only.**

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![license](https://img.shields.io/badge/license-%E6%9C%AA%E6%8C%87%E5%AE%9A-lightgrey)

---

## 快速启动（3 步）

1. 到 [Releases](../../releases) 下载 **`Grancache.exe`**（或自己构建，见 [从源码运行](#从源码运行)）；
2. 把它放到一个固定目录，双击运行 —— 会打开**控制面板**；
3. 面板里点 **「一键启动（缓存 + Chrome + 游戏）」**，代理在后台跑起来，并用带缓存配置的 Chrome 打开游戏。

**首次运行会自动准备好 CA**——CA 是**本机生成**的，不需要下载：

启动时如果 `runtime\certs` 里还没有 CA，Grancache 会用 openssl（Git for Windows 自带）**现场生成**，并把它装进
**「当前用户 → 受信任的根证书颁发机构」**（`certutil -user`，不需要管理员权限）。想关掉自动信任就设
`"autoTrustCa": false`，然后手工执行下面两步：

```powershell
scripts\certs.ps1     # 1) 用 openssl 生成 CA（ca.key/ca.crt）并预生成游戏域名证书
scripts\trust.ps1     # 2) 把 CA 装进「当前用户 → 受信任的根证书颁发机构」（不需要管理员权限）
```

没做这两步，启动会直接报 `找不到本地 CA 证书`。卸载：`scripts\untrust.ps1`（再删掉 `runtime\certs` 即完全恢复）。

> 停止缓存：面板点「停止缓存」，或命令行 `Grancache.exe --stop`。
> 不想开面板、直接一键进游戏：`Grancache.exe --play`（可以只给这一条做快捷方式）。

## 特性

- **路径镜像缓存**：素材按 `<cacheDir>\<scheme>\<host>\<URL 路径>` 落盘，旁边一份同名 `.ext` 元数据 —— 目录可读、可手动整理、可整包拷贝
- **魔改覆盖层**：把文件命名为 `原名_ap.后缀` 放进对应目录即无条件优先命中（不参与淘汰，清缓存也会保留）
- **只缓存该缓存的**：动态接口（`/rest/`、`.json`、`.html`、带 `Set-Cookie`）一律透传；素材主机不看服务器 TTL 直接长缓存
- **完整性与一致性校验**：入库校验 `Content-Length` / 非全零 / 单对象上限；命中校验长度、全零、过期（可选 md5）
- **上游抖动不直接报错**：可缓存目标遇 502/503/504 自动换连接重试一次；开启 `staleIfErrorSeconds` 后还能用「过期但完好」的旧副本顶一次（RFC 5861）
- **编码只存一份**（`.ext.ce` 记录 gzip 与否），不再按 `Accept-Encoding` 分多桶
- **预检本地应答**：素材主机的 `OPTIONS` 直接本地 200（收窄到素材主机 + 静态扩展名）
- **图形控制面板**：启动/停止/重启缓存、一键启动、清空缓存、实时命中率与占用、实时日志（Ant Design 深色界面，Chrome `--app` 应用窗口）
- **结构化追踪**：每次请求一条 JSONL 事件（对象身份、结果、未命中原因、时延、连接复用），配 `tools/report.cjs` 做命中率/时延调优
- **每轮日志隔离**：每次启动代理都开新日志，上一轮自动归档到 `runtime\logs\prev\`（默认留 10 轮，`logKeepRuns` 可调）

## 工作原理

```
平时：      Chrome  →  0dcloud / 其它本地出口（规则分流）  →  节点  →  日服
装上之后：  Chrome  →  Grancache（本地 MITM + 磁盘缓存）  →  0dcloud  →  节点  →  日服
                        ├─ 素材：命中就本地回，不回源
                        ├─ 动态接口：原样透传（绝不缓存）
                        └─ WebSocket：原样打隧道
```

Grancache 用本地 CA 现场签发证书解开 HTTPS（MITM），因此能按 URL 缓存素材；出站请求仍然交给本机已有的代理出口（自动探测端口，默认探 0dcloud 的 `127.0.0.1:17891`），**开不开 TUN 都能用**。给 Chrome 的 PAC 也是分流的：GBF 域名走缓存代理，其它网站直接交给原出口，代理没启动时浏览器退回直连。

磁盘布局：

```
D:\gbf-cache\
  https\
    prd-game-a-granbluefantasy.akamaized.net\
      assets\img\sp\assets\npc\my\3040001000.png        素材本体
      assets\img\sp\assets\npc\my\3040001000.png.ext    元数据（字段与 ACGPower 同名：v/ETag/at/ce/ct…）
      assets\img\sp\assets\npc\my\3040001000_ap.png     魔改文件（存在即优先返回）
```

## 命令行

| 命令 | 作用 |
|---|---|
| `Grancache.exe` | 打开控制面板（默认行为） |
| `Grancache.exe --play` | 一键启动：确保缓存在跑 + 用带缓存配置打开 Chrome 进游戏 |
| `Grancache.exe --serve` / `--daemon` | 只跑缓存代理（前台带日志 / 后台无窗口） |
| `Grancache.exe --stop` | 停止后台代理（有 pid 归属校验，不会误杀） |
| `Grancache.exe --clear-cache` | 清空素材缓存（保留 `_ap` 魔改文件） |
| `Grancache.exe --panel` / `--panel-only` / `--panel-port=18082` | 起面板（开窗口 / 不开窗口 / 换端口） |
| `Grancache.exe --port=18080` | 换代理端口（统计端口自动 = 端口+1） |
| `Grancache.exe --help` | 说明 |

## 从源码运行

要求：Windows 10/11、**Node ≥ 22**（打包 exe 用 24）、Chrome、一个可用的本地出口（0dcloud 等）。

```powershell
git clone https://github.com/hit0ribocchi/Grancache.git
cd Grancache

npm start            # = 打开控制面板
npm run serve        # 只跑代理（前台，看日志）
npm test             # 全量测试（unit / verify / migrate / trace / panel / e2e）

npm run build        # 打包成 Grancache.exe（Node SEA；需要联网拉 postject/rcedit）
npm run ui           # 改了面板界面后重建（首次需 npm --prefix ui install）
```

## 配置（`config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| `cacheDir` | `D:/gbf-cache` | 素材缓存目录（可换盘，改完把旧目录内容移过去） |
| `maxCacheGB` / `maxObjectMB` | `20` / `64` | 总容量上限（LRU 淘汰） / 单对象上限 |
| `assetHostPatterns` | 见文件 | 素材主机白名单：命中即按本机策略缓存 |
| `excludePatterns` | `/rest/` 等 | 绝不缓存的路径 |
| `expireMode` / `revalidateAfterSeconds` | `immortal` / `0` | 永久缓存 / 到期后台条件校验 |
| `verifyIntegrity` | `false` | 命中时按 md5 校验（更安全、略慢） |
| `cacheHostFallback` | 主素材 CDN | 导入 ACGPower 缓存包时的回退主机目录 |
| `overrideEnable` / `optionsPreflightEnable` | `true` | 魔改层 / OPTIONS 本地应答 |
| `staleIfErrorSeconds` / `retryOn5xx` | `0` / `true` | 旧副本顶替窗口 / 网关错误单次重试 |
| `inactiveDays` | `0` | 闲置淘汰（nginx `inactive` 语义，0=关） |
| `traceJsonl` / `logKeepRuns` | `true` / `10` | 结构化事件流 / 归档保留轮数 |
| `logMinLevel` | `DEBUG` | 日志级别（DEBUG/INFO/WARN/ERROR） |
| `upstream` | `auto` | 出口探测（候选端口列表、探测超时） |

## 目录结构

```
src\       main.js（入口：CLI/模式/日志/归档/追踪）· cache/policy/certs/upstream · panel\server.js（面板本地服务）
test\      unit / verify / migrate / trace / panel / e2e（纯离线、用临时目录，不碰真实缓存与配置）
tools\     研发工具：report（追踪报告）· latency · audit · bench · disk · throughput · micro · cdp · browser · probe
scripts\   构建与运维：build.ps1（SEA 打包）· bundle.mjs（内联）· icon · certs · trust/untrust · prepare · migrate · import · patch
ui\        控制面板前端（React + Ant Design + Vite）；构建产物会被内联进 exe
runtime\   运行期数据：certs\（CA 与叶子证书）· logs\（proxy.log / panel.log / events-*.jsonl / prev\）
build\     打包中间产物（可清）
docs\      设计与实施文档（docs/plan-acgpower-cache-mvp.md）
```

## 可观测性（调优用）

| 看什么 | 在哪 |
|---|---|
| 实时请求流水 / 命中率 / 缓存占用 | <http://127.0.0.1:18081/>（`/stats`、`/log` 是 JSON） |
| 人读日志（带级别与分段耗时） | `runtime\logs\proxy.log`（`conn=/up=/ttfb=/total=/store=`），上一轮在 `prev\` |
| 结构化事件（一次请求一条） | `runtime\logs\events-YYYY-MM-DD.jsonl` |
| 追踪报告（命中率/时延调优） | `npm run report`（或 `node tools\report.cjs`）——给出「先 MISS 后 HIT」「从未命中」「有对象却没命中（expired/长度不符/全零）」「按主机命中率」「最慢请求」 |
| 时延基准 | `npm run bench` |

## 常见问题

**为什么命中率不高？** GBF 的界面卡顿主要来自**不可缓存的动态接口**（每次几百毫秒、几十次串行）；素材缓存只加速素材。`npm run report` 里的「不可缓存原因」能看清哪些请求按设计就是透传的。

**为什么魔改文件放了没生效？** 浏览器自己那份缓存会先命中。放好文件后在游戏里 **Ctrl+F5** 刷一次即可（此后代理会用 `no-cache` + ETag 保证魔改始终生效）。

**Chrome 必须先退出？** 是。Chrome 只在启动那一刻读代理设置，所以「一键启动」会先检查；已开着 Chrome 时请完全退出（含托盘）再点。

**太郎插件素材加载不出来？** 太郎把素材域名写死在 `prd-game-a1/a5-…akamaized.net`，这些域名 DNS 已失效：代理在跑时靠别名改写救回来，代理停掉就挂。跑 `scripts\patch.ps1` 把扩展源码里的域名改成真实域名，然后在 `chrome://extensions` 点一次「重新加载」即可（代理开/关都正常）。

**端口被占用 / 启不起来？** 会在日志里直接提示（`端口 18080 已被占用`、`统计页端口 18081 已被占用`）；用 `--port=18090` 换一组端口即可。

**素材是旧的？** 素材按 URL 永久缓存；游戏大版本更新后如遇异常，`--clear-cache` 清一次（魔改文件保留），或在浏览器里 Ctrl+F5。

## 安全与隐私

- 代理会在本机解开 HTTPS（MITM）—— 这是缓存素材的前提。CA 只装在你自己的 Windows 账户下，**私钥在 `runtime\certs\ca\ca.key`，不要外传**（仓库已 gitignore，绝不入库）；不想用了跑 `scripts\untrust.ps1` 并删除 `runtime\certs` 即完全恢复。
- **账号数据不缓存**：`/rest/` 等动态接口、带 `Set-Cookie` 的响应一律原样透传。
- **日志脱敏**：`uid`/`token`/`session` 等查询参数的值在日志里掩码为 `***`；Cookie / Authorization / 请求体从不记录。
- 面板的本地控制服务只监听 `127.0.0.1`，写操作要求一次性令牌（跨站网页调不动）。
- 魔改只改你本地看到的画面，不改变任何发往服务器的请求；是否使用请自行判断风险（社区对魔改存在封号争议）。

## 已知限制

- **只加速素材**，不会降低战斗/界面的延迟 —— 那些是不可缓存的动态接口往返；想更快只能换延迟更低的节点。
- Windows 专用（PowerShell 脚本、SEA exe、Chrome 启动方式）。
- 首次进游戏仍需联网下载素材；缓存包可跨机器拷贝（见 `scripts\import.mjs` 与 `scripts\migrate.mjs`）。

## 致谢

- **ACGPower**：路径镜像 + `.ext` 元数据 + `_ap` 魔改约定参考（本项目按公开行为与反编译分析实现，未使用其代码）。
- **nginx** `proxy_cache`：`inactive` 闲置淘汰、`use_stale` 的语义参考。
- **cacache / make-fetch-happen**：诊断头语义参考。
- **太郎（Tarou）** 插件：素材域名补丁脚本（`scripts\patch.ps1`）。

## 许可证

目前**未指定**许可证（仓库默认可看不可用）。如果你要公开复用，建议加一份 MIT：说一声我就补 `LICENSE` 并在上面挂上对应 badge。

---

详细设计与调试记录见 [`docs/plan-acgpower-cache-mvp.md`](docs/plan-acgpower-cache-mvp.md)；项目笔记在 [`.workbuddy/`](.workbuddy/)。
