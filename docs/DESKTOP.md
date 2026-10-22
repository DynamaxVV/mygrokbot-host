# macOS 桌面端

桌面端使用 Electron 复用现有 Gateway 与 Web 界面：主进程启动后端，BrowserWindow 访问 loopback URL。安装、初始化、独立数据根和完整构建命令见[构建与启动指南](BUILD_AND_RUN.md)。

## 开发与打包

在项目根目录执行：

```bash
npm ci
node bin/mgb.mjs init --bot "Main Bot"
npm run desktop
```

已有数据可跳过 init；依赖已安装且锁文件不变时可跳过 npm ci。模型通过界面设置配置。

生成 Apple Silicon App 并打开：

```bash
npm run dist:mac -- --arm64
open "dist/mac-arm64/MyGrokbot.app"
```

生成 DMG：

```bash
npm run dist:dmg
ls -lh dist/*.dmg
```

当前 target 仅配置 arm64 DMG，不同时生成 zip。产物大小取决于本次 Electron 与源码内容，旧版本的 245 MB App / 112 MB DMG 是历史记录，不是当前构建验收。

## 运行时结构

| 部分 | 实际职责 |
|---|---|
| desktop/main.mjs | 单实例、起 Gateway、窗口、托盘和退出入口 |
| src/host.mjs | 组装执行协调、任务、工具、例行任务和 Gateway |
| src/ui/index.html | 桌面与浏览器共用界面，无单独前端构建 |
| Electron 内置 Node | 运行后端与 node:sqlite，不依赖用户终端的 Node 来运行打包 App |

本次核对的安装依赖为 Electron 45.0.0、Node 24.22.0、arm64。使用 `ELECTRON_RUN_AS_NODE=1` 完成了内存 SQLite 查询验证；这不等于本轮执行过完整 GUI 或打包验收。

启动顺序为 createHost → host.listen → BrowserWindow.loadURL。默认端口随机分配，可以用 `MGB_DESKTOP_PORT` 指定。需要在修改源码后重启开发实例，没有 HMR。

## 数据与退出

默认使用 `~/.mygrokbot`，通过绝对路径 `MGB_DATA_ROOT` 改用其他数据根。窗口关闭时隐藏到托盘，Bot、队列和例行任务仍在运行；完全停止使用托盘或应用菜单的「退出」。

Electron 使用应用单实例机制，但这不等于对 CLI/Web/launchd 的跨进程排他保护。同一个数据根选择一个执行器，不同时打开桌面版和独立 Gateway。`host.lock` 记录监听进程的 PID，不应把它视为完整分布式锁。

升级前停止旧实例，备份完整数据根。新版本恢复接纳、交互、任务与待投递记录；未知工具效果进入 needs-reconciliation，详见[执行与迁移说明](EXECUTION.md)。

## 分发配置

当前 electron-builder 配置包含 desktop、src、bin 和包元数据，使用 asar，省略测试、文档与 Markdown，保留 en/zh_CN 语言包。当前未配置正式 Apple Developer 签名与公证，未配置自定义图标；Intel 分发需要显式配置或指定 x64 target 并另行验证。

构建 App 不会自动替换 `/Applications` 中的旧版本。新产物先从 dist 启动核对，再按自己的安装方式替换；本轮文档整理没有执行打包、安装或图形界面操作。
