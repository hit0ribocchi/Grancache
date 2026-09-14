# Grancache

> 碧蓝幻想（Granblue Fantasy）的本地素材缓存代理，带图形控制面板。仅支持 Windows。

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![node](https://img.shields.io/badge/node-%E2%89%A522-339933)
![release](https://img.shields.io/github/v/release/hit0ribocchi/Grancache?color=0078D4)
![downloads](https://img.shields.io/github/downloads/hit0ribocchi/Grancache/total?color=0078D4)
![license](https://img.shields.io/badge/license-MIT-green)

## 特性

- 素材缓存：重复加载的素材由本机直接返回，不再回源
- 魔改覆盖：`原名_ap.后缀` 放进缓存目录即优先返回
- 图形面板：开关缓存、一键启动、实时命中率与日志
- 命中追踪：`npm run report` 列出未命中原因与命中率

## 快速开始

从 [Releases](../../releases) 下载 `Grancache.exe`，放到任意目录，任选一种方式启动：

- **双击** → 打开控制面板，点「一键启动（缓存 + Chrome + 游戏）」；
- **命令行** → `Grancache.exe --play` 起缓存并进游戏，`Grancache.exe --panel` 只打开面板。

首次运行会自动生成并信任本地 CA，不需要管理员权限。

## 命令行

| 命令 | 作用 |
|---|---|
| `Grancache.exe` | 打开控制面板 |
| `--play` | 起缓存 + 打开 Chrome 进游戏 |
| `--stop` | 停止后台代理 |
| `--clear-cache` | 清空素材缓存 |
| `--serve` | 前台跑缓存代理，日志打在终端 |
| `--daemon` | 后台跑缓存代理，无窗口，日志写文件 |
| `--port=18080` | 换端口 |
| `--help` | 查看全部选项 |

## 从源码构建

要求：Windows 10/11、Node ≥ 22、Chrome。

```powershell
npm start        # 打开控制面板
npm run serve    # 只跑代理
npm test         # 全量测试
npm run build    # 打包成 Grancache.exe
npm run ui       # 重建面板界面
```

## 文档

- [docs/usage.md](docs/usage.md) —— 配置项、日志与调优、常见问题、迁移
- [docs/plan-acgpower-cache-mvp.md](docs/plan-acgpower-cache-mvp.md) —— 设计与实施记录

## 常见问题

- **魔改文件没生效？** 浏览器缓存会先命中，放好后在游戏里按一次 **Ctrl+F5**。
- **Chrome 必须先退出？** 是，Chrome 只在启动时读代理设置。
- **想看哪些素材没命中？** 跑 `npm run report`。

## 已知问题

- 只加速素材，不降低战斗与界面的延迟。
- 首次进游戏仍需联网下载素材。

## 安全与隐私

- CA 私钥在 `runtime\certs\`，只装在你自己的 Windows 账户下，不要外传；不用了跑 `scripts\untrust.ps1` 并删除该目录。
- 动态接口与账号相关响应一律原样透传，不缓存。
- 日志中 `uid` / `token` / `session` 等参数值掩码为 `***`；Cookie、Authorization、请求体不记录。
- 面板只监听 `127.0.0.1`，写操作需要一次性令牌。

## 致谢

- **ACGPower**：路径镜像、`.ext` 元数据与 `_ap` 魔改约定的参考。
- **nginx** `proxy_cache`：`inactive` 与 `use_stale` 语义参考。

## 许可

[MIT](LICENSE)
