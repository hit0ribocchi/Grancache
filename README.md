# Grancache

> 碧蓝幻想（Granblue Fantasy）的本地素材缓存代理，带图形控制面板。
>
> A local asset cache proxy for Granblue Fantasy with a GUI control panel. **Windows only.**

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![last-commit](https://img.shields.io/github/last-commit/hit0ribocchi/Grancache?color=0078D4)
![repo-size](https://img.shields.io/github/repo-size/hit0ribocchi/Grancache?color=0078D4)
![license](https://img.shields.io/badge/license-MIT-green)

## 特性

- **素材缓存**：重复加载的素材由本机直接返回，不再回源
- **魔改覆盖**：`原名_ap.后缀` 放进缓存目录即优先返回，清缓存也会保留
- **图形控制面板**：开关缓存，或一键启动缓存 + Chrome + 游戏
- **可观测**：命中率、缓存占用、实时日志，`npm run report` 给出「先 MISS 后 HIT」「从未命中」等追踪；日志按轮归档，上一轮自动进 `prev\`（默认留 10 轮）

## 快速开始

1. 构建 `Grancache.exe`（见 [从源码构建](#从源码构建)，本项目不提供预编译包）；
2. 放到固定目录（运行期数据生成在同目录的 `runtime\` 下），**双击运行**，打开控制面板；
3. 点 **「一键启动（缓存 + Chrome + 游戏）」**。

首次运行会自动生成本地 CA 并装进 **「当前用户 → 受信任的根证书颁发机构」**（无需管理员权限）。关掉自动信任：设 `"autoTrustCa": false`；完全恢复：`scripts\untrust.ps1` 加删除 `runtime\certs`。

## 命令行

| 命令 | 作用 |
|---|---|
| `Grancache.exe` | 打开控制面板（双击即此） |
| `Grancache.exe --play` | 确保缓存在跑 + 打开 Chrome 进游戏 |
| `Grancache.exe --stop` | 停止后台代理（有 pid 归属校验，不会误杀） |
| `Grancache.exe --clear-cache` | 清空素材缓存（保留 `_ap` 魔改文件） |
| `Grancache.exe --serve` / `--daemon` | 只跑缓存代理（前台带日志 / 后台无窗口） |
| `Grancache.exe --port=18080` | 换代理端口（统计端口 = 端口 + 1） |
| `Grancache.exe --help` | 查看全部选项 |

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

- **想看看哪些素材没命中？** `npm run report` 会列出「先 MISS 后 HIT」「从未命中」和每条未命中原因。
- **魔改文件放了没生效？** 浏览器自己那份缓存会先命中，放好文件后在游戏里按一次 **Ctrl+F5**。
- **Chrome 必须先退出？** 是。Chrome 只在启动那一刻读代理设置，请完全退出（含托盘）再点「一键启动」。

## 已知问题

- 只加速素材，不会降低战斗 / 界面的延迟。
- 首次进游戏仍需联网下载素材；缓存包可以跨机器拷贝。

## 安全与隐私

- 代理需要在本机解开 HTTPS（MITM）—— 这是缓存素材的前提。CA 只装在你自己的 Windows 账户下，**私钥在 `runtime\certs\`，不要外传**（已 gitignore，绝不入库）。
- **账号数据不缓存**：动态接口与账号相关响应一律原样透传。
- **日志脱敏**：`uid` / `token` / `session` 等查询参数的值掩码为 `***`；Cookie、Authorization、请求体从不记录。
- 面板的本地服务只监听 `127.0.0.1`，写操作需要一次性令牌。
- 魔改只改你本地看到的画面，不改变发往服务器的请求；是否使用请自行判断风险。

## 致谢

- **ACGPower**：路径镜像 + `.ext` 元数据 + `_ap` 魔改约定的参考（按公开行为分析实现，未使用其代码）。
- **nginx** `proxy_cache`：`inactive` 闲置淘汰与 `use_stale` 的语义参考。
- **太郎（Tarou）** 插件：素材域名补丁脚本（`scripts\patch.ps1`）。

## 许可

本项目以 [MIT 许可证](LICENSE) 开源。
