# Grancache

> **碧蓝幻想（Granblue Fantasy）的本地素材缓存代理** —— 把游戏素材缓存在本机硬盘，第二次进游戏直接读本地、不再回源；带一个图形控制面板，一键开关。
>
> A local asset cache proxy with a GUI control panel for Granblue Fantasy. **Windows only.**

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![license](https://img.shields.io/badge/license-%E6%9C%AA%E6%8C%87%E5%AE%9A-lightgrey)

Grancache 在本机跑一个 HTTPS 缓存代理，Chrome 通过它访问游戏：可缓存的**静态素材**（图片 / 音频 / 字体 / 二进制等）会落盘到本机，之后重复加载直接命中本地；**动态接口**（`/rest/`、`.json`、`.html`、带 `Set-Cookie`）一律原样透传，绝不缓存。出站请求仍走你本机已有的网络出口，不需要改动网络设置。

## 快速开始

**准备**：Windows 10/11 + Chrome，一个能正常访问游戏的网络环境。

**第 1 步 · 获取** —— 二选一：

- 从 [Releases](../../releases) 下载 `Grancache.exe`（有发布时）；
- 从源码构建，见 [从源码运行](#从源码运行)。

**第 2 步 · 启动** —— 把 `Grancache.exe` 放到一个固定目录，双击打开**控制面板**。

**第 3 步 · 进游戏** —— 面板里点 **「一键启动（缓存 + Chrome + 游戏）」**：缓存在后台跑起来，并用带缓存配置的 Chrome 打开游戏。

首次启动会自动准备本地 CA：如果 `runtime\certs` 里还没有证书，Grancache 会用 openssl **现场生成**，并装进 **「当前用户 → 受信任的根证书颁发机构」**（`certutil -user`，无需管理员权限）。想关掉自动信任就设 `"autoTrustCa": false`，或手工执行：

```powershell
scripts\certs.ps1     # 生成 CA 并预生成游戏域名证书
scripts\trust.ps1     # 装进「当前用户 → 受信任的根证书颁发机构」
```

> 不想开面板：`Grancache.exe --play` 一键进游戏，`Grancache.exe --stop` 停止缓存。卸载用 `scripts\untrust.ps1`，再删掉 `runtime\certs` 即完全恢复。

## 命令行

| 命令 | 作用 |
|---|---|
| `Grancache.exe` | 打开控制面板（默认行为） |
| `Grancache.exe --play` | 一键启动：确保缓存在跑 + 用带缓存配置打开 Chrome 进游戏 |
| `Grancache.exe --stop` | 停止后台代理（有 pid 归属校验，不会误杀） |
| `Grancache.exe --clear-cache` | 清空素材缓存（保留 `_ap` 魔改文件） |
| `Grancache.exe --serve` / `--daemon` | 只跑缓存代理（前台带日志 / 后台无窗口） |
| `Grancache.exe --port=18080` | 换代理端口（统计端口自动 = 端口 + 1） |
| `Grancache.exe --help` | 查看全部选项 |

完整命令、配置项与调优说明见 [docs/usage.md](docs/usage.md)。

## 从源码运行

要求：Windows 10/11、**Node ≥ 22**（打包 exe 用 24）、Chrome。

```powershell
git clone https://github.com/hit0ribocchi/Grancache.git
cd Grancache

npm start            # 打开控制面板
npm run serve        # 只跑代理（前台，看日志）
npm test             # 全量测试（unit / verify / migrate / trace / panel / e2e）

npm run build        # 打包成 Grancache.exe（Node SEA；需要联网拉 postject/rcedit）
npm run ui           # 改了面板界面后重建（首次需 npm --prefix ui install）
```

## 文档

- [**docs/usage.md**](docs/usage.md) —— 使用说明：工作原理、缓存目录、配置项、日志与调优、常见问题、迁移与导入。
- [docs/plan-acgpower-cache-mvp.md](docs/plan-acgpower-cache-mvp.md) —— 设计与实施文档。

## 安全与隐私

- 代理需要在本机解开 HTTPS（MITM）才能按 URL 缓存素材；CA 只装在你自己的 Windows 账户下，私钥在 `runtime\certs\`（已 gitignore），**不要外传**。
- **账号数据不缓存**：`/rest/` 等动态接口、带 `Set-Cookie` 的响应一律原样透传。
- **日志脱敏**：`uid`/`token`/`session` 等查询参数的值掩码为 `***`；Cookie、Authorization、请求体从不记录。
- 控制面板只监听 `127.0.0.1`，写操作需要一次性令牌。

## 致谢

- **ACGPower**：路径镜像 + `.ext` 元数据 + `_ap` 魔改约定（按公开行为实现，未使用其代码）。
- **nginx** `proxy_cache`：`inactive` 闲置淘汰与 `use_stale` 的语义参考。

## 许可

暂未指定许可证（仓库默认可看不可用）。如需公开复用，欢迎开 Issue 讨论补一份 MIT。
