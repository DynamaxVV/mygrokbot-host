# 桌面端（macOS）

用 Electron 把现有的 Web 客户端包成一个 .app。**没有第二套后端**：Electron 主进程就是
运行 gateway 的那个 Node，所以不存在 sidecar、IPC 桥或端口握手。

## 为什么能这样

后端依赖 `node:sqlite` 的 `DatabaseSync`，这是 Node 22.5 引入、24 才稳定的内置模块。
实测确认：

```
Electron 45.0.0  →  Node 24.22.0
node:sqlite      →  建表 / 插入 / 查询 全部可用
```

Electron 41 起都带 Node 24，所以主进程可以直接 `import { createHost }`。

## 结构

```
desktop/main.mjs        Electron 主进程：起服务 → 开窗口 → 托盘
src/**                  后端（原样复用）
src/ui/**              Web 客户端（原样复用）
```

启动流程：

1. `createHost()` 打开数据根（默认 `~/.mygrokbot`）
2. `gateway.listen({ port: 0, host: '127.0.0.1' })` —— 端口由系统分配
3. `BrowserWindow.loadURL('http://127.0.0.1:<port>/')`
4. 托盘常驻；关窗口不退出（routines 与队列需要进程活着）

## 命令

```bash
npm run desktop     # 开发模式直接跑
npm run dist:mac    # 只出 .app（dist/mac-arm64/MyGrokbot.app）
npm run dist:dmg    # 出 DMG + zip
```

## 体积

| 项 | 大小 |
| --- | --- |
| `MyGrokbot.app` | **245 MB** |
| DMG | **112 MB** |
| zip | 112 MB |
| 其中我们的代码（asar） | ~1.2 MB |

244 MB 是 Electron 框架本体（Chromium + V8），无法通过配置继续压缩。已经做的裁剪：

- `electronLanguages: ['en', 'zh_CN']` —— 只留两个语言包
- `asar: true` —— 代码打包成单文件
- `files` 白名单 —— 只打 `desktop/`、`src/`、`bin/`、`package.json`，不含 tests、docs、`.md`

如果将来体积成为硬指标，唯一有效的路径是换 Tauri（壳 ~15 MB）并把后端编成 Node SEA
单文件，架构见 [../README.md](../README.md) 的讨论记录。

## 分发

打包时 `identity: null`，所以是 **ad-hoc 签名 + 未公证**。任何 arm64 Mac 都能运行，但
首次打开会被 Gatekeeper 拦一次。接收方二选一：

```bash
# 方式一：右键 App → 打开 → 再点「打开」
# 方式二：去掉隔离属性
xattr -dr com.apple.quarantine /Applications/MyGrokbot.app
```

如果对方要求“双击即开”，就需要 Apple Developer 账号做正式签名 + 公证。

## 已知限制

- **不能上 Mac App Store**：`shell` 工具执行 `/bin/sh -lc`，沙箱会直接拒绝。
- 未打包图标，用的是 Electron 默认图标（`build.mac.icon` 留空）。
- 只有 arm64 target；要 Intel 版在 `build.mac.target.arch` 里加 `x64`。

## 与 launchd 的关系

两种启动方式二选一，不要同时开 —— 它们抢同一个数据根（`host.lock`、SQLite 句柄）。

- **桌面版**：自己起 gateway，点托盘退出才释放
- **launchd**：后台常驻，浏览器访问 8899

同时用会看到 `host.lock` 冲突。桌面版优先时先 `launchctl unload`。
