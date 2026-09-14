# 碧蓝幻想 本地缓存加速（缓存代理）

一个跑在本机的 HTTPS 缓存代理：把碧蓝幻想的素材存到本机硬盘，
第二次进游戏直接本地读，不再走节点下载。

## 用法

**双击 `Grancache.exe`** —— 打开控制面板（**只有一个 exe**）。面板里点「一键启动」＝起缓存 + 用带缓存的配置打开 Chrome 进游戏；
想跳过面板直接进游戏，就用 `Grancache.exe --play`（可以只给这一条做个桌面快捷方式）。

### 图形界面：双击 `Grancache.exe`

打开的是一个**应用窗口**（没有地址栏/标签页，界面用 Ant Design 做的深色面板）：

| 按钮 | 等价命令 / 作用 |
|---|---|
| **一键启动（缓存 + Chrome + 游戏）** | 等价 `Grancache.exe --play`：确保缓存在后台跑起来，再用带缓存配置打开 Chrome 进游戏 |
| **启动缓存 / 停止缓存 / 重启缓存** | `--daemon` / `--stop` / 先停再起 —— 单独开关"要不要用缓存" |
| **清空缓存** | `--clear-cache`（保留 `_ap` 魔改文件，有二次确认） |
| **打开统计页 / 用记事本打开日志** | 打开 `http://127.0.0.1:18081/` ／ 打开 `runtime\logs\proxy.log` |

面板实时显示：状态（运行中/已停止 + PID）、运行时长、命中率、请求/命中、缓存占用与对象数、
上游出口、淘汰/魔改/预检/旧副本/未入库计数，以及 `runtime\logs\proxy.log` 最近 12 行。

技术细节（想改界面时看这里）：

- 界面源码在 `ui/`（React + Ant Design + Vite）。改完执行
  `cd ui && npm install && npm run build`，再
  `scripts\build.ps1 -OutName Grancache.exe -NoStop` 重新打包；构建产物会**内联进 exe**，
  所以面板运行时不依赖 `ui/` 目录、也不需要联网。
- 面板本体是 exe 的 `--panel` 模式：在 127.0.0.1:18082 起本地控制服务（带一次性令牌，别的网页调不动），
  并用 Chrome 的 `--app` 打开窗口。`--panel-only` 只起服务不开窗口（自动化测试用），`--panel-port=` 换端口。
- **一个 exe，四种用法**：不带参数双击 = 面板；`--play` = 一键启动；`--serve`/`--daemon` = 只跑代理；
  `--stop` / `--clear-cache` / `--help` = 停止 / 清缓存 / 说明。面板也支持 `--panel-only`（只起服务不开窗口）和 `--panel-port=`。

其它参数：

| 参数 | 作用 |
|---|---|
| （无参数） | 一键开始：后台起代理 + 打开 Chrome 和游戏 |
| `--serve` | 只运行代理（前台，带日志窗口） |
| `--daemon` | 只运行代理（后台，无窗口） |
| `--stop` | 停止后台运行的代理 |
| `--clear-cache` | 清空素材缓存 |
| `--port=18080` | 换端口（统计端口自动取端口+1） |
| `--help` | 说明 |

卸载证书：右键 `scripts\untrust.ps1` →「使用 PowerShell 运行」。

## 出口交给 0dcloud（开不开 TUN 都能用）

启动时自动探测本机代理端口（你这台是 0dcloud 的 `127.0.0.1:17891`），
出站请求都交给它，由 0dcloud 按规则分流：

```
Chrome → 本地缓存代理 → 0dcloud（规则分流） → 节点/直连 → 服务器
```

配置在 `config.json` 的 `upstream` 段：`mode` 可选 `auto`（默认，自动探测）、
`direct`（配合 TUN）、`http` / `socks5`（手动指定端口）。探测不到上游会退回直连。

给 Chrome 的 PAC 同样分流：GBF 域名走本代理，其它网站直接交给 0dcloud。

## 缓存策略

- **永久缓存**（`expireMode: "immortal"`），不设 TTL
- **素材主机白名单**（`assetHostPatterns`）：素材 CDN 上的 GET 响应不看服务器 TTL 直接缓存
- **动态接口不缓存**：`/rest/`、`.html`、`.json`、带 Cookie 的响应、`text/html` 一律透传
- 非 443 端口（如 WebSocket `ws.game.granbluefantasy.jp:11240`）原样打隧道
- **路径镜像存储**：素材按 `<cacheDir>/<scheme>/<host>/<url 路径>` 落盘，旁边一份同名 `.ext` 元数据（可手动整理、可整包拷贝）
- **入库要过完整性校验**：`content-length` 与实际字节数一致、非全零、不超过 `maxObjectMB`；不符的只转发不入库（日志 `MISS-NOSTORE`）
- **命中要过一致性校验**：长度与 `.ext.size` 不符、全零、已过期 → 删掉该对象并按未命中回源
- 编码只留**一份**（`.ext.ce` 记录 gzip 与否），不再按 accept-encoding 分三桶
- `blockHostPatterns`：第三方统计/广告脚本直接秒失败，不让浏览器干等超时
- 命中的响应会改写 `cache-control` 为长期有效，让浏览器自己那份缓存也留着
- 静态资源请求中的 `_`、`t`、`uid` 参数不会制造重复缓存（对所有可缓存主机生效）；带版本参数的素材长期缓存，无版本素材浏览器缓存 5 分钟
- 同一素材正在首次下载时，后续并发请求会等待同一份下载结果，减少重复外网请求
- **上游抖动不再直接吃 502**：可缓存目标遇到 502/503/504 会换连接重试一次；
  打开 `staleIfErrorSeconds` 后，还能用"已过期但内容完好"的旧副本顶一次（响应会带
  `Age`、`X-GBF-Cache: STALE` 和 `no-cache`，损坏对象绝不会被顶上来）

## 目录结构与魔改素材

```
D:\gbf-cache\
  https\
    prd-game-a-granbluefantasy.akamaized.net\
      assets\img\sp\assets\npc\my\3040001000.png        素材本体
      assets\img\sp\assets\npc\my\3040001000.png.ext    元数据（字段与 ACGPower 同名：v/ETag/at/ce/ct…）
      assets\img\sp\assets\npc\my\3040001000_ap.png     魔改文件（存在就无条件优先返回）
```

- 查找顺序：**魔改文件 → 本地缓存 → 回源**（照搬 ACGPower 的优先级）
- 魔改文件**不参与 LRU 淘汰、不计入 `maxCacheGB`**，所以不会被自动清掉
- `--clear-cache` 清的是缓存对象，**`_ap` 魔改文件会被保留**（输出里会写明保留了几个）
- 带版本参数的素材会多一层目录：`/a.png?v=2` → `...\assets\img\__q_v=2\a.png`
  （魔改文件放带版本那一层或原路径那一层都能命中）
- 魔改文件以 `cache-control: no-cache` + `ETag: "ap-<mtime>-<size>"` 返回：
  浏览器每次都来问一次，内容没变就只回 304，不会重复传输

**怎么用**：把改好的文件重命名成「原名_ap.后缀」（原文件叫 `a.png` 就放 `a_ap.png`）放进对应目录，
然后进游戏 **Ctrl+F5** 刷一次（清掉浏览器里已存的原图），之后就不用再清了。
魔改只改你本地看到的画面，不改变任何发往服务器的请求。

## 迁移旧缓存 / 导入 ACGPower 缓存包

```powershell
# 1) 老的 objects 布局 → 路径镜像布局（不动旧目录，确认没问题后再手动删）
node scripts\migrate.mjs
node scripts\migrate.mjs --dry        # 只看会搬多少，不写盘

# 2) 导入 ACGPower 的缓存包（指向它的 cache\gbf 目录），缺 .ext 的会自动补
node scripts\import.mjs --src "D:\ACG\cache\gbf"
```

- 导入目标是 `cacheHostFallback`（默认主素材 CDN），其它 CDN 别名靠**主机回退**命中同一份文件
- 运行中的代理会**按需接管**新出现的对象（不用重启代理），但浏览器里那份旧缓存仍要 Ctrl+F5 刷一次

## 看日志判断"卡在哪一段"

### 结构化追踪：素材到底有没有被缓存住

除了给人看的 `runtime\logs\proxy.log`，代理还会写一份**机器可读**的事件流 `logs\events-YYYY-MM-DD.jsonl`（一次请求一条，
超过 `traceMaxMB`（默认 16 MB）轮转成 `.1`，可用 `traceJsonl: false` 关掉）。它能回答人眼看不出来的问题：

```powershell
node tools\report.cjs          # 今天的报告；--top 20 多列明细
```

报告里会给出：结果分布（HIT/MISS/BYPASS/MISS-NOSTORE/STALE…）、不可缓存的原因、写入/不入库的原因、
**"第一次未命中、后来命中"的对象数与间隔**、**"只 MISS 过、从未命中"的对象**，以及
**"本机有对象却没命中"的原因**（过期 expired / 长度不符 size-mismatch / 全零 all-zero / 读不到 unreadable）。
字段与枚举的完整说明见 `docs\plan-acgpower-cache-mvp.md` 的"阶段 11"。

每条请求日志末尾都带分段耗时（毫秒）。**卡顿感来自尾部延迟，所以要看 p90 和 max，不是平均值。**

```
BYPASS 200 33.5KB (set-cookie) game.granbluefantasy.jp /multiraid/content/index/... | conn=125 up=227 ttfb=227 body=41 total=268 newconn in3
MISS->STORE 12.0KB (asset-host, ttl=0s) prd-game-....akamaized.net /assets/x.png    | up=9 ttfb=11 body=1 total=12 reuse in1 store=10
HIT 12.0KB prd-game-....akamaized.net /assets/a.png                                 | cache=0 total=1 ^0
```

| 字段 | 含义 |
|---|---|
| `conn` | 上游新建连接耗时（TCP + TLS 握手）。**只有新建连接才有**，复用时不出现 |
| `up` | 从发出请求到收到响应头，即上游耗时 |
| `ttfb` | 从收到浏览器请求到响应头开始回写，浏览器视角的首字节时间 |
| `body` | 读完响应体并写回浏览器的耗时 |
| `total` | 整个请求的总耗时 |
| `cache` | 查本地缓存索引的耗时（HIT 时就是全部开销） |
| `store` | 落盘耗时。**不阻塞浏览器**，但很慢会拖累后续请求 |
| `newconn` / `reuse` | 上游连接是新建还是复用。**两者差 100–250ms**，这是最值得盯的指标 |
| `retryN` | 这条请求因连接半死重试了 N 次 |
| `inN` | 请求发起时的在途请求数（并发度）。撞上限速时这个值会偏高 |
| `^N` | HIT 行专用，当前在途数 |

**时延聚合看 `/stats`**：`latency` 段给出各阶段的中位/p90/p99/max 和标准差，
以及 `reuse`/`newConn`/`retries` 计数与在途峰值。

**周期性日志**每 60 秒打一行 `[latency]`，形如
`[latency] 单位ms 中位/p90/最大 total:280/890/1900 up:150/700/1800 ... | 上游复用=42 新建=7 重试=1 在途=3(峰值=12)`。

### 实测归因结论（2026-09 实测，供以后对照）

**先说结论：卡顿的主因是「游戏串行发几十个不可缓存请求，往返时间逐次累加」，
不是代理慢，也不是某一次特别慢。**

决定性证据 —— 统计每一次"刷新"（用请求间隔 >3s 切分）：

| 刷新时刻 | 请求数 | 墙钟耗时 | 各请求耗时之和 | 最慢单条 |
|---|---|---|---|---|
| 17:46:35 | **109** | **36.3 s** | **38.2 s** | 3134 ms |
| 17:52:33 | 58 | 15.9 s | 17.2 s | 4548 ms |
| 17:55:21 | 21 | 13.3 s | 4.2 s | 380 ms |

**墙钟 ≈ 各请求耗时之和**，说明游戏是**串行**发的（一个接一个，不重叠）。
109 个请求 × 平均 350ms ≈ 38 秒。这就是"卡"的全部来源：**几十次往返的累加**。

分环节看（266 条采样）：

| 环节 | 实测 | 说明 |
|---|---|---|
| 代理本地处理 | ≈1ms | HIT 命中 `cache=0~1`，**代理自身不是瓶颈** |
| 查索引 / 落盘 | p50 2ms / 3ms | 已经最优 |
| 复用连接的上游往返 | p50 161ms / p90 514ms | 主要成本 |
| 新建连接的上游往返 | p50 345–921ms | **是复用的 3–8 倍** |
| 不可缓存的动态接口 | 166 个请求 | 战斗/副本接口，必须实时取 |

**裸链路实测（绕过代理直连 0dcloud → 日服，12 次连续）**：

```
CONNECT : 0-2 ms      ← 本地环节完美
TLS     : 110-128 ms  ← 稳定
首字节  : 107-166 ms  ← 稳定
总计    : p50 229ms / p90 278ms / max 565ms   ← 12 次里只有 1 次抖动
```

**链路本身很稳。** 所以单次 200–300ms 是到日服的固有成本，代理和节点都消不掉。

三条具体规律：

1. **新建连接 vs 复用连接差 3–8 倍**。同一台主机上，
   `connect.mobage.jp` 复用 p50=134ms、新建 p50=921ms；
   `prd-game-...akamaized.net` 复用 p50=138ms、新建 p50=749ms。
2. **慢请求不是"并发压垮自己"**。慢组出现时前后 1.5 秒的请求数是 14.5，
   快组是 10.9 —— **差距不大**。所以不是自身并发问题。
3. **个别聚合接口服务端确实慢**。实例：
   ```
   17:52:19.592 /party/deck/182  | conn=110 up=9065 total=9065 newconn
   17:52:20.222 /deckcombination/deck_combination_list/18 | up=609 total=609 reuse
   ```
   同一批（`_=` 时间戳只差 1ms）、同一主机，一个 9 秒一个 609ms。
   而那 9 秒内代理侧**没有任何其它活动**（无重试、无并发、无错误）→
   **是游戏服务端对这个聚合接口响应慢**（要汇总整队数据），代理只能干等。

> **结论**：卡的来源是 40–109 次串行往返的累加（每次 200–300ms），
> 而这些请求全是不可缓存的动态接口。代理能做的只有：
> **让素材走缓存（已做）、让连接尽量复用（已做）**。
> 想更快只能降低单次 RTT —— 换更近/更优的节点。

### 怎么自己复查

一条命令出全部结论：

```bash
node tools/latency.cjs          # 分析最近一次代理启动之后的请求
node tools/latency.cjs 500      # 只看最后 500 条
```

它会打印：各阶段 p50/p90/p99/max、新建 vs 复用的对比、按主机分组的时延、
最慢 15 条，以及**聚集性检验**——用来区分"是自己并发太多"还是"上游那个瞬间变慢"。

**判读口诀**：

- `conn` 高、`up` 不高 → **建连慢**，是出口节点握手的问题
- `conn` 正常、`up` 高 → **发出去等响应慢**，是上游服务器或出口排队的问题
- 慢请求和快请求的并发环境差不多 → **代理侧改不了**，只能换节点
- 慢请求明显扎堆在请求多的时刻 → 可以考虑压低并发

## 两类"卡"要分开看

实测后发现，"卡"其实有两种，处理方式完全不同：

**第一类：代理能优化的** —— 连接复用。

同一个请求，走复用连接和走新建连接差 3–8 倍：

| 主机 | 复用 p50 | 新建 p50 |
|---|---|---|
| `connect.mobage.jp` | 134 ms | 921 ms |
| `prd-game-...akamaized.net` | 138 ms | 749 ms |
| `game.granbluefantasy.jp` | 258 ms | 497 ms |

所以已经做的优化：`keepAlive: true`、`keepAliveMsecs: 15s`、
`maxFreeSockets` 提到 32、把素材 CDN 和 `connect.mobage.jp` 加进
`keepWarmHosts` 保温（每 20 秒打一次极小的请求，让连接一直热着）。

**第二类：代理改不了的** —— 必须实时请求的动态接口。

这类请求的量才是主因。一次刷新里 **109 个请求里有 166 个是透传**
（`/rest/`、`/party/`、带 Set-Cookie 的页面），它们**不能缓存**：

- 战斗结果 `/rest/multiraid/ability_result.json`
- 队伍数据 `/party/deck/182`
- 页面骨架 `/multiraid/content/index/...`（带 Set-Cookie，内容是账号状态）

游戏**串行**地一条条请求它们，每条 200–300ms，几十条就是十几秒。
代理在这里能做的只有"别再加额外开销"，而代理的开销已经是 1ms 级。

> **一句话**：缓存的素材（图片/音频）本来就不阻塞界面；
> 真正阻塞界面的动态接口，恰恰是不能缓存的。所以"再加缓存"救不了这个卡。

## 时延基准测试

```bash
node tools/bench.mjs 12          # 经代理测，每项 12 次
node tools/bench.mjs 12 direct   # 绕过代理做对照
```

输出每项的 min/中位/p90/max/标准差/抖动，用来对比"改前改后是否更快更稳"。

## 主要参数（config.json）

| 参数 | 说明 |
|---|---|
| `cacheDir` | 缓存位置，当前 `D:/gbf-cache`，可填任意绝对路径 |
| `maxCacheGB` | 缓存上限，默认 20 GB，超了淘汰最久没用的 |
| `verifyIntegrity` | 默认 `false`。开启后命中时按 `md5` 校验（对照 `.ext.md5`），能发现磁盘损坏，但会明显拖慢读缓存 |
| `expireMode` | `immortal` = 永久缓存；改成 `ttl` 则按服务器 TTL |
| `revalidateAfterSeconds` | 默认 0（不校验）；设成 86400 就是"先给本地内容，后台再校验一次" |
| `logMaxMB` | 日志超过这个大小就轮转成 `proxy.log.1`，默认 32 MB |
| `apiDumpPatterns` | 接口抓取白名单，**平时留空**。填了会把匹配的响应同步写到 `logs/api-dump/`，很拖速度 |
| `upstream` | 出口设置，见上文 |
| `blockHostPatterns` | 秒失败的域名，可按需增减 |
| `cacheHostFallback` | 回退主机目录（默认主素材 CDN）：本机 host 目录未命中时再查这里，用于导入 ACGPower 缓存包 |
| `overrideEnable` | 默认 `true`。关掉就不查 `_ap` 魔改文件 |
| `optionsPreflightEnable` / `optionsPreflightMaxAge` | 素材主机 + 静态扩展名的 OPTIONS 预检本地应答（默认开，max-age 604360） |
| `logMinLevel` | 日志最低级别 `DEBUG`/`INFO`/`WARN`/`ERROR`，默认 `DEBUG`（全都写） |
| `staleIfErrorSeconds` | 默认 0（关）。>0 时启用 RFC 5861 stale-if-error：上游 502/503/504、连接失败、本机解析不到时，用过期但完好的旧副本顶一次 |
| `retryOn5xx` / `retry5xxDelayMs` | 默认 `true` / 150 ms。可缓存目标（GET/HEAD）遇到 502/503/504 换连接重试一次；动态接口的 5xx 照旧原样透传 |
| `inactiveDays` / `idleSweepMinutes` / `idleSweepFiles` | 默认 0（关）。>0 时按"多久没被访问"分批淘汰（nginx `inactive` 语义）；进程刚启动有宽限，不会误删热对象 |
| `rescanCheckSeconds` / `rescanBatchFiles` | 默认 60 s。导入工具会放一个 `.gbf-rescan-request` 哨兵，代理定期在后台分批把新对象补进索引（不用重启，也不用等第一次刷新） |

## 源码结构

```
src/main.js          主程序（含一键启动逻辑）
src/cache.js      磁盘缓存 PathCache（路径镜像 + .ext + LRU 淘汰 + 魔改查找 + 完整性校验）
src/policy.js     缓存策略（主机白名单 + 内容类型判定 + URL→磁盘路径映射）
src/certs.js      按域名签发证书
src/upstream.js   出口（http / socks5 上游，自动探测）
tools/            证书（install-ca / setup-ca / uninstall-ca）、图标（make-icon）、打包（build-exe + bundle）
                  + 缓存迁移与导入（migrate.mjs / import.mjs）
                  + 太郎素材域名补丁（patch.ps1）
build/            打包中间产物
tools/         开发用的测试脚本（都用临时目录，不碰 D:/gbf-cache 和真实 config.json）
  unit.cjs       离线验证 PathCache：路径镜像 / .ext 字段 / LRU 水位 / 重启恢复 /
                           截断与全零容错 / 魔改不进索引 / 空目录清理 / 落盘判定与路径映射
  e2e.cjs   起本地 mock 源站，端到端验证计划里的 21 条用例
                           （MISS→HIT、单编码桶、CE 回放、魔改、OPTIONS、未入库、全零、
                             版本 query、主机回退、重启恢复、--clear-cache…）
                           加 TARGET=exe 可直接测打包出来的 exe
  migrate.cjs 迁移 / 导入工具的离线自测（含别名主机改写与幂等）
  micro.cjs      量化启动建索引与命中路径的额外 stat 开销（默认 1 万对象）
  bench.mjs        端到端时延基准（min/p50/p90/max/sd），加 direct 做直连对照
  latency.cjs      从 proxy.log 做卡顿归因（各阶段/各主机/最慢请求/聚集性检验）
  disk.mjs          缓存层读写吞吐
  throughput.mjs          代理转发吞吐
  browser.mjs            端到端连通性自检
  cdp.mjs            通过 CDP 观察浏览器侧实际请求
  probe.cjs         快速确认日志格式（临时目录起代理发几个请求）
```

## 改了源码之后一定要重新打包

`Grancache.exe` 是 Node SEA 打包出来的，跑的是内联后的 `build/bundle.js`。
**只改 `src/main.js` / `lib/*.js` 而不重新打包，双击运行的 exe 里还是旧代码。**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

注意两点：

- 打包用的是**系统 node**（`C:\Program Files\nodejs\node.exe`）。换版本会引入行为差异。
- 打包要覆盖 `Grancache.exe`，**先 `--stop` 停掉正在跑的代理**，否则文件被占用会失败。

判断"新代码到底进没进 exe"：新版日志每行末尾会带 `| conn=... up=... total=...`，
旧版没有。也可以看 `/stats` 有没有 `latency` 段。



## 更新记录（2026-09-14）

### 项目瘦身（2026-09-14）

### 图形控制面板 + 一个 pid 文件缺陷修复（2026-09-14）

### 控制面板升级为独立 exe（2026-09-14）

- 面板从 PowerShell 脚本改成 **`Grancache.exe`**（应用窗口 + Ant Design 界面），界面产物内联在 exe 里；
- 「一键启动（缓存 + Chrome + 游戏）」与「只开关缓存」都在面板上，另有清缓存/统计页/日志/实时状态；
- 旧的 `启动缓存面板.cmd` 与 `tools\panel\gbf-panel.ps1` 已移入 `_trash-20260914\`（新 exe 已取代）；
- 控制服务只监听 127.0.0.1，写操作要求一次性令牌（跨站网页调不动）。

- 新增 `启动缓存面板.cmd` + `tools\panel\gbf-panel.ps1`：深色面板，按钮式启动/停止/重启缓存、清空缓存、打开游戏、看统计页与日志；
- **修掉一个真实缺陷**：第二个实例在端口被占时会绑定失败退出，而它的退出处理器原来会**无条件删除 pid 文件**，
  把正在跑的那个实例的记录也抹掉 → `--stop` 与面板"停止"都失效。现在 `removePidFile()` 只删**属于自己**的 pid；
- 这个修复要重打包 exe 才会进成品（`build.ps1` 会先停掉正在跑的代理，所以等你不玩的时候再打包）。

- 删掉与主程序**字节相同**的重复 exe、`build\` 里的中间 exe、`.backup-acg` 里重复的 exe 备份、两个空目录 → 直接释放约 **440 MB**；
- 历史备份 `.backup-orig\`、一次性诊断脚本（`tools\_*.cjs`）、logs 里的一次性 dump、以及已被 exe 命令行取代的
  `tools\clear-cache.ps1` / `stop-proxy.ps1` / `start-proxy-silent.ps1` → 移到 `_trash-20260914\`（约 460 MB，**可搬回**），
  确认没问题后删掉这个目录即可彻底释放；
- 入口只剩 **`Grancache.exe`**（双击即一键开始；`--serve` / `--daemon` / `--stop` / `--clear-cache` / `--help` 都在它里面）。
  回滚备份 `.backup-acg\` 保留（改造前源码 + 每份唯一 exe 各一个）。

### 存储与命中（照 ACGPower 的路径镜像方案重做）

- 缓存从 `objects/<2位>/<sha256>.{data,json}` 改为 **`<cacheDir>/<scheme>/<host>/<url 路径>` + 同名 `.ext`**：
  目录可读、可手动整理、可直接导入 ACGPower 的缓存包（`tools/import.mjs`）；
  老缓存用 `tools/migrate.mjs` 一次性搬过去（**不删**旧 `objects`，确认后再手动删）。
- 魔改层：`<原名>_ap.<后缀>` 存在就无条件优先返回；魔改文件不参与 LRU、不计容量、`--clear-cache` 也会保留。
- 素材主机的 `OPTIONS` 预检本地直接答（收窄到"素材主机 + 静态扩展名"，动态接口的预检照旧回源）。
- 编码不再分三桶，只存一份（`.ext.ce` 记录 gzip 与否，命中前比对客户端能力）；
  入库要过完整性校验（长度一致 / 非全零 / 不超上限），命中要过一致性校验（长度 / 全零 / 过期）。
- 日志每行带级别（`DEBUG/INFO/WARN/ERROR`，可用 `logMinLevel` 过滤），查询串里的 `uid/token/...` 值一律掩码成 `***`。

### 上游抖动与容量

### 太郎插件（解包扩展）的素材域名

- 太郎把素材基址**硬编码**成 `https://prd-game-a1-granbluefantasy.akamaized.net/assets/img`（另有 `a5`），
  这些老域名在 DNS 里已经不存在：代理在跑时靠 `hostAliases` 改写到真实域名救回来，**代理一停图片就全挂**。
- 已把扩展源码里 14 处死域名改成真实域名 `prd-game-a-granbluefantasy.akamaized.net`
  （8 个 `.js` + 9 个 `.map`，原文件备份为 `*.orig-20260914`），**改完要在 chrome://extensions 点一次“重新加载”**。
- 下次太郎更新后（补丁会被覆盖）重跑：`powershell -ExecutionPolicy Bypass -File scripts\patch.ps1`
  （加 `-Dry` 只预览）。
- 兜底：即便死域名又回来了，代理也会给这些素材**浏览器侧 7 天缓存**（`aliasBrowserMaxAgeSeconds`，回源那次也改写），
  所以代理停掉后，已经看过的图片仍能显示。

- 可缓存目标遇到 502/503/504 会**换连接重试一次**（`retryOn5xx`，动态接口不受影响）。
- 打开 `staleIfErrorSeconds` 后，上游失败时可拿"过期但完好"的旧副本顶一次（RFC 5861）：
  响应带 `Age` 与 `X-GBF-Cache: STALE`、`cache-control: no-cache`；**损坏对象永不被顶**。
- 打开 `inactiveDays` 后按"多久没被访问"分批淘汰（nginx `inactive` 语义），进程刚启动有宽限。
- 导入缓存包后放一个 `.gbf-rescan-request` 哨兵，代理会在后台分批把新对象补进索引（不用重启）。

### 自检与修复（2026-09-14 第二轮）

- **已重打包并迁移完毕**（2026-09-14）：
  `Grancache.exe` / `一键开始玩.exe` / `Grancache.exe` 三个入口都是新构建（92,236,800 字节）；
  旧的 `D:\gbf-cache\objects` 已迁移到新布局（1473 个对象 / 35.3 MB，91 个重复分桶跳过），旧目录保留可回滚。
- 启动扫描现在会写进 `proxy.log`：`[cache] 载入已有缓存 1473 个对象 / 35.3 MB（耗时 119 ms）`。
- 打包不再需要管理员权限：项目文件之前带着 High 完整性标签，已统一降回 Medium
  （这也是"覆盖 exe 被拒绝"的原因；旧 exe 备份在 `.backup-acg\*.before-*`）。

- 新增 `tools/verify.cjs`：打包前离线自检（模块内联是否齐全、产物语法、关键符号、`node bundle.js --help` 实跑）。
- `--stop` 改用**实例自证**（问统计端口的 `pid`）确认归属，不再只靠 `tasklist`；`pid` 文件改为**监听成功后**才写，
  避免"起不来还留下一个指向死进程的 pid"。
- `tools/disk.mjs` 不再写死旧布局；`tools/probe.cjs` 改用系统临时目录（不再往 `.backup-orig` 写）。

## 更新记录（2026-09-13）

**入口改名为 `一键开始玩.exe`**（原来那个 `Grancache.exe` 被系统锁住无法覆盖，
留着不影响使用，重启电脑后可以手动删掉）。

### 新增：实时请求流水

打开 <http://127.0.0.1:18081/> 就能看到最近 200 条请求，每 2 秒刷新，
相当于把浏览器的 F12 Network 面板搬到了网页上：

| 标记 | 含义 |
|---|---|
| HIT | 本地缓存命中，**没走网络** |
| MISS | 走网络下载，同时已存进缓存 |
| BYPASS | 动态接口（/rest/ 那些），按设计不缓存 |
| TUNNEL | WebSocket 隧道（连队聊天用） |

想核对"缓存到底有没有生效"，就盯着这个页面刷新一次游戏：
素材应该大量显示 HIT，只有主页和 API 是 BYPASS。

`/log` 是同样的数据（JSON 格式）。

### 为什么统计里的"命中率"可能很低

因为 Chrome 自己有磁盘缓存：重复的素材它直接本地拿了，根本不会来问代理。
所以代理看到的命中数少是正常的——这时候最快的是浏览器自己那份缓存。

### 代理不在浏览器里

缓存代理是靠**启动参数**挂到 Chrome 上的（PAC 分流）。
Codex 自带浏览器、以及别的浏览器，都不走它，也就没有加速。
要享受缓存，就用 `一键开始玩.exe` 打开的那个 Chrome。
