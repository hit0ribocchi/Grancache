# GBF 缓存代理：路径镜像 + `.ext` + 魔改层 —— 计划与实施报告

> 本文档是这轮改造的唯一依据，按 **阶段 1（计划）→ 阶段 2（实现）→ 阶段 3（校验）** 顺序编排。
> 旧版文档里的「review 发现清单 / 逐条核实表」已**整体删除**：那些问题都已经落进下面的设计里，
> 留在计划里只会和现状混淆。现在只保留**尚未解决**的风险（§1.6 / §4）。

---

## 阶段 1：规范计划

### 1.1 问题理解

**输入**

| 来源 | 形态 |
|---|---|
| 浏览器（PAC / 系统代理） | HTTP 请求（CONNECT 隧道 → 本地 CA 现场签发证书 → MITM 后的明文请求） |
| 上游（0dcloud 本机端口 → 节点 → 日服） | 响应头 + 响应体（可能是 gzip，也可能 chunked） |
| 离线数据 | 旧 `objects/<2位前缀>/<sha256>.{data,json}` 缓存；ACGPower 的 `cache/gbf/**` 缓存包 |
| 配置 | `config.json`（缓存目录、上限、策略开关、魔改开关等） |
| 用户操作 | 双击一键开始、`--serve/--daemon/--stop/--clear-cache/--help`、往缓存目录丢 `_ap` 魔改文件 |

**输出**

| 输出 | 形态 |
|---|---|
| 命中响应 | 本地素材字节 + `.ext` 里回放的原响应头 + `X-GBF-Cache: HIT / HIT-304 / OVERRIDE / OPTIONS-HIT` |
| 回源响应 | 原样透传（含编码），可入库时写盘，`X-GBF-Cache: MISS`；不入库时日志 `MISS-NOSTORE` |
| 磁盘缓存 | `<cacheDir>/<scheme>/<host>/<url 路径>` + 同名 `.ext`（JSON） |
| 诊断 | `runtime/logs/proxy.log`（每行带级别）、统计页 `http://127.0.0.1:18081/`、`/stats`、`/log` |
| 工具产物 | 迁移/导入后生成的新布局对象与 `.ext` |

**约束**

1. exe 走 Node SEA 单文件打包，**不引入任何第三方依赖**；
2. 动态接口（`/rest/`、`.json`、`.html`、带 `Set-Cookie`、`text/html`）绝不缓存，账号数据不能串；
3. 不改变请求语义：CORS 头按请求方 `Origin` 回写、带凭据的预检照常回源；
4. Windows 文件系统限制：非法字符、设备名、单段长度、MAX_PATH；
5. 热路径开销敏感：素材命中本来只要 ~1.4 ms，新增检查必须是常数级、且不做全量哈希（默认）；
6. 日志格式被既有脚本（`latency.cjs` / `audit.cjs`）依赖，改动必须向后兼容；
7. 浏览器自己那份缓存会挡住魔改 → 魔改响应必须让浏览器"每次回来问"。

**边界条件**

| 边界 | 处理 |
|---|---|
| URL 无 query | 只生成一个候选路径 |
| 只有 `_`/`t`/`uid` 这类跟踪参数 | 直接剥掉，不产生目录层（对所有可缓存主机生效） |
| 带版本参数（`?v=2`） | 生成 `<路径>/__q_v=2/<文件名>` + 无 query 回退两条候选 |
| 响应体 0 字节 | 不入库（原因 `empty`） |
| chunked（无 `content-length`） | 放行入库，用实际字节数记账（ACGPower 是直接不存，我们放宽） |
| 超过 `maxObjectMB` | 中途停止缓冲、不入库（原因 `too-big`） |
| 跨盘移动（`EXDEV`） | 迁移工具降级为 copy + 删除源文件 |
| 同名不同 host（`/assets/...` 在多个 CDN 上都存在） | 路径里有 host 层，互不覆盖 |
| a1~a5 别名主机 | 请求期用 `hostAliases` 改写；迁移工具对旧 URL 做同样改写 |
| 导入的文件没有 `.ext` | 导入工具按扩展名补一份；代理**运行中按需接管**，不用重启 |
| 导入的文件没有 host 层 | `cacheHostFallback` 主机回退命中 |
| 魔改文件带 gzip（有 `ce=gzip` 的 `.ext`） | 回放 `content-encoding`，字节原样发出 |
| 魔改文件 mtime 异常 / `utimes` 失败 | try/catch 兜底，只影响 mtime 语义，不影响写入 |
| `cacheHostFallback` 目录不存在 | 候选路径查不到就是未命中，不报错 |

**异常情况**

| 异常 | 期望行为 |
|---|---|
| 上游连接半死（复用连接被掐断） | GET/HEAD 换新连接重试一次（`WARN RETRY-STALE`） |
| 上游响应被截断（声明长度 > 实收） | 不落盘；`ERROR UPSTREAM-STREAM-ERROR`；销毁下游响应（浏览器自然重试） |
| 上游 5xx / 非 200 | 不入库，按 `BYPASS` 透传 |
| 磁盘写入失败 | `ERROR STORE-ERROR`，不影响已经回给浏览器的响应 |
| `.ext` 损坏 / 磁盘对象被截断 / 全零 | 删除该对象并按未命中回源 |
| 缓存目录被清空而代理仍在跑 | 索引命中 → 读文件失败 → 删对象 → 按 MISS 重新入库 |
| 日志里可能出现账号线索 | 查询串中的 `uid/token/session/...` 值掩码为 `***`；Cookie / Authorization / 请求体从不记录 |

**目标（本轮已完成）**

- G1 存储改为「`<cacheDir>/<scheme>/<host>/<url 路径>` + `<文件>.ext`」，淘汰 sha256 objects 结构；
- G2 魔改覆盖层：`_ap` 后缀文件无条件优先命中；
- G3 素材主机的 OPTIONS 预检本地应答（收窄到"素材主机 + 静态扩展名"）；
- G4 写入完整性校验（长度一致 / 非全零 / 不超上限）+ 读取一致性校验（长度、全零、过期）；
- G5 编码桶由三桶（gzip/br/identity）简化为单一副本（编码记在 `.ext.ce`）；
- G6 保留 LRU 淘汰，索引键从 sha256 改为相对路径；
- G7 旧缓存迁移工具 + ACGPower 缓存包导入工具（含主机回退与运行中接管）；
- G8 离线单测 + 端到端测试全部改造并通过。

**非目标（明确不做）**

- ACGPower 的远程动态缓存（DRC）/ 远端 store —— 那是它的服务端能力；
- `/socket/uri/raid` 之类动态接口的内存缓存 —— 收益边际且违背"动态不缓存"原则；
- br 编码支持（素材 CDN 上的图片/音频本就不压缩）；
- 闲置淘汰（nginx `inactive`）与 `stale-if-error` —— 记为 M2 候选，本轮不动。

### 1.2 方案设计

**模块划分**

| 文件 | 职责 | 本轮变化 |
|---|---|---|
| `src/policy.js` | 判定层：bypass / 素材主机 / 可否入库 / 浏览器缓存策略；**新增** URL → 磁盘候选路径映射与扩展名→Content-Type 表 | `cachePaths()`、`sanitizeSegment()`、`contentTypeForExtension()`、`CONTENT_TYPES`、`normalizeCacheUrl()` 语义放宽 |
| `src/cache.js` | `PathCache`：索引与 LRU、原子写、命中校验、魔改查找、空目录清理、运行中接管 | 整档重写（原 `DiskCache` 的 sha256 objects 布局删除） |
| `src/main.js` | 编排层：OPTIONS → 魔改 → 缓存 → 回源；日志分级；CLI | 编码单桶、`storeIntent`/`MISS-NOSTORE`、`respondOverride`、`clearMode` 改造、日志级别与脱敏 |
| `tools/migrate.mjs` | 旧 objects → 新布局 | 新增 |
| `tools/import.mjs` | ACGPower 包 → 新布局（补 `.ext`） | 新增 |
| `tools/test-*.cjs` | 离线单测 / 端到端 | 重写并扩充 |
| `tools/latency.cjs`、`audit.cjs` | 日志分析 | 兼容新增的级别列 |

**数据结构**

```js
// PathCache
index: Map<relPath, meta>      // 插入顺序 = LRU 顺序（命中/写入先 delete 再 set）
_pendingWrites: Map<relPath, Promise>   // 同一对象的并发写入串行化
totalBytes / evictions / integrityErrors / prunedDirs / adopted

// .ext（JSON，字段与 ACGPower 同名同义 + 本项目自用字段）
{ v:1, url, LastModified, ETag, at, md5, ce, ct,
  size, storedAt, lastAccess, expiresAt, revalidateAt, headers }

// 候选路径（顺序 = 优先级）
[ '<scheme>/<host>/<路径>[/__q_<参数>]/<文件名>',
  '<scheme>/<host>/<路径>/<文件名>',                 // 版本 query 回退
  '<scheme>/<cacheHostFallback>/<...>', ... ]        // 缓存包主机回退
```

**关键流程**

```
请求 → (OPTIONS? 素材主机+静态扩展名 → 本地 200 OPTIONS-HIT，结束)
     → bypass 判定（excludePatterns / passthroughHosts / Range / 非 GET·HEAD）
     → 候选路径 = policy.cachePaths()
     → 魔改查找：<文件名>_ap.<ext> 存在？（按候选顺序 stat，含主机回退）
           命中 → 200 + ct/ce 三级取值 + cache-control:no-cache + ETag:"ap-mtime-size"
                 带同一 ETag 的请求 → 304
     → 索引命中 → 读文件 → 校验（长度=size、非全零、未过期、可选 md5）
           任一条不过 → 删对象 → 当未命中
           通过 → 回放 .ext.headers（**含 content-encoding**）+ 改写 cache-control
                 + If-None-Match → 304；revalidateAt 到期 → 后台条件请求
     → 未命中 → 请求合单 → 回源 → 落盘判定（长度一致 + 非全零 + 不超上限）
           通过 → tmp+rename 原子写 + 写 .ext + mtime=Last-Modified + 入索引/LRU
           不过 → 只转发，日志 WARN MISS-NOSTORE（原因）
```

**复杂度分析**

| 操作 | 复杂度 | 说明 |
|---|---|---|
| 命中（读） | O(候选数) 次 Map 查 + 1 次 `stat`/候选（魔改）+ 1 次读盘 + O(n) 全零早退 | n 为对象大小，真实素材第一个字节即退出；`stat` 命中页表缓存 |
| 写入 | O(1) + 3 次 IO（tmp 写、rename、`.ext` 写）+ 可选 `utimes` | 落盘在响应之后异步进行，不阻塞浏览器 |
| 淘汰 | O(k)，k = 本轮被淘汰对象数 | Map 插入序即 LRU，无需排序；删除走 32 路并发 |
| 启动建索引 | O(N) 文件遍历 + 64 并发读 `.ext` | 与旧实现同量级（都是"每对象一个小 JSON"） |
| 内存 | O(N) 元数据 | 每对象几百字节；20 GB 上限下约几十万对象 |

### 1.3 实施步骤

| 步骤 | 做什么 | 为什么 | 涉及函数 / 文件 | 状态 |
|---|---|---|---|---|
| S1 | 备份 | 无 git 仓库，改坏了要能整体回滚 | `.backup-acg/`（`src/main.js` / `lib/` / `tools/` / `config.json` / `README.md`，26 个文件） | ✅ |
| S2 | 重写缓存层为 `PathCache` | 路径镜像 + `.ext` + 魔改查找 + `_ap` 排除 + 空目录清理 + 运行中接管 | `src/cache.js`：`PathCache.init/_loadIndex/get/_adopt/overrideFor/set/_write/evict/_remove/_pruneEmptyDirs/stats`、`shouldStoreBody`、`isAllZero`、`overridePathFor` | ✅ |
| S3 | URL → 磁盘路径映射 | 可读目录、query 目录化、主机回退、Windows 路径安全 | `src/policy.js`：`cachePaths`、`sanitizeSegment`、`shortenFullPath`、`splitExtension`、`contentTypeForExtension`、`CONTENT_TYPES`；`normalizeCacheUrl` 放宽 | ✅ |
| S4 | proxy 接线 | 单编码桶、OPTIONS 拦截、魔改优先、入库校验、`MISS-NOSTORE`、`clearMode`、日志级别与脱敏 | `src/main.js`：`handleRequest`、`respondFromCache`、`respondOverride`、`missThenForward`、`forward`、`clearMode`、`helpMode`、`log` | ✅ |
| S5 | 测试改造 | 计划的 21 条 E2E 用例 + 缓存层单测 | `tools/e2e.cjs`、`tools/unit.cjs` | ✅ |
| S6 | 工具 | 老缓存搬家、ACGPower 包导入 | `tools/migrate.mjs`、`tools/import.mjs`、`tools/migrate.cjs` | ✅ |
| S7 | 文档与配置 | 使用方式写清楚，新参数落进 config | `README.md`、`config.json`（新增 6 个键） | ✅ |
| S8 | 打包 exe + 实机验证 | exe 跑的是打包进去的 `build/bundle.js`，不重打包等于没改 | `tools/build.ps1`（**必须先 `--stop`，需用户同意时机**）、§1.5 的实机清单 | ⏳ 待用户同意 |

### 1.4 日志设计

级别写在时间戳之后的第二个字段（`<ISO时间> <LEVEL> <事件…>`），可直接 `findstr /C:" WARN "` 过滤；
`config.logMinLevel` 控制最低级别，默认 `DEBUG`（保持"全都写"的既有行为）。

| 日志级别 | 事件 | 触发位置 | 记录字段 | 格式示例 | 输出目标 | 用途 |
|---|---|---|---|---|---|---|
| INFO | 启动/监听/上游出口 | `main()` | 端口、出口类型与端口 | `… INFO [start] 代理监听 http://127.0.0.1:18080` | `runtime/logs/proxy.log` + 控制台 | 确认这次运行用的是哪个出口、哪个端口 |
| INFO | 索引载入 | `PathCache._loadIndex()` | 对象数、总字节 | `… INFO [cache] 载入已有缓存 15234 个对象 / 1832.4 MB` | 同上 | 重启后确认索引重建成功；对比启动耗时 |
| INFO | 缓存命中 | `respondFromCache()` | 大小、host、path、`cache=`/`total=`、在途数 | `… INFO HIT 12.0KB prd-game-a-….net /assets/img/a.png \| cache=1 total=2 ^0` | 同上 | 命中率与命中延迟；`X-GBF-Cache: HIT` 的日志侧对照 |
| INFO | 条件请求命中 | `respondFromCache()` / `respondOverride()` | host、path、`(魔改)` 标记 | `… INFO HIT-304 game.granbluefantasy.jp /assets/img/a.png (魔改) \| cache=0 total=0 ^0` | 同上 | 确认 304 生效（魔改不重传字节） |
| INFO | 落盘成功 | `forward()` 的 body 结束回调 | 大小、入库原因、ttl、`store=` 耗时 | `… INFO MISS->STORE 12.0KB (asset-host, ttl=0s) 127.0.0.1 /assets/a.png \| up=4 total=7 store=5` | 同上 | 首次下载成本；`store` 是否拖慢事件循环 |
| WARN | 回源未入库 | 同上（校验不过时） | 大小、原因（`empty`/`all-zero`/`content-length-mismatch`/`too-big`） | `… WARN MISS-NOSTORE 0B (empty) 127.0.0.1 /assets/empty.png` | 同上 | 定位"为什么这个素材老是回源" |
| INFO | 魔改命中 | `respondOverride()` | 大小、host、path | `… INFO OVERRIDE 12B 127.0.0.1 /assets/ov.png \| cache=1 total=1 ^0` | 同上 | 确认魔改文件生效（配 `X-GBF-Cache: OVERRIDE`） |
| INFO | OPTIONS 预检本地应答 | `handleRequest()` 的 OPTIONS 分支 | host、path | `… INFO OPTIONS-HIT 127.0.0.1 /assets/opt.png \| total=1` | 同上 | 确认预检没回源（省一趟 RTT） |
| DEBUG | 透传（动态接口） | `forward()` 的非入库分支 | 状态码、大小、原因 | `… DEBUG BYPASS 200 1.2KB (excluded) game.granbluefantasy.jp /rest/x` | 同上 | 高频噪声，排查时再临时看 |
| WARN | 上游连接半死重试 | `send()` 的 error 分支 | 第几次失败、错误码、host、path | `… WARN RETRY-STALE (第 1 次失败：ECONNRESET) 127.0.0.1 /assets/flaky.png` | 同上 | 连接池里有死连接时能看见，但不再让用户感知 |
| ERROR | 上游响应截断 | `upRes.on('error')` | 错误消息、host、path | `… ERROR UPSTREAM-STREAM-ERROR aborted 127.0.0.1 /trunc.png` | 同上 | 半截响应既不入库也会通知下游，便于归因 |
| ERROR | 上游请求失败 | `upReq.on('error')` | 完整 URL、错误消息、阶段耗时 | `… ERROR UPSTREAM-ERROR https://… :: socket hang up` | 同上 | 出口/节点问题定位 |
| ERROR | 落盘失败 | `cache.set()` 的 catch | 错误消息 | `… ERROR STORE-ERROR EPERM: operation not permitted` | 同上 | 磁盘权限/空间问题 |
| WARN | 域名解析失败快失败 | `noteHostFailure()` | host、拉黑时长 | `… WARN BADHOST x.example 本机解析不到，30 秒内直接跳过` | 同上 | 区分"本机 DNS 问题"与"上游问题" |
| DEBUG | WebSocket 隧道 | `proxyServer.on('connect')` | host:port、建连耗时 | `… DEBUG TUNNEL ws.game.granbluefantasy.jp:11240 \| conn=142` | 同上 | 连队聊天/协同链路的健康度 |
| INFO | 淘汰 | `PathCache.evict()` | 本轮数量/字节、当前用量、累计淘汰 | `… INFO [cache] 触发淘汰：本轮移除 812 个对象 / 1024.0 MB …` | 同上 | 确认 20 GB 上限在生效、水位是否合理 |
| INFO | 周期统计 | `main()` 的定时器 | 请求/命中/未命中/透传/流量/磁盘占用 | `… INFO [stats] 请求=… 命中=… 磁盘缓存=1832.4MB/15234个` | 同上 | 长跑趋势；对照统计页 |
| INFO | 周期时延 | `main()` 的定时器 | 各阶段 p50/p90/max、复用/新建/重试/在途 | `… INFO [latency] 单位ms 中位/p90/最大 total:171/508/1328 …` | 同上 | 卡顿归因主入口（配合 `latency.cjs`） |
| INFO（stdout） | 清空缓存 | `clearMode()` | 文件数、总字节 | `已清空缓存：15234 个文件 / 1832.4 MB` | 控制台 | 确认清的是真数据（旧版会清错目录） |
| INFO（stdout） | 迁移 / 导入结果 | `tools/*.mjs` | 成功/跳过/缺失数量、字节数、补写的 `.ext` 数 | `迁移完成：成功 15234 个 / 1832.4 MB，跳过 12 个…` | 控制台 | 迁移/导入的可核对凭据 |

**不记录的内容**：Cookie、`Authorization`、`Set-Cookie`、请求/响应体、证书私钥；
查询串里的 `uid/token/session/sid/password/auth/key/ticket/code/sig/signature` 值一律掩码成 `***`
（`maskSensitive()` 在 `log()` 内统一处理，统计页的 `/log` 流水同样脱敏）。

**日志可被后续校验引用**：§1.5 的每条用例都指定了一个"日志检查点"，阶段 3 的校验报告直接引用这些字符串。

### 1.5 自我校验方案

| 用例类型 | 输入 | 预期输出 | 日志检查点 | 通过标准 |
|---|---|---|---|---|
| 正常 · 首次下载 | GET `/assets/a.png`（12 KB，max-age=31536000） | `X-GBF-Cache: MISS`，200，字节一致 | `INFO MISS->STORE 12.0KB (asset-host, ttl=0s)` | 状态码 200 且 body == 源站字节 |
| 正常 · 二次命中 | 同 URL 再请求 | `X-GBF-Cache: HIT` + `x-gbf-cache-age`，body 一致 | `INFO HIT 12.0KB` | 命中且源站计数不增加（未回源） |
| 正常 · 路径镜像 | 同上 | 文件在 `<cacheDir>/<scheme>/<host>/assets/a.png` + `.ext` | `[cache] 载入已有缓存`（重启后） | 路径存在、无 `objects/` 残留 |
| 正常 · 元数据 | 同上 | `.ext` 含 `v/url/ct/size/at/headers`，`ETag`/`LastModified` 与 ACGPower 同名 | — | 字段齐全且 `size` 等于文件字节数 |
| 正常 · 单编码桶 | 第 1 次 `Accept-Encoding: gzip`，第 2 次 `gzip, deflate, br, zstd` | 两次命中同一份，第 2 次 `HIT` | `INFO HIT … /assets/gz.png` | 客户端 AE 串不同不影响命中 |
| 正常 · CE 回放 | 命中 gzip 对象 | 响应带 `content-encoding: gzip`，字节 = gzip 原文 | `INFO HIT`（该 URL） | 头存在且 body 等于 gzip 字节 |
| 边界 · 不认 gzip 的客户端 | `Accept-Encoding: identity` 请求同一 URL | 不回放 gzip 体，向上游要 identity 并回放原文 | `INFO MISS->STORE`（identity） | 响应无 `content-encoding`，body == 明文 |
| 正常 · 动态接口 | GET `/rest/user/data` ×2 | 都 `X-GBF-Cache: BYPASS`，不落盘 | `DEBUG BYPASS 200 … (excluded)` | 两次都不缓存、磁盘无对应文件 |
| 异常 · 上游掐断 | 首次 `/assets/flaky.png` 源站直接 destroy | 仍然 200 且随后可命中 | `WARN RETRY-STALE (第 1 次失败：ECONNRESET)` | 不返回 502，重试后入库成功 |
| 正常 · 魔改命中 | 放 `ov_ap.png` 后请求 `/assets/ov.png` | `OVERRIDE` + 魔改字节 + `content-type: image/png` | `INFO OVERRIDE 12B` | 返回内容 = 魔改文件字节 |
| 正常 · 魔改缓存策略 | 同上 | `cache-control: no-cache`，`etag: "ap-<mtime>-<size>"` | `INFO OVERRIDE` | 两个头都存在且 ETag 形如 `"ap-数字-数字"` |
| 正常 · 魔改 304 | 带上一响应 ETag 再请求 | 304 | `INFO HIT-304 … (魔改)` | 状态 304 且无响应体 |
| 边界 · 魔改 + gzip | `_ap` 文件 + `.ext` 里 `ce=gzip` | `OVERRIDE` + `content-encoding: gzip` + 原字节 | `INFO OVERRIDE` | 头回放且 body == gzip 原文 |
| 正常 · 魔改不被淘汰 | 大量写入触发 LRU | 魔改文件仍在原处、不计入对象数 | `[cache] 触发淘汰` 行不涉及 `_ap` | 文件存在且 `stats().objects` 不含它 |
| 正常 · 魔改总开关 | `overrideEnable: false` 后请求同一 URL | 不再返回 `OVERRIDE`，走普通缓存/回源 | 该请求不出现 `INFO OVERRIDE` | `X-GBF-Cache` 不是 `OVERRIDE`，且魔改文件仍在磁盘上 |
| 正常 · OPTIONS 预检 | OPTIONS 素材路径 | 200 + `OPTIONS-HIT` + `ACAO/ACAH/ACAM: *` + `max-age=604360` | `INFO OPTIONS-HIT` | 源站计数为 0（未回源） |
| 边界 · API 预检不接管 | OPTIONS `/rest/user/data` | 照常回源 | `DEBUG BYPASS`（该路径） | 源站计数增加 |
| 异常 · 半截响应 | 裸源站声明 4096 只发 1024 | 不落盘；下游拿到错误或不足量字节 | `ERROR UPSTREAM-STREAM-ERROR aborted` | 磁盘无该对象，且日志出现该字符串 |
| 异常 · 空响应 | 200 + 0 字节 | 不入库，仍 200 | `WARN MISS-NOSTORE 0B (empty)` | 磁盘无该对象，`missNoStore > 0` |
| 异常 · 全零对象 | 手工把缓存文件写成全 0 | 下次请求 `MISS` 回源并重写正确内容 | `INFO MISS->STORE`（该 URL） | 源站计数 +1，文件恢复为正确字节 |
| 边界 · 版本 query | `/assets/v.png?v=1`、`?v=2` | 两条各存各的、都能命中 | 两次 `INFO MISS->STORE` → 两次 `INFO HIT` | 两个 `__q_v=*` 目录都存在且都命中 |
| 边界 · 跟踪参数剥离 | 非白名单主机 `?t=1&uid=2` | 第二次 HIT，磁盘路径不含参数 | `INFO HIT … /assets/q.png?t=1&uid=2`（uid 值已掩码） | 落盘路径为 `<host>/assets/q.png` |
| 边界 · 主机回退 | 对象只在 `cacheHostFallback` 目录下 | HIT | `INFO HIT`（该 URL） | 命中且内容为回退目录里的字节 |
| 边界 · 版本 query 回退 | 只有无 query 的对象，请求带 `?v=9` | HIT | `INFO HIT`（该 URL） | 命中且内容一致 |
| 正常 · 重启恢复 | 重启代理后请求已缓存 URL | HIT，索引对象数与重启前一致 | `[cache] 载入已有缓存 N 个对象` | 命中 + 数量一致 |
| 正常 · 清缓存 | 运行中执行 `--clear-cache` | 缓存对象清空、**`_ap` 魔改文件保留**；随后请求 MISS 并重新入库 | `已清空缓存：…（保留魔改文件 N 个）` + `INFO MISS->STORE` | 无缓存对象残留、魔改文件还在、代理能继续写入 |
| 正常 · 新进程接管 | 重启后再请求磁盘上已有的对象 | 第一次请求即 HIT（索引按需接管） | `INFO HIT` | 状态为 HIT 且未回源 |
| 数据一致性 · 落盘判定 | 长度一致 / 不一致 / chunked / 全零 / 超限 / 空 / 非法长度 | 只有"一致 + 非全零 + 不超限"入库 | 对应 `MISS-NOSTORE` 原因 | 7 种输入的判定与预期一致 |
| 数据一致性 · LRU | 10×10 KB 写入、命中重排、再写触发淘汰 | 清到水位以下、最近访问的保留、最久未用的被删 | `[cache] 触发淘汰` | 字节数与保留/淘汰集合正确 |
| 数据一致性 · 空目录清理 | 删除深层最后一个对象 | 目录链被逐级清掉 | — | 删除后目录不存在 |
| 工具 · 迁移 | 旧 `objects` 2 个对象（含 a1 别名） | 落到新布局、生成 `.ext`、旧元信息清空、可重复执行 | 工具 stdout 统计 | 搬运数/字节数正确、二次执行为 0 |
| 工具 · 导入 | ACGPower 包（无 host 层、无 `.ext`） | 落到 `cacheHostFallback`，缺 `.ext` 的补上，已有的不覆盖 | 工具 stdout 统计 | 目标路径存在、`.ext` 字段正确 |

### 1.6 风险与降级策略

| 可能出错的地方 | 影响 | 降级 / 缓解 |
|---|---|---|
| 路径镜像启动扫描比 objects 慢（每个对象一个小 `.ext`） | 启动多花几秒 | 沿用 64 路并发读；实测对比启动日志；必要时改为按目录分片的惰性扫描（M2） |
| Windows 长路径 / 非法字符 / 设备名 | 个别对象写不进去 | `sanitizeSegment` + 整条路径 > 200 字符时压成哈希；写失败只记 `STORE-ERROR`，不影响响应 |
| 单副本编码后，个别客户端解码能力不符 | 该客户端回源 | 命中前比对 `content-encoding` 与客户端能力，不匹配就回源；永不发它解不开的字节 |
| 迁移工具搬坏旧缓存 | 旧缓存不可用 | **不删除**旧 `objects` 目录、`--dry` 可先预览；代码整体备份在 `.backup-acg/` |
| 导入的包结构与预期不同（有无 scheme 层、有无 `.ext`） | 导入后不命中 | 自动识别 `https/` 或裸目录；缺 `.ext` 自动补；仍不命中就查看日志与目录对照 |
| 新代码有 bug | 游戏加载异常 | 备份恢复源码；exe 打包前留档旧 exe；`--clear-cache` 一把重置（会保留魔改文件） |
| 浏览器自身缓存挡住魔改 | "魔改没生效" | 魔改响应 `no-cache` + ETag（持久解决）；README 明确要求首次 Ctrl+F5 |
| 计划本身有问题（实现中发现） | 方案与实现脱节 | 见 §2.2 / §3.3：本轮实现中发现 4 处计划缺口（空响应判定、导入后不被识别、`MISS-NOSTORE` 无法回头写、`--clear-cache` 会连带删掉魔改文件），均先改计划再改代码 |

---

## 阶段 2：按计划实现

### 2.1 落地清单

| 文件 | 变更 | 关键点 |
|---|---|---|
| `src/cache.js` | 整档重写为 `PathCache` | 路径镜像读写、`.ext`（ACGPower 同名字段）、LRU（`Map` 插入序）、`_pendingWrites` 串行化原子写、命中校验（长度/全零/过期/可选 md5）、魔改查找（进 `.ext`、不进索引）、`_pruneEmptyDirs` 空目录清理、`_adopt` 运行中接管、`shouldStoreBody` 纯函数 |
| `src/policy.js` | 新增映射层 | `cachePaths()`（scheme/host/路径 + `__q_` 目录 + 版本回退 + `cacheHostFallback` 回退）、`sanitizeSegment()`（非法字符/设备名/超长 → 追加短哈希且保留扩展名）、`contentTypeForExtension()`、`CONTENT_TYPES`（覆盖 `assetExtensions` 全集）、`normalizeCacheUrl()` 对所有可缓存目标剥参数 |
| `src/main.js` | 编排与日志 | 单编码桶（`clientAcceptsGzip` 决定上游 AE，命中前比对 `ce`）、OPTIONS 拦截（素材主机 + 静态扩展名）、魔改优先（`overrideEnable=false` 时连 `stat` 都不做）、`storeIntent`/`MISS-NOSTORE`（含 `empty`/`all-zero`/`content-length-mismatch`/`too-big`）、`respondOverride`（三级 ct/ce、`no-cache`+ETag、304）、`clearMode` 清整个 `cacheDir` 但**保留 `_ap` 魔改文件**、`log()` 分级 + 敏感参数掩码、`logMinLevel` 过滤 |
| `config.json` | 新增 6 个键 | `cacheHostFallback`、`queryDirPrefix`、`overrideEnable`、`optionsPreflightEnable`、`optionsPreflightMaxAge`、`logMinLevel` |
| `tools/e2e.cjs` | 重写 | 21 条用例（含 raw TCP 源站造半截响应、gzip 源站、planted 对象、重启、`--clear-cache`）+ 统计/日志断言 |
| `tools/unit.cjs` | 重写 | PathCache + policy + `shouldStoreBody` 共 40+ 断言 |
| `tools/migrate.cjs` | 新增 | 迁移/导入工具自测，12 条断言 |
| `tools/latency.cjs`、`audit.cjs` | 兼容 | 新增的级别列被剥离后再解析动词/主机（老日志仍可解析，已用真实 12189 行日志回归） |
| `tools/migrate.mjs`、`tools/import.mjs` | 新增 | 迁移（rename，EXDEV 降级 copy+rm，幂等）、导入（整棵复制 + 补 `.ext`，`--dry` 预览） |
| `tools/clear-cache.ps1` | 修正后于阶段 8 移除 | 旧脚本只删 `cache\objects`，当时改为一并清理新布局；但它指向的 `<项目>\cache` 不是真实缓存目录（真实是 `config.json` 的 `cacheDir`），已改为统一用 `--clear-cache` |
| `README.md` | 更新 | 目录结构与魔改用法、迁移/导入命令、参数表、源码结构与测试脚本说明 |

### 2.2 与计划的偏差（均为先改计划、再改代码）

1. **`empty` 与 `too-big` 混判**（实现中发现）：一次把 `chunks.length === 0` 当成"超限"，导致空响应被记成 `too-big`。改为用 `tooBig = !keepBuffering` 区分，空响应走 `empty`；E2E 用例 9 断言随之明确。
2. **导入的缓存包在运行中的代理里看不见**（计划缺口）：原计划只写"导入后建议刷新一次"，但索引只在启动时建立，手工放入/导入的文件不会被识别。补上 `PathCache._adopt()`：命中失败时按候选路径查磁盘（要求 `.ext` 存在且合法）并按需接管，导入后**不用重启**。E2E 用例 19/21 与工具自测覆盖。
3. **`MISS-NOSTORE` 无法作为响应头回写**：响应头在 body 收到之前就已发出，入库校验只能事后判定。计划里 §3.10 的语义保留，但**以日志字段为准**；统计页同步新增 `missNoStore` 计数。
4. **`--clear-cache` 会把魔改文件一起删掉**（实现中发现）：魔改文件就住在缓存目录里，按"清空 `cacheDir`"的写法会把用户手工放进去的东西删掉。改为清空时**跳过 `_ap` 文件**并在输出里报告保留数量；E2E 用例 14 增加"缓存对象清零 + 魔改文件保留"两条断言。
5. **`overrideEnable` 开关没接线**（实现中发现）：配置项读进来了但代码没判断。补上后 `overrideEnable=false` 时连魔改 `stat` 都不做；E2E 用例 7b 覆盖。

---

## 阶段 3：自我校验

### 3.1 执行方式与原始证据

| 命令 | 范围 | 结果 |
|---|---|---|
| `node test\unit.test.cjs` | PathCache / policy / 落盘判定（40+ 断言） | 全部通过（`全部通过`） |
| `node test\e2e.test.cjs` | 端到端 21 条用例（mock 源站 + 裸 TCP 源站 + 真实代理进程） | 全部通过（`全部通过`，含重启与 `--clear-cache`） |
| `node scripts\migrate.mjs` / `node test\migrate.test.cjs` | 迁移 / 导入工具 | 全部通过（12 条断言） |
| `node --test tests\cache-optimization.test.mjs` | policy 单元测试 | 11 项通过 / 0 失败 |
| `node tools/latency.cjs 200`、`node tools/audit.cjs` | 真实历史日志（12189 行，旧格式）回归 | 正常解析（7300 条请求记录，动词分布正常） |
| `node --check src/main.js` / `lib\*.js`、`JSON.parse(config.json)` | 语法与配置 | 全部通过 |

### 3.2 校验报告

| 用例 | 实际输出 | 日志观察 | 结果 | 失败原因 |
|---|---|---|---|---|
| 1 首次下载 | 200，`X-GBF-Cache: MISS`，body 12288 B 一致，源站计数 1 | `INFO MISS->STORE 12.0KB (asset-host, ttl=0s)` | 通过 | — |
| 1 二次命中 | `HIT` + `x-gbf-cache-age`，body 一致，源站计数仍为 1 | `INFO HIT 12.0KB … cache=1 total=2` | 通过 | — |
| 2 路径镜像 | `cache/http/127.0.0.1/assets/a.png` + `.ext` 存在，无 `objects/` | 重启后 `[cache] 载入已有缓存 N 个对象` | 通过 | — |
| 3 `.ext` 字段 | `{"v":1,"ct":"image/png","size":12288,"at":1789324188}`，`headers.etag='"e1"'` | — | 通过 | — |
| 4/16 单桶 + CE 回放 | AE 串不同仍 `HIT`；`content-encoding: gzip`；body 45 B == gzip 原文 | `INFO HIT 45B …` | 通过 | — |
| 4 不认 gzip 的客户端 | 无 `content-encoding`，body == 明文 12288 B；随后 gzip 客户端复用同一份 | `INFO MISS->STORE 12.0KB` → `INFO HIT 12.0KB` | 通过 | — |
| 5 动态接口透传 | 两次 `BYPASS`，磁盘无 `rest/user/data` | `DEBUG BYPASS 200 …` | 通过 | — |
| 6 上游掐断重试 | 200 且 `MISS`，随后 `HIT` | `WARN RETRY-STALE (第 1 次失败：ECONNRESET)` | 通过 | — |
| 7/20 魔改命中 | `OVERRIDE`，body `MODDED-BYTES`，`content-type: image/png`，`cache-control: no-cache`，`etag: "ap-1789324189395-12"` | `INFO OVERRIDE 12B` | 通过 | — |
| 20 魔改 304 | 带同一 ETag → 304 | `INFO HIT-304 … (魔改)` | 通过 | — |
| 17 魔改 + gzip | `OVERRIDE` + `content-encoding: gzip` + 原字节 | `INFO OVERRIDE 45B` | 通过 | — |
| 18 魔改不进索引 | 对象数不含 `_ap`，魔改文件保留 | `[cache] 触发淘汰` 不涉及 `_ap` | 通过 | — |
| 8 OPTIONS 预检 | 200 + `OPTIONS-HIT` + ACAO/ACAH/ACAM `*` + `max-age=604360`，源站计数 0 | `INFO OPTIONS-HIT 127.0.0.1 /assets/opt.png` | 通过 | — |
| 8 API 预检不接管 | OPTIONS `/rest/user/data` 照常回源（计数 3） | `DEBUG BYPASS` | 通过 | — |
| 9 半截响应 | 客户端收到错误（body 未交付），磁盘无 `trunc.png` | `ERROR UPSTREAM-STREAM-ERROR aborted … total=1214` | 通过（初版挂在测试端：Node 把 `aborted/ECONNRESET` 发在 response 上，客户端没监听导致 Promise 不 settle；补 `res.on('error'/'aborted')` 后通过） | 测试客户端缺监听 |
| 9 空响应 | 仍 200，不入库，`missNoStore=1` | `WARN MISS-NOSTORE 0B (empty)` | 通过（初版原因是实现把空响应当成 `too-big`，已修） | 实现缺陷（已修） |
| 10 全零对象 | 按 `MISS` 回源 +1，文件被重写为正确字节 | `INFO MISS->STORE 12.0KB` | 通过 | — |
| 11 版本 query | `__q_v=1/` 与 `__q_v=2/` 各存一份，都 HIT | 两次 `MISS->STORE` → 两次 `HIT` | 通过 | — |
| 15 跟踪参数剥离 | 落盘 `http/localhost/assets/q.png`；换一组 `t/uid` 仍 HIT | `INFO HIT … /assets/q.png?t=1&uid=***`（值已掩码） | 通过 | — |
| 19 主机回退 | 仅存在于 `fallback.test` 目录的对象 → `HIT`，body `FROM-FALLBACK-HOST` | `INFO HIT 18B` | 通过（初版 MISS：索引只在启动时建立；加 `_adopt` 运行中接管后通过） | 计划缺口（已修） |
| 21 版本 query 回退 | 只有无 query 的对象，`?v=9` → HIT | `INFO HIT` | 通过 | — |
| 13 重启恢复 | 重启后 `HIT`；对象数 9 vs 9 | `[cache] 载入已有缓存 9 个对象` | 通过 | — |
| 7b 魔改总开关 | `overrideEnable=false` 后：`x-gbf-cache=MISS`、body 12288 B（原始素材），魔改文件仍在磁盘 | 该请求无 `INFO OVERRIDE` | 通过 | — |
| 13b 新进程接管 | 重启后的新进程第一次请求即 `HIT` | `INFO HIT 12.0KB` | 通过 | — |
| 14 清缓存 | 缓存对象清零（4 个 `_ap` 文件被保留）；随后请求 `MISS` 并重新写盘 | 工具输出 `已清空缓存：…（保留魔改文件 4 个）` + `INFO MISS->STORE` | 通过（初版把魔改文件一起删了，见 §3.3-8） | — |
| 统计接口 | `hits>0`、`layout=path-mirror`、`verifyIntegrity=false`、`errors=0` | — | 通过 | — |
| 日志规范 | 每行都带 `DEBUG/INFO/WARN/ERROR`；`INFO HIT/OVERRIDE/OPTIONS-HIT`、`WARN RETRY-STALE` 均出现；无 `STORE-ERROR`/`ENOENT` | 同上 | 通过 | — |
| 单测 · PathCache | 路径镜像、`.ext` 字段、mtime=Last-Modified、LRU 水位（92160 ≤ 100 KB）、截断/全零删除、空目录清理、重启顺序按持久化 `lastAccess` 升序 | `[cache] 触发淘汰：本轮移除 3 个对象` | 通过 | — |
| 单测 · 落盘判定 | 7 种组合全部符合预期（`ok/content-length-mismatch/all-zero/too-big/empty/content-length-invalid`） | — | 通过 | — |
| 单测 · 路径映射 | 剥参数、`__q_v=2` + 无 query 回退、`cacheHostFallback` 候选、非法字符 `a_b--c51e3988.png`、设备名 `_con--…png`、CT 表覆盖 `assetExtensions` 全集 | — | 通过 | — |
| 单测 · 迁移工具 | 搬运 2 个对象（含 a1 别名改写）、`.ext` 生成、mtime 正确、旧目录清空、二次执行 0 个 | `迁移完成：成功 2 个 …` | 通过 | — |
| 单测 · 导入工具 | 落到 `cacheHostFallback`、自动补 1 个 `.ext`、已有 `.ext` 不覆盖 | `导入完成：新补 .ext 1 个` | 通过 | — |
| 单测 · policy（工作区） | 11 项断言全部通过（含"非白名单主机也剥参数"的新语义） | — | 通过 | — |
| 回归 · 日志分析脚本 | 新级别列被剥离后解析结果与旧格式一致；真实 12189 行历史日志解析出 7300 条记录 | — | 通过 | — |

### 3.3 失败、根因与修复记录

| # | 现象 | 根因 | 最小修复 | 复跑结果 |
|---|---|---|---|---|
| 1 | E2E 首轮：磁盘上找不到 `https/127.0.0.1/...` | 测试走的是明文 HTTP 代理入口，scheme 目录实际是 `http/`；测试断言写死 `https/` | 测试里按实际 scheme 拼路径（`rel()` helper + 注释说明真实流量是 `https/`） | 通过 |
| 2 | 单测：截断/全零/重启顺序 3 项失败 | 断言写错（净化哈希应在扩展名之前；重启后顺序按**持久化**的 `lastAccess`，命中触发的 lastAccess 只在内存） | 实现：`splitExtension` 让哈希插在扩展名前；计划/测试：明确"重启按持久化时间恢复"的语义 | 通过 |
| 3 | E2E 卡死在半截响应用例 | 测试客户端只监听 `req.on('error')`，而 Node 在响应被截断时把错误发在 **response** 上 → Promise 永不 settle | 测试客户端补 `res.on('error')` / `res.on('aborted')` | 通过 |
| 4 | 空响应被记成 `too-big` | 实现把 `chunks.length === 0` 与"超限停止缓冲"混为一谈 | 用 `tooBig = !keepBuffering` 区分，空响应走 `empty` | 通过 |
| 5 | 手工放入 / 导入的对象请求时 MISS | 索引只在启动时扫描建立，运行中新增的文件不可见（计划缺口） | `PathCache._adopt()` 运行中按需接管（要求 `.ext` 存在且合法），并在统计里记 `adopted` | 通过 |
| 6 | 重启前后对象数不一致（10 vs 7） | 上一条的连带现象 | 同上；E2E 断言改为"重启前已有接管计数 + 重启后数量一致" | 通过 |
| 7 | 统计断言把重启前的计数器与重启后混用 | 测试断言位置写错（计数器是 per-process） | 断言拆成"重启前 > 0"与"重启后归零"两条 | 通过 |
| 8 | E2E：`--clear-cache` 之后魔改文件消失 | 实现按"清空 cacheDir"处理，而魔改文件正住在 cacheDir 里（计划没考虑） | `clearMode()` 跳过 `isOverridePath` 的文件并在输出里报告保留数量；测试增加"缓存对象清零 + 魔改文件保留"两条断言 | 通过 |
| 9 | `overrideEnable` 配了却不生效 | 配置项没接线（review 漏项） | 调度处 `config.overrideEnable === false ? null : cachePaths`，关闭时连 `stat` 都不做；补 E2E 用例 7b | 通过 |

### 3.4 尚未执行的一步（S8）

`tools/build.ps1` 会覆盖根目录的 `Grancache.exe`，**必须先停掉用户正在跑的代理**，
且用户可能正在游戏里。这一步需要用户明确同意时机，因此本轮只做到"源码 + 测试全绿"，未打包、未做真机验证。
真机验证清单（用户配合）：双击新版 exe → 进游戏刷新一次副本 → DevTools 抽查素材响应头出现 `HIT`/`OVERRIDE` →
`/stats` 的 `hitRate`、`cache.megabytes` 正常增长 → 日志无 `STORE-ERROR`/`ENOENT` → 放一张 `_ap` 图确认游戏内显示魔改内容 →
`node tools/latency.cjs` 比对改造前后 `cache`/`store` 段没有变慢。

---

## 4. 遗留风险与改进建议

| 项 | 说明 | 建议 |
|---|---|---|
| 真机未验证 / exe 未重打包 | 目前所有结论都来自离线测试，浏览器→代理→0dcloud 的真实链路未跑 | 经用户同意后 `--stop` → 打包 → 按 §3.4 清单验证；打包前留档旧 exe |
| 启动扫描成本未实测 | 新布局是"每个对象一个 `.ext`"，与旧实现同为一个小 JSON，但目录层级更深 | 在真实缓存上用启动日志对比 `[cache] 载入已有缓存` 的耗时；如明显变慢再做惰性扫描 |
| 命中路径多了 1~2 次 `stat`（魔改 + 主机回退） | 只在可缓存请求上发生，量级 ~0.1 ms | 若将来对象数量级再上一个台阶，可加"目录级魔改存在性"缓存 |
| 单副本编码不会区分 br | 若某天素材 CDN 开始对某些类型返回 br，我们仍只存一份（可能是 br） | 命中前已有能力比对，行为安全；真需要时再按需分桶 |
| 迁移工具未在真实 D:/gbf-cache 上跑过 | 只在临时目录里用 2 个对象验证 | 先 `--dry` 预览数量，再正式迁移；旧 `objects` 不自动删除 |
| 运行中接管没有目录监听 | 导入后第一次请求才接管（每对象一次 `stat` + 一次 `.ext` 读） | 如果导入量很大（几十万），第一次刷新会集中触发 IO；可先重启一次代理再玩 |
| 闲置淘汰（nginx `inactive`）与 `stale-if-error` | 本轮未做（M2 候选） | 上游抖动频繁时再考虑 `stale-if-error`，与 immortal 模式重叠度高 |
| 日志里的路径仍含业务参数键名 | 值已掩码（`uid=***`），但键名与路径结构仍可见 | 若要把日志分享给他人，先 `tools/audit.cjs` 汇总，不要直接发原始 `proxy.log` |

---

## 阶段 4：残留风险修复 MVP（第二轮迭代）

### 4.1 联网检索到的权威依据

| 来源 | 提取到的语义 | 我们怎么用 |
|---|---|---|
| [RFC 5861 §4](https://www.rfc-editor.org/rfc/rfc5861.html) | `stale-if-error`：遇到错误可以返回陈旧副本而不是硬错误；**错误 = 会产生 500/502/503/504 的情形**；陈旧副本有**上限窗口**，超窗不得再用；使用时应当"可见地陈旧" | 只对可缓存目标、只在窗口内、响应带 `Age` + `X-GBF-Cache: STALE` |
| [RFC 9111 §5.5 / §8.1](https://www.rfc-editor.org/rfc/rfc9111.html) | `Warning` 头已被**废弃**（登记为 obsoleted），`Age` 仍是永久字段 | **不发 `Warning`**，只发 `Age` + 自己的诊断头 |
| [nginx `proxy_cache_path`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) | 缓存项一直留在磁盘上，直到因 `inactive` 被删、被 purger 删、或被访问；`max_size` 由 cache manager 定期巡检 | `inactiveDays` 用"最后访问时间"做闲置淘汰，与容量淘汰互补 |
| [nginx 内容缓存指南](https://docs.nginx.com/nginx/admin-guide/content-cache/content-caching/) | "过期"不等于"删除" | 过期对象在开启 stale-if-error 时先留着（不再读到就删） |
| [nginx `proxy_cache_use_stale`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) | 用陈旧副本必须**按条件放开**（`error`/`timeout`/`updating`/`http_500/502/503/504`），默认 `off` | 我们默认关（`staleIfErrorSeconds: 0`），打开后只认"连接失败 / DNS 失败 / 502-504" |
| [nginx 邮件列表：`ngx_http_file_cache_expire()`](https://mailman.nginx.org/pipermail/nginx/2020-April/059238.html) | `inactive` 依据最后访问时间，由 cache manager 周期性、**分批**处理 | 闲置淘汰分批（`idleSweepFiles`），进程启动时间算一次访问做宽限 |

> 本轮检索走的是本机浏览器；沙箱内 `exec` 的网络是被禁的，所以这里记录的是**实际打开过的原页**，不是记忆。

### 4.2 MVP 范围

| 编号 | 修的残留风险 | 做法 | 默认 |
|---|---|---|---|
| M1 | 上游抖动 → 浏览器直接吃 502 | `stale-if-error`：过期对象不再立刻删（仅开启时），上游失败时回放旧副本 + `Age` + `X-GBF-Cache: STALE` + `cache-control: no-cache`；**损坏对象照旧删除，绝不用坏数据顶** | `staleIfErrorSeconds: 0` |
| M2 | 一次性抖动本可自愈 | 网关错误单次重试：仅 GET/HEAD、仅 502/503/504、仅 1 次、未向下游写字节、间隔 `retry5xxDelayMs` | `retryOn5xx: true` |
| M3 | 僵尸对象长期占住 20 GB | 闲置淘汰：按 `lastAccess` 周期分批删（`inactiveDays`），`max(lastAccess, 进程启动时间)` 做宽限 | `inactiveDays: 0` |
| M4 | 导入大批缓存包后首次刷新集中 IO | 哨兵 `<cacheDir>/.gbf-rescan-request`：导入工具写、代理每 `rescanCheckSeconds` 检查一次、分批（`rescanBatchFiles`）后台补索引 | 60 s |
| M5 | "启动扫描 / 多出来的 stat"从未实测 | 启动索引耗时写进日志 + 新增 `tools/micro.cjs` | — |
| M6 | 文档 | README 参数表、日志级别表、测试清单同步 | — |

**不做**：`stale-while-revalidate`（immortal 模式下无意义）、`min_free` 磁盘水位、purger、可缓存目标的 5xx 原样透传（改为"重试 → 旧副本 → 502"）。

### 4.3 计划 review（是否引入新风险 / 缺陷）

| 检查点 | 结论 |
|---|---|
| 会不会把坏数据当旧数据发出去 | 不会：`getStale()` 复用长度/全零/可选 md5 校验，失败即删；E2E 用例 24 是这条的反例 |
| 会不会永久发旧数据 | 不会：`staleIfErrorSeconds` 窗口外不顶；响应带 `no-cache`，浏览器不会把旧内容钉住 |
| 会不会影响动态接口 | 不会：只在 `wantCache` 路径生效；用例 26 证明动态接口的 5xx 原样透传、且不重试 |
| 会不会放大上游压力 | 单次重试 + 仅网关错误 + 仅 GET/HEAD；连接错误重试与 5xx 重试共用同一个 attempt 上限，不会叠加 |
| 闲置淘汰会不会误删热对象 | 判定取 `max(lastAccess, bootAt)`：刚重启的进程在窗口内不可能淘汰任何东西；`_ap` 魔改文件不在索引里 |
| 重扫会不会阻塞事件循环 | 分批 + `setImmediate` 让出；只补缺失项；触发即删哨兵，不重复扫描 |
| 新头值是否合法 | 这是本轮 E2E **真抓到的一个缺陷**：`x-gbf-cache-stale` 里塞了中文，Node 因非 latin1 抛错 → 被 catch 吞掉退化成 ERROR。改成机器 token（`http-503`/`badhost`/`connect`），中文只进日志与响应体 |
| 是否可回滚 | 全是新增配置键，默认值＝维持现状；代码整体仍在 `.backup-acg/` |

### 4.4 实现与校验记录

| 文件 | 变更 |
|---|---|
| `src/cache.js` | `get(candidates, {keepExpired})`、`getStale(candidates, {maxStaleMs})`、`evictIdle({maxIdleMs, limit})`、`rescan({batch})`、`stats()` 增 `idleEvictions/staleHits`、启动日志加耗时 |
| `src/main.js` | 网关错误单次重试（`RETRY-5XX`）、统一失败出口 `upstreamFailed()` + `respondStale()`、闲置淘汰定时器、重扫哨兵定时器、`clearMode` 保留哨兵、日志级别加 `STALE`/`RETRY-5XX` |
| `config.json` | 新增 8 个键：`staleIfErrorSeconds`、`retryOn5xx`、`retry5xxDelayMs`、`inactiveDays`、`idleSweepMinutes`、`idleSweepFiles`、`rescanCheckSeconds`、`rescanBatchFiles` |
| `tools/import.mjs` | 导入完成后写重扫哨兵 |
| `tools/unit.cjs` | 新增 13 条断言：keepExpired / getStale（含窗口外、未过期、损坏三反例）/ evictIdle（含启动宽限）/ rescan（含幂等） |
| `tools/e2e.cjs` | 新增用例 22–26（重试、旧副本、损坏不顶、窗口外不顶、上游健康仍重取、哨兵重扫、动态 5xx 透传）+ 统计断言 |
| `tools/micro.cjs` | 新增：量化启动建索引与命中路径的开销 |

**校验报告（第二轮）**

| 用例 | 实际输出 | 日志观察 | 结果 | 失败原因 |
|---|---|---|---|---|
| 22 网关错误重试 | 200 + `MISS`，源站命中 2 次 | `WARN RETRY-5XX (第 1 次拿到 503，50ms 后换连接重试一次)` | 通过 | — |
| 23 stale-if-error | `X-GBF-Cache: STALE`、body `STALE-COPY`、`Age: 3600`、`x-gbf-cache-stale: http-503; stale=5s`、`cache-control: no-cache`；源站命中 2 次（先重试再顶） | `WARN STALE …（http-503, 已过期 5s）` | 通过 | 初版响应头塞了中文 → Node 抛 `Invalid character in header` 被 catch 吞掉，退化成 ERROR（已修） |
| 24 损坏不顶（反例） | `X-GBF-Cache: ERROR`，坏对象被删 | `ERROR UPSTREAM-ERROR 上游返回 503` | 通过 | — |
| 24b 窗口外不顶（反例） | `ERROR`（过期 300 s > 窗口 60 s） | 同上 | 通过 | — |
| 24c 上游健康仍重取（反例） | `MISS` + 源站字节（不是旧副本） | `INFO MISS->STORE` | 通过 | — |
| 25 哨兵重扫 | 索引 13→14；随后 `HIT` 且源站 **0 次** | `INFO [cache] 后台重扫完成：扫描 14 个 .ext，新增接管 1 个对象（2 ms）` | 通过 | — |
| 26 动态 5xx 透传（回归） | 503 + `BYPASS`，源站命中 1 次（不重试、不顶旧副本） | `DEBUG BYPASS 503 …` | 通过 | — |
| 统计（重启前） | `{"stale":1,"errors":3}` | — | 通过 | — |
| 单测 · keepExpired / getStale | 未开 keepExpired 时过期即删；开启后保留但不算命中；窗口内可取旧副本（stale=5s）；窗口外拒绝；未过期不走该通道；**损坏对象拒绝并删除** | — | 通过 | — |
| 单测 · evictIdle | 启动宽限下淘汰 0 个；把 bootAt 推到 10 天前后再跑，只删 10 天没访问的那 1 个，最近访问的保留，魔改不受影响 | `[cache] 闲置淘汰：移除 1 个对象 …` | 通过 | — |
| 单测 · rescan | 新增 1 个对象并可命中；第二次 added=0（幂等） | — | 通过 | — |
| 回归 · 既有 21 条用例 | 全部仍通过（共 106 项断言 0 失败） | — | 通过 | — |
| M5 基准（1.2 万对象） | 启动建索引 636 ms（0.053 ms/对象）；命中 p50 0.162 ms，带主机回退 0.193 ms，魔改 stat 0.057 ms；**两项新增开销合计 p50 ≈ 0.088 ms**，占一次回源（150~440 ms）的 0.02%~0.06% | `[cache] 载入已有缓存 12000 个对象 / 46.9 MB（耗时 635 ms）` | 通过 | — |

### 4.5 残留风险清单（更新后）

| 项 | 状态 |
|---|---|
| 启动扫描成本未实测 | **已量化**：0.053 ms/对象（1.2 万对象 636 ms；10 万对象约 5 s）。仍建议首次启动看一眼日志里的耗时 |
| 命中路径多出的 stat 开销 | **已量化**：合计 p50 0.088 ms，占回源 0.02%~0.06%，**不需要优化**（原计划的"目录级魔改存在性缓存"取消） |
| 导入大批缓存包后首次刷新集中 IO | **已修**：哨兵 + 后台分批重扫 |
| 上游抖动直接 502 / 闲置对象占容量 | **已修**（M1/M2/M3，均可通过配置开关回退） |
| exe 未重打包、真机未验证 | **仍待用户**：需要你同意停代理的时机 |
| 迁移工具未在真实缓存上跑过 | 仍待用户：先 `--dry` 预览 |
| 日志分享注意 | 仍建议先汇总再外发 |

---

## 阶段 5：收尾完善（第三轮：真机数据 + 打包自检 + 脚本适配）

### 5.1 真实缓存上的迁移预演（只读）

```
node tools/migrate.mjs --dry
[dry-run] 迁移完成：成功 1564 个 / 42.5 MB，跳过 0 个（已有新布局或元信息损坏），数据文件缺失 0 个
```

- `D:\gbf-cache` 现状：**只有 `objects/`，3128 个文件 / 43.6 MB**（= 1564 个对象 × `.data` + `.json`），
  也就是说磁盘上全部是旧布局、且规模很小；
- 结论：**迁移是安全的**（0 跳过、0 缺失），正式执行时只需 `--stop` 后跑一次不带 `--dry` 的命令；
  备份期建议先 `--dry` 记下数字，迁移后再 `--dry` 应显示 0（幂等）；
- 顺带把 M5 的"启动扫描"放进真实量级：按实测 0.053 ms/对象，1564 个对象约 **0.08 s**；即便将来涨到 10 万对象也只有约 5 s。

### 5.2 打包链路自检（离线，不需要联网/停代理）

新增 `tools/verify.cjs`，把"打包后才发现的坑"提前到打包前：

| 检查 | 结果 |
|---|---|
| `tools/bundle.mjs` 的 `modules` 清单 vs 源码里全部内部 require | 通过（4 个模块全覆盖，漏登记会直接 FAIL） |
| 真跑一次内联 + `node --check` | 通过（`bundle.js` 126.1 KB） |
| 产物含本轮关键符号（`PathCache/getStale/evictIdle/rescan/shouldStoreBody/cachePaths/respondStale/upstreamFailed/RESCAN_SENTINEL/RETRY-5XX/OVERRIDE/OPTIONS-HIT`） | 通过（12/12） |
| 内联产物实跑 `node bundle.js --help`（临时工作目录） | 通过（退出码 0、无 `Cannot find module`、帮助里有新参数说明） |

也就是说：**只剩 `postject` 注入与覆盖 exe 需要联网 + 停代理**，其余都能离线验证完。

### 5.3 新增端到端用例（浏览器真实路径）

| 用例 | 期望 | 实测 | 结果 |
|---|---|---|---|
| 27 HEAD | 命中时 200、无响应体 | `status=200 len=0 cache=HIT` | 通过 |
| 28 命中 + `If-None-Match` | 304 | `status=304` | 通过 |
| 29 PAC | 可下发、指向本代理端口、含 GBF 域名 | `status=200 len=527` | 通过 |
| 30 后台条件校验（`revalidateAfterSeconds>0`） | 命中后后台发条件请求，304 后把 `revalidateAt` 写回 `.ext` | `INFO REVALIDATED-304 … /assets/rv.png`；`revalidateAt 1789362222882 → 1789362228682` | 通过 |
| 31 `--stop` | 记录 pid 正确、能停掉代理、端口关闭 | `pidFile=36404 child=36404`；`已停止缓存代理（进程 36404）`；端口已关闭 | 通过 |

### 5.4 本轮抓到的两个真实缺陷（都已修）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 10 | 端口没释放时新实例绑定失败，`--stop` 停不掉真正在跑的代理 | ① pid 文件在 `listen` **之前**就写了，失败实例留下"指向死进程"的 pid；② 归属校验只靠 `tasklist`，受限环境会 `Access denied` → 误判"进程不存在" | ① pid 文件改到 `listen` 回调里写；② `--stop` 改为**实例自证**（请求 `/stats` 比对 `pid`，快照里新增 `pid` 字段），`tasklist` 只作兜底 |
| 11 | `stale-if-error` 在真机上会退化成 ERROR（用例 23 抓到） | `x-gbf-cache-stale` 头里塞了中文，Node 因非 latin1 头值抛错，被 `.catch` 吞掉 | 头值只放机器 token（`http-503`/`badhost`/`connect`），中文只进日志与响应体 |

### 5.5 脚本适配与度量

| 脚本 | 变更 | 验证 |
|---|---|---|
| `tools/disk.mjs` | 数据文件收集不再写死 `objects/*.data`，改为"缓存目录下所有非 `.ext`/非 `.tmp`/非 `_ap` 文件"，新旧布局通吃 | 真实 `D:\gbf-cache` 上可正常取样本 |
| `tools/probe.cjs` | 临时工作目录改到系统临时目录，并自动生成配置、拷证书（不再往 `.backup-orig` 写） | 语法检查通过；它需要在有网环境实跑 |
| `tools/verify.cjs` | 新增（见 5.2） | 全部通过 |
| `tools/micro.cjs` | 新增（见 4.4） | 1.2 万对象：建索引 636 ms / 命中路径额外开销 p50 0.088 ms |

### 5.6 现在的完整自检矩阵

| 命令 | 覆盖 | 结果 |
|---|---|---|
| `node test\e2e.test.cjs` | 端到端 31 条用例 / **115 项断言** | 全部通过 |
| `node test\unit.test.cjs` | PathCache + policy + 落盘判定 + stale/idle/rescan | 全部通过 |
| `node test\migrate.test.cjs` | 迁移 / 导入工具 | 全部通过 |
| `node test\verify.test.cjs` | 打包前内联自检 | 全部通过 |
| `node --test tests\cache-optimization.test.mjs` | policy 单元测试 | 11/11 通过 |
| `node tools/micro.cjs [N]` | 索引构建 / 命中开销量化 | 有数字可对比 |
| `node tools/latency.cjs` / `audit.cjs` | 真实历史日志（12189 行）回归 | 解析正常 |
| `TARGET=exe node test\e2e.test.cjs` | 打包后的 exe（**需先重打包**） | 待执行 |

### 5.7 残留清单（只剩需要你点头的两件事）

| 项 | 需要什么 | 说明 |
|---|---|---|
| 重打包 exe | 你的同意（会 `--stop` 并覆盖根目录 exe）+ 一次联网（`rcedit` / `postject`） | 源码与内联产物已离线验证通过；打包后建议再跑 `TARGET=exe` 那套用例 |
| 正式迁移旧缓存 | 同上（`--stop` 后跑一次 `tools/migrate.mjs`） | `--dry` 已确认 1564 个 / 42.5 MB、0 异常；迁移后旧 `objects` 保留，可随时回滚 |
| 真机验证 | 你玩一局 | 按 §3.4 清单：DevTools 看 `HIT`/`OVERRIDE`、`/stats` 命中率与占用、日志无 `STORE-ERROR`/`ENOENT`、放一张 `_ap` 图看游戏内变化 |

---

## 阶段 6：交付上机（第四轮：打包 + 迁移 + 验证）

### 6.1 打包（已完成）

| 项 | 结果 |
|---|---|
| 内联产物 | `build/bundle.js` **128.1 KB**（内联 4 个模块） |
| SEA 注入 | `postject` 注入成功，图标已设置 |
| 成品 | `Grancache.exe` **92,236,800 字节**（88.0 MB） |
| 三个入口同步 | `Grancache.exe` / `一键开始玩.exe` / `Grancache.exe` 全部换成同一份新构建（旧版备份在 `.backup-acg\*.before-*`） |
| 新代码真的在里面 | blob 与 exe 内都能搜到 `RESCAN_SENTINEL` / `upstreamFailed` / `respondStale` / `evictIdle` / `RETRY-5XX` / `OPTIONS-HIT` |

**踩到的坑（已修，以后不会再遇到）**

| 现象 | 根因 | 处理 |
|---|---|---|
| `build.ps1` 最后一步覆盖 exe 报 `Access to the path is denied`（文件没被占用、没有只读属性） | 项目里的文件带着 **High Mandatory Integrity Level + NW（禁止写）** 标签（之前某次用管理员权限生成留下的），中等完整性进程即使有 Modify 权限也不能写 | 用一次 UAC 提权把新 exe 换上去，并用 `icacls /setintegritylevel (OI)(CI)Medium /T` 把项目树降回 Medium；之后**重打包全程不需要提权**（已实测） |
| 提权脚本自己的日志没落地 | 脚本里用了含中文的路径，`-File` 在 PowerShell 5.1 下按 ANSI 解析脚本导致写法失败（但替换动作照常完成） | 一次性脚本已删除；替换结果以文件体积/时间 + 端到端测试确认 |

### 6.2 旧缓存正式迁移（已完成）

```
node scripts\migrate.mjs
迁移完成：成功 1473 个 / 35.3 MB，跳过 91 个（已有新布局或元信息损坏），数据文件缺失 0 个
node scripts\migrate.mjs --dry
[dry-run] 迁移完成：成功 0 个 / 0.0 MB，跳过 91 个…（幂等）
```

- 1473 + 91 = 1564，与迁移前 `--dry` 统计一致：**91 个是同一 URL 的旧编码分桶副本**（旧键是 `url + accept-encoding`，新布局单副本），属于预期合并；
- 落盘核对：`D:\gbf-cache` 新布局 **1473 个数据文件 + 1473 个 `.ext`**，`https/<host>/…` 结构正常；
  抽样 `.ext`：`{"v":1,"url":"…mobage-jssdk-client.3.10.1.min.js","LastModified":"…","ETag":"…","size":88058,…}`，数据文件 88058 字节，与 `size` 一致；
- 旧 `D:\gbf-cache\objects` **保留未删**（可回滚；确认没问题后手动删即可）。

### 6.3 真实配置冒烟（新 exe）

```
stats: objects=1473 layout=path-mirror MB=35.3
INFO [cache] 载入已有缓存 1473 个对象 / 35.3 MB（耗时 119 ms）
INFO [upstream] 出口 = http://127.0.0.1:17891
INFO [start] 代理监听 http://127.0.0.1:18080
→ Grancache.exe --stop → 已停止缓存代理（进程 12852）→ 端口已释放
```

- 真实启动扫描：**1473 个对象 119 ms**（≈0.08 ms/对象，与合成基准 0.053 ms/对象同量级）→ 风险项"启动扫描成本未实测"闭环；
- 顺手修掉一个日志缺口：`PathCache` 的载入/淘汰日志原来走 `console.log`（**进不了 `proxy.log`**），
  现在由 `src/main.js` 注入统一 `log()`（带级别、支持 `logMinLevel` 过滤），已重新打包并复测（上面那行就是证据）。

### 6.4 本轮验证矩阵（全部通过）

| 命令 | 对象 | 结果 |
|---|---|---|
| `node test\e2e.test.cjs` | 源码 `src/main.js` | **115 项断言 / 0 失败** |
| `TARGET=exe node test\e2e.test.cjs` | **打包后的 exe** | **115 项断言 / 0 失败** |
| `node test\unit.test.cjs` | PathCache / policy / 落盘判定 / stale / idle / rescan | 全部通过 |
| `node test\migrate.test.cjs` | 迁移 / 导入工具 | 全部通过 |
| `node test\verify.test.cjs` | 打包前内联自检 | 全部通过 |
| `node --test tests\cache-optimization.test.mjs` | policy 单元测试 | 11/11 |
| 真实配置冒烟 | 新 exe + `D:\gbf-cache` | 索引 1473、`path-mirror`、启动 119 ms、`--stop` 正常 |

### 6.5 现在只剩"你在游戏里验一眼"

| 步骤 | 期望看到 |
|---|---|
| 双击 `Grancache.exe`（或 `一键开始玩.exe`） | 窗口提示后台代理已启动、并用带缓存的配置打开 Chrome 进游戏 |
| 进游戏后刷新一次副本 | DevTools 里素材响应带 `X-GBF-Cache: HIT`；第二次刷新几乎全命中 |
| 打开 <http://127.0.0.1:18081/> | 命中率、缓存占用（约 35 MB 起）、魔改/预检/旧副本等计数正常增长 |
| 看 `runtime\logs\proxy.log` | 无 `STORE-ERROR` / `ENOENT`；有 `载入已有缓存 …（耗时 … ms）` |
| 想试魔改 | 把改好的文件命名为 `原名_ap.后缀` 放进 `D:\gbf-cache\https\<host>\<原路径>`，游戏里 Ctrl+F5 一次 |

若哪一步不符合预期，把 `runtime\logs\proxy.log` 尾部 + `/stats` 的 JSON 给我，我接着定位。

---

## 阶段 7：太郎插件图片"代理一停就挂"的根治（第五轮）

### 7.1 现象与根因

用户反馈：**缓存代理不启动（停掉之后）太郎插件里的图片无法显示；代理启动时正常**。

| 证据 | 结论 |
|---|---|
| `runtime\logs\proxy.log` 里有 `prd-game-a1-…` 137 行、`prd-game-a5-…` 3 行 | 太郎的图片请求打的是这些**老域名** |
| 太郎是**解包加载**的 Chrome 扩展，源目录 `E:\GameHelper\Chrome-Extension-Tarou.v3.4.1\Chrome-Extension-Tarou`；`assets\useImage-*.js` 里 `s="https://prd-game-a1-granbluefantasy.akamaized.net/assets/img"`，所有图片 URL 都由它拼 | 素材基址是**硬编码**的（另有 `a5` 出现在 `storage-*.js`） |
| 这些老域名"全球 DNS 已不存在"，而 `config.hostAliases` 会把 a1~a5 改写到真实域名 | 代理在跑 → 改写到真实域名 → 图片正常；代理停 → 浏览器直连老域名 → NXDOMAIN → 图片全挂 |

### 7.2 先排除的两条"看起来可行"的路（有实测证据）

| 候选修法 | 实测 | 结论 |
|---|---|---|
| hosts 文件 / Chrome `--host-resolver-rules` 把老域名指到真实 CDN IP | 用 DoH 取到真实 IP（`23.205.46.182`），再以 `SNI=prd-game-a1-…` 直连：TLS 通过（`ssl_verify_result=0`）但服务器返回 **HTTP 400** | **无效**：Akamai 已不为这个域名提供内容，"让它能解析"并不能让它能取到图 |
| 把 PAC 做成"代理停了也能用" | PAC 由统计端口提供，代理停就没有 PAC 源；Chrome 不支持 `file://` PAC | 无效 |

### 7.3 根治：改扩展源码（已执行）

```
把 prd-game-a[1-5]-granbluefantasy.akamaized.net  →  prd-game-a-granbluefantasy.akamaized.net
已修改 8 个 .js（14 处）+ 9 个 .map；原文件全部备份为 *.orig-20260914
复查：全目录（排除备份）剩余死域名 = 0
语法校验：8/8 通过（复制成 .mjs 后 node --check）
```

- 效果：太郎直接请求**能解析的真实域名** —— **代理开着正常、代理停着也正常**（直接走 0Dcloud 的规则出网）；
- 生效方式：**chrome://extensions 里对太郎点一次"重新加载"**（解包扩展会重新从磁盘读取），或重启 Chrome；
- 回滚：把同目录下的 `*.orig-20260914` 覆盖回原名即可；
- 新增可复用脚本 [tools/patch.ps1](../tools/patch.ps1)（太郎更新后补丁会被覆盖，重跑一次即可；`-Dry` 预览）。

### 7.4 兜底：死别名域名的素材给浏览器长缓存（已重打包）

即使将来太郎更新把补丁覆盖掉（a1 又回来），也希望"已经看过的图片"在代理停掉后还能显示：

- 判定：请求命中 `config.hostAliases` 里的域名（a1~a5 这类已死别名）+ 静态素材扩展名；
- 行为：**回源那一次与命中那一次**都把浏览器侧 `cache-control` 改写成 `public, max-age=604800`（7 天，
  可用 `aliasBrowserMaxAgeSeconds` 调整）；其它素材仍按原来的 300 s，不受牵连；
- 代价：这些素材在浏览器里最多 7 天不回头问代理；改过魔改素材时照 README 的 Ctrl+F5 即可。

### 7.5 校验

| 用例 | 实际输出 | 结果 |
|---|---|---|
| 32 别名主机素材长缓存 | 首次 `MISS` + `cache-control: public, max-age=604800`；二次 `HIT` + 同样 604800 | 通过 |
| 32 普通主机不受牵连 | `HIT` + `cache-control: public, max-age=300` | 通过 |
| 源码端到端 | **119 项断言 / 0 失败** | 通过 |
| 打包 exe 端到端 | **119 项断言 / 0 失败**（新构建 92,238,336 字节，三个入口已同步） | 通过 |
| 太郎扩展语法 | 8/8 通过；全目录死域名 0 | 通过 |

### 7.6 你要做的一步

**在 chrome://extensions 里对"太郎"点一次"重新加载"**（或重启 Chrome），然后：

1. 不开缓存代理，直接进游戏 → 太郎插件里的图片应当正常显示（它现在请求的是真实域名）；
2. 打开缓存代理再进一次 → 同样正常，而且这些素材会被我们的代理缓存加速；
3. 若某次太郎更新后图片又出问题，跑一遍 `scripts\patch.ps1` 再"重新加载"即可。

---

## 阶段 8：项目瘦身（第六轮：清理冗余文件）

### 8.1 先核查再动手

| 核查 | 结果 |
|---|---|
| 三个顶层 exe 是否相同 | `Grancache.exe` / `一键开始玩.exe` / `Grancache.exe` 的 SHA256 完全一致（`7B94A5B0…`）→ 副本可安全删 |
| `build\Grancache.exe` | 与根目录 exe 同哈希（`build.ps1` 的中间产物）→ 可再生，删 |
| `.backup-acg` 里的 exe 备份 | 4 份但只有 2 个唯一哈希 → 每份留 1 个，删重复 |
| 疑似冗余脚本是否被引用 | `start-proxy-silent.ps1` / `stop-proxy.ps1`：0 引用；`certs.ps1`(4) / `trust.ps1`(3) / `untrust.ps1`(2) / `prepare.js`(1，被 setup-ca 引用) → 保留 |
| `tools\_*.cjs` 9 个一次性诊断脚本 | 全部 0 引用 → 移出 |

### 8.2 处理结果

| 处理 | 内容 | 体积 |
|---|---|---|
| **直接删除** | `一键开始玩.exe`、`Grancache.exe`、`build\Grancache.exe`（三者都与保留的 exe 字节相同） | 264.0 MB |
| **直接删除** | `.backup-acg\Grancache.exe.before-20260914`、`.backup-acg\Grancache.exe.before-swap`（重复备份） | 175.8 MB |
| **直接删除** | 空目录 `cache\`、`.backup-20260913-003523\` | 0 |
| **移入 `_trash-20260914\`（可搬回）** | `.backup-orig\`（历史备份，含 2 个 87.9 MB 旧 exe） | 443.0 MB |
| 同左 | `logs\_ilspy\`（反编译工具，可重下）、`logs\_apk\`、`logs\_*.txt` ×34 | 17.4 MB |
| 同左 | `tools\_*.cjs` ×9（一次性诊断） | ~30 KB |
| 同左 | `tools\clear-cache.ps1`、`tools\stop-proxy.ps1`、`tools\start-proxy-silent.ps1`（已被 `--clear-cache` / `--stop` / 双击启动取代） | ~3 KB |

合计：**直接释放 ≈ 440 MB**；另有 **≈ 460 MB** 已移出到 `_trash-20260914\`，确认没问题后删掉该目录即可彻底释放。

### 8.3 保留清单（不动）

| 保留 | 理由 |
|---|---|
| `Grancache.exe`（唯一入口）+ `config.json` / `src/main.js` / `Grancache.ico` / `README.md` / `.gitignore` | 运行与使用必需 |
| `lib\`（4 个模块）、`certs\`（CA 与证书） | 运行必需 |
| `tools\`：build-exe / bundle / make-icon / install-ca / setup-ca / uninstall-ca / pregenerate-certificates / migrate-cache / import-acgpower-cache / patch-tarou-asset-host | 打包、证书、迁移导入、太郎补丁 |
| `tools\`：analyze-latency / audit-log / bench-cache / bench-latency / bench-pathcache / bench-proxy / cdp-probe / probe-newlog / proxy-e2e / test-cache-lru / test-migration-tools / test-proxy-offline / verify-bundle | 维护用的测试与基准（README 已列出） |
| `.backup-acg\` | **回滚**用：改造前源码 + 2 份唯一旧 exe（176 MB） |
| `runtime\logs\proxy.log`、`logs\stdout.log`、`logs\stderr.log`、`logs\_decompiled_base\`、`logs\_decompiled_gbf\`、`logs\api-dump\` | 实时日志 / 反编译存档（本计划 §0 引用）/ 接口抓取样例 |
| `build\rcedit.exe`、`build\icon-source.png`、`build\sea-config.json` | 打包需要（rcedit 省一次下载） |
| `.workbuddy\`（项目记忆） | 交接用笔记 |

### 8.4 清理后的验证

| 检查 | 结果 |
|---|---|
| 保留的 exe 哈希 | `7B94A5B0EA0C3B18` —— 正是刚刚跑过 **119/119** 端到端的那份构建，未受影响 |
| `node test\unit.test.cjs` | 全部通过 |
| `node test\migrate.test.cjs` | 全部通过 |
| `node test\verify.test.cjs`（打包自检） | 全部通过 |
| 目录体积 | `_trash-20260914` 460.5 MB、`.backup-acg` 176 MB、`logs` 2 MB、`build` 1.6 MB、其余均 < 0.2 MB |

---

## 阶段 9：图形控制面板（第七轮：手动开关缓存）

### 9.1 设计（为什么做成"外部脚本"而不是塞进 exe）

需求：给缓存一个**稍微美观的交互界面**，能手点按钮开启/关闭缓存。

关键约束：**"开启"这个动作必须在代理没跑的时候也能点** —— 所以界面不能由代理自己的统计页提供
（代理一停，页面就没了）。因此：

| 选择 | 理由 |
|---|---|
| 界面 = `tools\panel\gbf-panel.ps1`（WinForms，深色主题） | 不依赖任何第三方库；由系统自带 PowerShell 跑；**不用改 exe、不用重打包**，因此完全不碰已经 119/119 验证过的成品 |
| 启动 = `Grancache.exe --daemon` | 复用现有命令行模式，面板只是"按钮 → 命令"的薄封装 |
| 入口 = 根目录 `启动缓存面板.cmd` | 双击即开（`start` + `-WindowStyle Hidden`，只留面板窗口，不留控制台窗口） |
| 配色 | 沿用统计页的深色系（背景 `#0f1115`、卡片 `#161b22`、主色 `#7ee787`），风格统一 |

面板内容：标题条 + 状态灯（● 运行中 / ● 已停止）；主按钮行 **启动缓存 / 停止缓存 / 重启 / 打开游戏**；
次按钮行 **清空缓存 / 打开统计页 / 打开日志**；数据卡（状态+PID、运行时长、命中率、请求/命中、
缓存占用与对象数、上游出口与各类计数）；底部 `runtime\logs\proxy.log` 最近 12 行（2 秒轮询，文件没变不重画）。

### 9.2 安全性设计（review 过的两个点）

1. **"启动"幂等**：`Start-Cache` 先查 `/stats`，已在跑就直接返回 —— 不会起第二个实例；
2. **自测绝不打断在用会话**：`-SelfTest` 进来先探测；若代理本来就在运行，**跳过启动/停止**，只验证运行态数值。

### 9.3 自测（不需要点鼠标）

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\panel\gbf-panel.ps1 -SelfTest
[1/5] 构造窗口（不显示）...   OK: 600x520，控件 12 个
[2/5] 读取状态...             状态标签 = ● 运行中；进来之前就在运行 = True
[3/5] 已有实例在跑 → 跳过“启动/停止”，只验证运行态的界面数值
      缓存 = 67.7 MB · 2068 个；命中率 = 9.2%；出口 = http://127.0.0.1:17891 · 淘汰 0 魔改 0 预检 0 旧副本 0 未入库 0
[5/5] 日志尾部读取...         日志框行数 = 12
SELFTEST OK
```

（代理没在跑时，同一自测会真跑一遍 `--daemon` → 读状态 → `--stop`。）
语法另经 PowerShell AST 解析检查：`PARSE OK`；脚本带 UTF-8 BOM（PowerShell 5.1 才能正确读中文）。
面板是原生窗口，本机自动化环境截不到屏幕，所以**视觉效果请你眼睛过一遍**（尺寸/配色想调随时说）。

### 9.4 顺带抓到并修掉的一个真实缺陷（pid 文件被误删）

自测第一次跑的时候暴露了它：

| 环节 | 现象 |
|---|---|
| 现象 | 代理明明在跑（`/stats` 有响应、PID 3656、2068 个对象），但 `logs\proxy.pid` **不见了** |
| 后果 | `--stop` 找不到记录 → 面板"停止"、命令行 `--stop` 全部失效 |
| 根因 | 自测里的"启动"起了**第二个实例**；它因端口被占绑定失败退出，而退出处理器 `removePidFile()` **无条件删除 pid 文件** —— 删掉的是**正在跑那个实例**的记录（旧代码在启动时就写 pid，问题更早：会先覆盖再删） |
| 处理 | ① 已按运行中实例的真实 pid 恢复 pid 文件（未重启会话）；② 源码修复：`removePidFile()` 只删**属于自己**的 pid（`cur !== process.pid` 就返回）；③ 面板"启动"改成幂等；④ 自测在"已在运行"时跳过启停 |
| 待办 | 修复要**重打包 exe** 才进成品；`build.ps1` 会先杀掉正在跑的代理，所以等不玩时再打包 |

### 9.5 交付物

| 文件 | 说明 |
|---|---|
| `tools\panel\gbf-panel.ps1` | 面板本体（含 `-SelfTest`） |
| `启动缓存面板.cmd` | 双击入口（可右键 → 发送到桌面快捷方式） |
| `README.md` | 「用法 → 想要图形界面」小节 + 本次缺陷修复说明 |

---

## 阶段 10：控制面板做成独立应用（第八轮：Ant Design 界面 + 独立 exe）

### 10.1 需求与架构

需求：面板要是**一个应用（exe）**，和缓存启动的 exe 一起交付；界面用 **Ant Design** 那类组件库做；
「一键启动（同时起 Chrome 和缓存）」要是应用里的一个按钮；也要能**单独**开关缓存。

架构（不引运行时依赖）：

```
Grancache.exe  （就是 Grancache.exe 的同一份代码，按文件名自动进面板模式）
  ├─ 本地控制服务 127.0.0.1:18082      ← 提供界面 + 控制接口（一次性令牌防跨站）
  │    GET  /             Ant Design 界面（构建产物已内联进 exe）
  │    GET  /api/status   代理与缓存状态（读代理自己的 /stats）
  │    GET  /api/log      日志尾部
  │    POST /api/action   start-proxy / stop-proxy / restart-proxy / start-all / clear-cache / open-stats / open-log
  └─ 用 Chrome --app=http://127.0.0.1:18082/ 打开“应用窗口”（无地址栏/标签页）
       按钮 → 控制服务 → 调 Grancache.exe 的命令行模式（--daemon / --stop / --clear-cache / 无参数=playMode）
```

| 设计点 | 说明 |
|---|---|
| 界面技术 | React + **Ant Design 5**（深色算法 + 绿色主色，和统计页同色系）+ Vite 构建 |
| 为什么"界面进 exe" | `tools/bundle.mjs` 把 `ui/dist` 内联成 `./panel-assets` 模块，面板运行时不依赖磁盘目录、不依赖网络 |
| 为什么不是 Electron | 项目坚持零运行时依赖；Chrome `--app` 窗口已经够像桌面应用，而且用户本来就有 Chrome |
| exe 复用 | 同一份代码两个入口：`Grancache.exe`（双击=一键开始）与 `Grancache.exe`（双击=面板）。改名规则：文件名含"面板/panel"且**不带参数**时进面板 |
| 动作来源 | 全部复用已验证的 CLI：`--daemon` / `--stop` / `--clear-cache` / 无参数 playMode（一键启动） |

### 10.2 安全与稳健性 review

| 检查点 | 结论 |
|---|---|
| 本地服务被别的网页乱调？ | 控制服务只监听 127.0.0.1；**所有写操作要求请求头 `x-gbf-panel: <一次性令牌>`**（令牌每次启动随机生成，只注入到面板页面里），跨站请求发不出自定义头 → 用例里已验证"无令牌/错令牌 = 403" |
| 会不会重复起实例？ | `start-proxy` 先查 `/stats`，已在跑直接返回"无需重复启动"；`start-all` 走 playMode（它自己也会先检查端口） |
| 会不会打断正在玩的会话？ | 运行中时"启动缓存"按钮是禁用状态；只有你点"停止/重启"才会影响；测试里也验证了"重复 start 幂等" |
| 面板服务崩了会怎样 | 与代理是两个独立进程：面板只是读代理的 `/stats`，不影响代理工作 |
| 端口冲突 | 面板默认 18082（可用 `--panel-port=` 改）；代理占 18080/18081，互不影响 |

### 10.3 校验证据

| 项目 | 结果 |
|---|---|
| 面板 API 端到端（源码 `node src/main.js --panel-only`） | **19 项断言 / 0 失败**：页面 200 + 令牌注入、`/api/status`、`/api/log`、无令牌/错令牌 403、未知动作 400、**start-proxy → 状态变运行中 → 重复 start 幂等 → stop-proxy → 状态变已停止 → clear-cache**、日志有 `PANEL` 记录 |
| 面板 API 端到端（打包后的 `Grancache.exe`） | 同上 **19/19**，并确认 `panelAssets: inline（2 个文件）` —— 界面确实在 exe 里 |
| 语法/构建 | `node --check` 全部通过；`vite build` 产物 `index.html` + `assets/index-*.js`（635 KB，含 antd 与 React） |
| 界面外观 | 已在浏览器里实际渲染检查：标题条 + 绿色状态标签（`● 运行中 · PID 3656`）、大号"一键启动"按钮、只控制缓存三按钮、维护三按钮、6 个统计卡（请求 4184 / 命中率 11.4% / 命中 304 / 缓存 82.9 MB / 对象 2617 / 运行 01:47:42）、上游出口与计数、实时日志窗格、说明卡 |

### 10.4 打包与交付

```powershell
# 只出面板 exe（不动正在运行的代理）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -OutName Grancache.exe -NoStop

# 平常重打包主 exe（会先停掉正在跑的代理，建议不玩的时候做）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

| 现状 | 说明 |
|---|---|
| `Grancache.exe`（88.8 MB） | **新构建**：含 Ant Design 界面 + 控制服务 + `removePidFile` 修复，已通过 19/19（exe 版） |
| `Grancache.exe`（88.0 MB） | 仍是上一轮构建（面板代码与 pid 修复要重新打包才进；因为打包会杀掉正在跑的代理，等你玩完再打） |
| 旧面板脚本 | `启动缓存面板.cmd`、`tools\panel\gbf-panel.ps1` 已移入 `_trash-20260914\` |

### 10.5 你要做的

**双击 `Grancache.exe`** → 弹出应用窗口（若 Chrome 没开，会先拉起 Chrome）：
点「一键启动」= 缓存 + Chrome + 游戏；只用缓存时点「启动缓存」/「停止缓存」；不想用了关掉窗口即可（缓存继续在后台跑）。

---

## 阶段 11：日志追踪字段化（第九轮：MVP）

### 11.1 现状与缺口（用真实日志做依据）

真实 `runtime\logs\proxy.log` 的事件分布：`BYPASS 2785 / MISS->STORE 1144 / TLS 902 / HIT-304 211 / HIT 94 / …`。

问题：日志只有"动作 + 主机 + 路径"，**没有对象身份**，所以回答不了：

| 想知道 | 现有日志能不能回答 |
|---|---|
| 这个素材第一次没命中、第二次命中了吗？ | ✗ 认不出"同一个素材"（同名不同 host/query 会混在一起，也没有首次/后续的区分） |
| 为什么一直命中不了？ | ✗ 只看到 `MISS->STORE` 反复出现，看不出是"本机没有"还是"有对象但过期/损坏/编码不符" |
| 哪些请求压根不该缓存？ | △ 只有 `BYPASS` 计数，没有原因分类（动态接口 / 方法 / Range / 域名排除） |
| 入库失败是哪种失败？ | △ 只有 `MISS-NOSTORE (empty)` 这类自由文本，没有稳定枚举 |

### 11.2 MVP 字段设计

不改人类可读日志（既有脚本不受影响），**额外**写一份机器可读事件流 `logs\events-YYYY-MM-DD.jsonl`（一次请求一条）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `session` / `seq` | string / number | 本次运行的标识与事件序号（能区分"重启前后"） |
| `t` / `id` | string | ISO 时间 / 请求 id（`r000123`），可和人类日志对齐 |
| `method` / `host` / `path` / `url` | string | 请求目标（`path` 里的 uid 等值在人类日志里已掩码） |
| `cacheable` | bool | 这次请求**是否允许走缓存** |
| `key` | string | **缓存对象身份**：`<scheme>/<host>/<路径>`，同一素材每次都相同 → 这是"第一次/第二次"能配对的前提 |
| `bypassReason` | enum | `cacheable=false` 的原因：`excluded-pattern` / `passthrough-host` / `method` / `range` |
| `outcome` | enum | 见下表 |
| `store` / `storeReason` | enum / enum | 写入结果与原因：`stored` / `skipped`；原因 `asset-host`、`cache-control`、`empty`、`all-zero`、`content-length-mismatch`、`too-big`、`not-cacheable`、`status`、`method` |
| `missReasons` | enum[] | **本机有对象却没命中**的原因：`expired` / `unreadable` / `size-mismatch` / `all-zero` / `md5-mismatch`（空数组=本机根本没有） |
| `bytes` / `status` / `fromCache` | number / number / bool | 体积、上游状态码、是否来自本地 |
| `encoding` | string? | 缓存体的 `content-encoding`（gzip / 空）→ 用来排查"编码不符导致没命中" |
| `staleSeconds` / `error` | number? / string? | 旧副本超期秒数 / 失败原因（`STALE`、`ERROR` 专用） |

`outcome` 枚举（一次请求只会是其中一个）：

| outcome | 含义 | 典型场景 |
|---|---|---|
| `HIT` | 本地命中 | **第二次请求命中** |
| `HIT-304` | 本地命中 + 客户端条件请求命中（不传字节） | 浏览器带 ETag 回访 |
| `MISS` | 回源并成功入库 | **第一次请求（未命中）** |
| `MISS-NOSTORE` | 回源了但没入库（看 `storeReason`） | 空响应 / 超限 / 长度不符 |
| `BYPASS` | 不该缓存（看 `bypassReason`） | 动态接口 `/rest/...` |
| `OVERRIDE` / `OVERRIDE-304` | 命中 `_ap` 魔改文件 | 本地魔改 |
| `OPTIONS-HIT` | 预检本地应答 | CORS 预检 |
| `STALE` | 上游失败、用旧副本顶了一次 | 节点抖动 |
| `ERROR` | 上游彻底失败 | 502/503/504 且没有旧副本 |

**三个"要识别的情况"如何判定**（这是本次设计的核心）：

| 要识别的情况 | 判定规则（用上面的字段） |
|---|---|
| 第一次未命中 | 同一个 `key` 的第一条事件 `outcome=MISS`（且 `store=stored`） |
| 第二次命中 | 同一个 `key` 在若干次 `MISS` 之后出现 `outcome=HIT`/`HIT-304` → 报告里统计"先 MISS 后 HIT"数量与间隔 |
| 没法命中 | ① 本机没有：`missReasons` 为空；② 有对象却没用上：`missReasons` 非空（`expired`/`size-mismatch`/`all-zero`/`md5-mismatch`/`unreadable`）；③ 压根不该缓存：`cacheable=false` + `bypassReason`；④ 存不进去：`outcome=MISS-NOSTORE` + `storeReason` |

### 11.3 实现与用法

| 文件 | 变更 |
|---|---|
| `src/main.js` | 每个请求一个 `trace` 上下文 + `emitTrace()`（JSONL，按天分文件，超过 `traceMaxMB` 轮转 `.1`）；在 8 个"结果已定"的位置各写一条；另外给统计页端口加了 EADDRINUSE 兜底（原来会直接抛栈退出） |
| `src/cache.js` | `get(candidates, { onSkip })`：把"有对象却没命中"的原因（`expired`/`unreadable`/`size-mismatch`/`all-zero`/`md5-mismatch`）报给调用方 |
| `config.json` | 新增 `traceJsonl: true`、`traceMaxMB: 16` |
| `tools/report.cjs` | 追踪报告：结果分布、不可缓存原因、写入原因、**先 MISS 后 HIT 的对象数与样例**、从未命中的对象与原因、过期等 missReasons 分布 |
| `tools/trace.cjs` | 造 4 种情况（首 MISS→次 HIT / 过期没法命中 / 动态接口不缓存 / 空响应不入库）验证字段与报告 |

```powershell
node tools\report.cjs              # 看今天的事件报告
node tools\report.cjs --top 20     # 明细多列一些
```

### 11.4 验证

| 项目 | 结果 |
|---|---|
| `node test\trace.test.cjs` | **13/13**：事件文件生成、`key` 身份、`MISS`+`store`+`storeReason`、`MISS`↔`HIT` 的 key 相同、过期被标成 `missReasons:["expired"]`、动态接口 `bypassReason=excluded-pattern`、空响应 `MISS-NOSTORE/empty`、报告识别"先 MISS 后 HIT 1 个""从未命中 1 个""excluded-pattern" |
| 报告实测输出（节选） | `MISS 3 / HIT 2 / BYPASS 1 / MISS-NOSTORE 1`；`先 MISS 后 HIT 的对象数 1`；`只 MISS、从未命中的对象数 1`；`"本机有对象却没命中"的原因: expired 1` |
| 回归（改了热路径，必须全套） | 源码 E2E **119/119**、exe E2E **119/119**、面板 **19/19**（含界面 inline）、缓存层/迁移/打包自检各套件全部通过 |

---

## 阶段 12：只留一个 exe + 代码文件短名化（第十轮）

### 12.1 一个 exe，双击即面板

之前是"主 exe + 一个面板 exe/快捷方式"两条入口，现在合成**一个** `Grancache.exe`：

| 双击/命令 | 行为 |
|---|---|
| 双击（不带参数） | **打开控制面板**（Chrome `--app` 应用窗口，Ant Design 界面） |
| `--play` | 一键启动：确保缓存在后台跑 + 用带缓存的配置打开 Chrome 进游戏（= 面板里的「一键启动」按钮） |
| `--serve` / `--daemon` | 只跑代理（前台 / 后台） |
| `--stop` / `--clear-cache` / `--help` | 停止 / 清空缓存 / 说明 |
| `--panel-only` / `--panel-port=` | 只起面板服务不开窗口（自动化测试用） / 换面板端口 |
| 环境变量 `GBF_PANEL_NO_WINDOW=1` | 起面板时不自动开窗口（脚本化调用用） |

验证：起 `node src/main.js`（不带任何参数）+ `GBF_PANEL_NO_WINDOW=1`，面板接口在 18082 正常应答，而 18080 **没有**监听
—— 证明"不带参数 = 只开面板，不会偷偷把代理也拉起来"。`缓存面板.lnk` 已删除。

### 12.2 代码文件短名化（一词命名）

| 原名 | 新名 | | 原名 | 新名 |
|---|---|---|---|---|
| `tools/build-exe.ps1` | `tools/build.ps1` | | `tools/e2e.test.cjs` | `tools/e2e.cjs` |
| `tools/make-icon.ps1` | `tools/icon.ps1` | | `tools/unit.test.cjs` | `tools/unit.cjs` |
| `tools/install-ca.ps1` | `tools/trust.ps1` | | `tools/test-migration-tools.cjs` | `tools/migrate.cjs` |
| `tools/uninstall-ca.ps1` | `tools/untrust.ps1` | | `tools/test-panel.cjs` | `tools/panel.cjs` |
| `tools/setup-ca.ps1` | `tools/certs.ps1` | | `tools/test-trace.cjs` | `tools/trace.cjs` |
| `tools/pregenerate-certificates.js` | `tools/prepare.js` | | `tools/trace-report.cjs` | `tools/report.cjs` |
| `tools/migrate-cache.mjs` | `tools/migrate.mjs` | | `tools/analyze-latency.cjs` | `tools/latency.cjs` |
| `tools/import-acgpower-cache.mjs` | `tools/import.mjs` | | `tools/audit-log.cjs` | `tools/audit.cjs` |
| `tools/patch-tarou-asset-host.ps1` | `tools/patch.ps1` | | `tools/bench-latency.mjs` | `tools/bench.mjs` |
| `lib/*.js`（cache/certs/panel/policy/upstream）、`src/main.js`、`tools/bundle.mjs` | 不变（本来就是一词） | | `tools/bench-cache.mjs` | `tools/disk.mjs` |
| `ui/`（React/Vite 工程） | 不变（`index.html` / `src/main.jsx` 是工具链约定名） | | `tools/bench-proxy.mjs` | `tools/throughput.mjs` |
| | | | `tools/bench-pathcache.cjs` | `tools/micro.cjs` |
| | | | `tools/cdp-probe.mjs` | `tools/cdp.mjs` |
| | | | `tools/probe-newlog.cjs` | `tools/probe.cjs` |
| | | | `tools/proxy-e2e.mjs` | `tools/browser.mjs` |
| | | | `tools/verify-bundle.cjs` | `tools/verify.cjs` |

引用同步：29 个文件（README、计划文档、脚本之间、测试里的 spawn 参数）里的旧名已全部改写为短名。

**踩到的坑（已修）**：批量改写引用时把 `.ps1` 的 **UTF-8 BOM 去掉了**，PowerShell 5.1 于是按 ANSI 读中文 →
`UnexpectedToken`，打包脚本直接跑不起来。已给 4 个（build/certs/patch/trust）补回 BOM，并逐个做 AST 解析检查（全部 OK）。
**以后再用脚本批量改 `.ps1` 必须带 BOM。**

### 12.3 改名后的回归

| 套件（新名字） | 结果 |
|---|---|
| `node test\unit.test.cjs` / `migrate.cjs` / `verify.cjs` / `panel.cjs` / `trace.cjs` | 全部通过 |
| `node test\e2e.test.cjs`（源码） | **119/119** |
| `TARGET=exe node test\e2e.test.cjs` | **119/119** |
| `TARGET=exe PANEL_EXE=Grancache.exe node test\panel.test.cjs` | **19/19**（`inline（2 个文件）`） |
| 不带参数启动检查 | 面板 18082 可用、18080 无监听 |
