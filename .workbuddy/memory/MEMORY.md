# gbf-cache-proxy 项目笔记

Windows 上给碧蓝幻想用的本地 HTTPS 缓存代理（MITM 解 TLS + 磁盘素材缓存）。
出口交给 0dcloud 的本机端口（自动探测，失败 5 次会重探）。

## 最重要的约定

- **改了 `src/main.js` / `lib/` 之后必须重新打包**，否则 exe 里还是旧代码。
  exe 由 `tools/build.ps1` 用 Node SEA 打包，跑的是内联后的 `build/bundle.js`。
- 重建 exe 时沿用**系统 node `C:\Program Files\nodejs\node.exe`（v24.15.0）**，
  换成别的版本会引入行为差异。**注意：跑 `build.ps1` 前必须把这个目录加进 PATH**，
  否则脚本里的 `node` 找不到。
  体积基准：改插桩前 exe 92184576 / blob 78859；插桩后 exe **92197376** / blob **91721**。
- **本机工具环境有两个坑（遇到别慌）**：
  1. Bash 工具的 PATH 可能被污染，`ls`/`grep`/`head`/`sleep`/`dirname` 全
     `command not found` → 改用 `"/c/Program Files/nodejs/node.exe" -e "..."` 包一层跑。
  2. PowerShell 工具的输出常被吞（exit 0 无 stdout）→ 写临时文件（`logs\_xxx.txt`）再用
     Read 读；PS 5.1 用 `Tee-Object` 写的是 UTF-16LE，Read 会误判为 binary，需 node 解码。
- 仓库**没有 git**。改源码前先手动备份（之前放在 `.backup-orig/`）。
- **不要在工具环境里"启动"这个 exe 来长期运行**：`spawn(detached)` / `Start-Process` 虽然
  能成功监听 18080/18081，但命令一结束整棵子进程树就被回收强杀
  （`process.on('exit')` 不执行、pid 文件残留）。调试用 `--serve` 前台跑 + 临时
  `GBF_CACHE_HOME` 目录；长期运行**必须由用户双击 `Grancache.exe`**
  （双击走 `playMode()`：自动后台拉起 daemon + 用 PAC 打开 Chrome）。
- **打包必须停代理**：`build.ps1` 最后会覆盖根目录的 `Grancache.exe`，
  文件被占用会失败。所以重打包前必须先 `--stop`，需征得用户同意（他在玩游戏时别停）。
- **不要用 agent-browser 的独立 Chromium 代替用户 Chrome 做测试**：没有登录态、
  进不去副本。用户明确禁止。测时延改用 `bench.mjs` 复刻请求，
  或让用户在自己 Chrome 里操作、我们读代理日志。
- 判断代理是否真在运行，看 `netstat` 的 LISTENING + `tasklist` 里的 `Grancache.exe`，
  **不要只看 pid 文件**（强杀后 pid 文件会残留，是个死号）。
- 缓存键 = `sha256(method + url + accept-encoding 桶)`，见 `src/cache.js` 的 `key()`。
  accept-encoding 归一成 gzip / br / identity 三个桶，避免同一素材存多份。
- `src/cache.js` 的 `index` 是 Map，**插入顺序即 LRU 顺序**：`get`/`set` 都必须先 delete 再 set。
- 响应是**先回浏览器、后异步落盘**的，所以同一个 key 可能被并发写入 →
  写入必须走 `_pendingWrites` 串行化，并且 `.tmp` 文件名唯一。
- 动态接口（`/rest/`、`.json`、`.html`、带 Set-Cookie、`text/html`）一律透传，绝不缓存。

## 定位"越玩越卡"的排查清单

1. 缓存索引是否全量驻留内存，淘汰是否 `[...entries()].sort()` 全量排序（应为 O(k) 的 LRU Map）
2. 读热路径上是否做了全量 sha256 / 全量读盘校验
3. 是否有同步 fs 调用卡事件循环（`fs.writeFileSync`，`apiDumpPatterns` 就是这种）
4. 有没有"失败 3 次就拉黑整个主机"的放大逻辑（一个抖动 = 整个 CDN 30 秒全 502）
5. `http.Server` 的 `keepAliveTimeout` 是否和浏览器连接池对不上
   （Node 默认 5 秒，Chrome 保留几分钟 → 每次复用都是死连接，白白多一趟往返）
6. 上游 keep-alive 长连接有没有"半死连接复用"的重试
7. 日志是否只增不减（`logRequests` 会记每一次命中）
8. 每个请求是否重复编译正则 / 重复做本可缓存的常量级处理

## 测试脚本（都在 `tools/`，用临时目录，不碰 `D:/gbf-cache` 和真实 config.json）

- `unit.cjs`：离线验证 LRU 顺序 / 淘汰水位 / 截断容错 / 重启后 LRU 恢复
- `e2e.cjs`：起本地 mock 源站验证 MISS→HIT、gzip 分桶、`/rest/` 透传、
  上游掐断后的自动重试、STORE-ERROR 不出现。`TARGET=exe` 可直接测打包出的 exe
- `bench.mjs`：端到端时延基准（min/p50/p90/max/sd），加 `direct` 做直连对照
- `latency.cjs`：从 proxy.log 做卡顿归因。输出各阶段 p50/p90/p99/max、
  新建 vs 复用对比、按主机分组、最慢 15 条、**聚集性检验**（区分自身并发 vs 上游变慢）
- `probe.cjs`：临时目录起代理发真实请求，快速确认日志格式

## 日志字段（新版 exe 才有，用于定位卡在哪一段）

每行请求日志末尾：`| conn=125 up=227 ttfb=227 body=41 total=268 newconn in3`
- `conn` 仅新建连接时出现（TCP+TLS）；`newconn`/`reuse` 差值 100-250ms，**最该盯**
- `retryN` 连接半死重试次数；`inN` 发起时在途数（高 = 可能撞限速）
- HIT 行 `| cache=0 total=1 ^N`；STORE 行附加 `store=`
- `/stats` 的 `latency` 段有分阶段 p50/p90/p99/max + reuse/newConn/retries/inflight
- 每 60 秒一行 `[latency]` 聚合日志

**判断 exe 是不是新版**：日志行尾有 `| conn=` 或 `/stats` 有 `latency` 段。
`build/bundle.js` 新但 `sea-prep.blob` / exe 旧 = 忘了打包（blob 可明文搜函数名验证）。

## 卡顿归因（用 `tools/latency.cjs`，已实测验证）

**判读口诀**：
- `conn` 高、`up` 不高 → 建连慢（出口节点握手问题）
- `conn` 正常、`up` 高 → 发出去等响应慢（上游服务器或出口排队）
- 慢请求和快请求的并发环境差不多 → **代理侧改不了**，只能换节点
- 慢请求明显扎堆在请求多的时刻 → 可考虑压低并发

**最重要的判据（比 p90/max 更能说明问题）**：
统计「单次刷新的墙钟耗时 vs 各请求耗时之和」（用请求间隔 >3s 切分刷新）。
- 两者接近 → 游戏**串行**发请求，卡 = 几十次往返累加
- 墙钟远小于和 → 并发良好

实测：17:46:35 那次刷新 **109 个请求，墙钟 36.3s，耗时之和 38.2s** ——
基本相等，证明是串行累加。

**实测结论（2026-09，266 条真实游戏请求）**：
- 代理自身不是瓶颈：`cache` p50=p90=2ms，`store` p50=3ms
- 新建 vs 复用差 3 倍以上：新建 (32条) total p50=497ms，复用 (207条) p50=169ms
- **裸链路很稳**（绕过代理直连 0dcloud→日服，12 次）：
  CONNECT 0-2ms / TLS 110-128ms / 首字节 107-166ms /
  总计 **p50 229ms, p90 278ms, max 565ms**（只 1 次抖动）
- **不是"并发压垮自己"**：慢请求出现时前后 1.5s 请求数 14.5，快请求 10.9。
  旧结论"并发建连触发限速"已被数据推翻。
- 个别聚合接口服务端慢：`/party/deck/182` 是 `conn=110 up=9065`，
  同批同主机的 `/deckcombination/...` 只要 609ms → 是游戏服务端的问题
- **核心结论**：卡 = 40-109 次**串行**往返的累加（每次 200-300ms），
  而这些请求全是不可缓存的动态接口。**代理缓存的素材本来就不阻塞界面，
  真正阻塞界面的动态接口恰恰不能缓存 → "再加缓存"救不了这个卡。**
  代理已到极限，想更快只能降低单次 RTT（换节点）。

**注意**：`maxFreeSockets` 是 **per-host** 语义（freeSockets 按 host 分桶），不是全局。

## 已修复的坑（别改回去）

- `apiDumpPatterns` 平时必须留空：填了会把游戏接口响应同步写盘，直接卡事件循环
- `verifyIntegrity` 默认 false：每次命中重算 sha256 会随命中量线性拖慢
- 失败快速拉黑只对 `ENOTFOUND` / `EAI_AGAIN` 生效，且跳过素材 CDN 主机
- `--stop` 会先用 tasklist 确认 pid 确实是本程序，避免 pid 被复用后误杀别的进程
