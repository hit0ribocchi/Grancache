# Grancache

> **碧蓝幻想（Granblue Fantasy）本地素材缓存代理** —— 把游戏素材缓存在本机硬盘，第二次进游戏直接读本地，不再回源；附带一个图形控制面板，一键开关。
>
> A local asset cache proxy for Granblue Fantasy with a GUI control panel. **Windows only.**

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![last-commit](https://img.shields.io/github/last-commit/hit0ribocchi/Grancache?color=0078D4)
![repo-size](https://img.shields.io/github/repo-size/hit0ribocchi/Grancache?color=0078D4)
![license](https://img.shields.io/badge/license-MIT-green)

把碧蓝幻想（GBF）的游戏素材缓存到本机，第二次进游戏直接读本地；附带一个图形控制面板，一键开关。

## 特性

- **素材缓存**：重复加载的素材由本机直接返回，不再回源
- **魔改覆盖**：把 `原名_ap.后缀` 放进缓存目录即优先返回，清缓存也会保留
- **不缓存账号数据**：动态接口与账号相关响应不进入缓存
- **图形控制面板**：一键启动（缓存 + Chrome + 游戏），也能单独开关缓存
- **实时可观测**：命中率、缓存占用、实时日志；`npm run report` 给出「先 MISS 后 HIT」「从未命中」等追踪报告
- **日志分轮归档**：每轮启动新开日志，上一轮自动归档（默认留 10 轮）

## 快速开始

1. **取得 `Grancache.exe`** —— 本项目不提供预编译包，从源码构建即可（见 [从源码构建](#从源码构建)），产物就只有这一个 exe；
2. 把它放到一个固定目录（运行期数据会生成在同目录的 `runtime\` 下），**直接双击运行** —— 打开控制面板；
3. 面板里点 **「一键启动（缓存 + Chrome + 游戏）」**：缓存在后台跑起来，并用带缓存配置的 Chrome 打开游戏。

不想开面板时，命令行也能用：`Grancache.exe --play` 一键进游戏，`Grancache.exe --stop` 停止缓存。

### 首次运行与本地 CA

首次启动会自动生成一张本机 CA，并装进 **「当前用户 → 受信任的根证书颁发机构」**（不需要管理员权限）。想关掉自动信任就设 `"autoTrustCa": false`，再手工执行 `scripts\certs.ps1` 与 `scripts\trust.ps1`；完全恢复用 `scripts\untrust.ps1` 并删除 `runtime\certs`。

## 命令行

| 命令 | 作用 |
|---|---|
| `Grancache.exe` | 打开控制面板（默认行为，双击即此） |
| `Grancache.exe --play` | 一键启动：确保缓存在跑 + 用带缓存配置打开 Chrome 进游戏 |
| `Grancache.exe --stop` | 停止后台代理（有 pid 归属校验，不会误杀） |
| `Grancache.exe --clear-cache` | 清空素材缓存（保留 `_ap` 魔改文件） |
| `Grancache.exe --serve` / `--daemon` | 只跑缓存代理（前台带日志 / 后台无窗口） |
| `Grancache.exe --port=18080` | 换代理端口（统计端口自动 = 端口 + 1） |
| `Grancache.exe --help` | 查看全部选项 |

全部选项、配置项与调优方法见 [docs/usage.md](docs/usage.md)。

## 从源码构建

要求：Windows 10/11、**Node ≥ 22**（打包 exe 用 24）、Chrome。缓存代理本体不依赖任何第三方 npm 包。

```powershell
git clone https://github.com/hit0ribocchi/Grancache.git
cd Grancache

npm start            # 打开控制面板（源码模式）
npm run serve        # 只跑代理（前台，看日志）
npm test             # 全量测试（unit / verify / migrate / trace / panel / e2e）

npm run build        # 打包成 Grancache.exe（Node SEA；需要联网拉 postject/rcedit）
npm run ui           # 改了面板界面后重建（首次需 npm --prefix ui install）
```

## 文档

- [**docs/usage.md**](docs/usage.md) —— 使用说明：工作原理、缓存目录、全部配置项、日志与调优、常见问题、迁移与导入
- [docs/plan-acgpower-cache-mvp.md](docs/plan-acgpower-cache-mvp.md) —— 设计与实施记录

## 常见问题

- **命中率不高？** 界面卡顿主要来自不可缓存的动态接口，素材缓存只加速素材；`npm run report` 能看清哪些请求按设计就是透传的。
- **魔改文件放了没生效？** 浏览器自己那份缓存会先命中，放好文件后在游戏里按一次 **Ctrl+F5**。
- **Chrome 必须先退出？** 是。Chrome 只在启动那一刻读代理设置，「一键启动」会先检查，请完全退出（含托盘）再点。

更多问题见 [docs/usage.md#常见问题](docs/usage.md#常见问题)。

## 已知问题

- **只加速素材**，不会降低战斗 / 界面的延迟 —— 那部分是不可缓存的动态接口往返。
- **Windows 专用**：依赖 PowerShell 脚本、SEA exe 与 Chrome 的启动方式。
- 首次进游戏仍需联网下载素材；缓存包可以跨机器拷贝。

## 安全与隐私

- 代理需要在本机解开 HTTPS（MITM）—— 这是缓存素材的前提。CA 只装在你自己的 Windows 账户下，**私钥在 `runtime\certs\`，不要外传**（仓库已 gitignore，绝不入库）。
- **账号数据不缓存**：`/rest/` 等动态接口、带 `Set-Cookie` 的响应一律原样透传。
- **日志脱敏**：`uid` / `token` / `session` 等查询参数的值在日志中掩码为 `***`；Cookie、Authorization、请求体从不记录。
- 控制面板的本地服务只监听 `127.0.0.1`，写操作需要一次性令牌（跨站网页调不动）。
- 魔改只改你本地看到的画面，不改变任何发往服务器的请求；是否使用请自行判断风险。

## 致谢

- **ACGPower**：路径镜像 + `.ext` 元数据 + `_ap` 魔改约定的参考（按公开行为分析实现，未使用其代码）。
- **nginx** `proxy_cache`：`inactive` 闲置淘汰与 `use_stale` 的语义参考。
- **太郎（Tarou）** 插件：素材域名补丁脚本（`scripts\patch.ps1`）。

## 许可

本项目以 [MIT 许可证](LICENSE) 开源。
