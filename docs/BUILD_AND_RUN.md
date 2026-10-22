# 构建、启动与升级

项目的后端和 Web 界面直接运行 JavaScript/HTML 源文件，没有单独的 `npm run build` 或前端开发服务器。日常开发使用 `npm run desktop` 或 `npm start`；分发桌面程序时才执行 Electron 打包。

本文命令以 macOS、终端位于项目根目录为前提。Node 建议使用 24 或更新版本，并确认 `node:sqlite` 可用。当前验证环境是 Node 26.5.0；桌面依赖 Electron 45.0.0 自带 Node 24.22.0。Apple Silicon 是当前配置的桌面打包目标。

## 安装依赖

在本机 checkout 中：

```bash
cd /Users/vv/Code/opengrok/mygrokbot
node --version
npm ci
```

`npm ci` 按锁文件安装，包括开发所需的 Electron 和 electron-builder。首次安装可能下载 Electron 二进制。已经安装依赖且锁文件未变化时，可以直接进入启动步骤。构建桌面端需要 devDependencies，不使用 `--omit=dev`。

源码 CLI/Web 使用终端的 Node；桌面版使用 Electron 内置的 Node。两者运行时独立。

## 首次初始化

第一次使用当前数据根时创建 Bot：

```bash
node bin/mgb.mjs init --bot "Main Bot"
node bin/mgb.mjs doctor
```

`init` 创建数据目录、默认 Bot 和模型绑定，不调用外部模型。已有数据根可跳过初始化。启动界面后在「设置 → 模型接入」中配置实际 Base URL、模型和 API Key；界面可先启动，模型连接配好后再发送任务。

默认数据根是 `~/.mygrokbot`，共享工作区是该目录下的 `workspace/`。需要隔离开发数据时，在初始化和启动命令之前设置同一个绝对路径：

```bash
export MGB_DATA_ROOT="$HOME/.mygrokbot-dev"
node bin/mgb.mjs init --bot "Main Bot"
```

`MGB_DATA_ROOT` 只接受绝对路径。换到新终端后需要重新设置，或使用命令前缀传入。桌面版与 CLI/Web 每个数据根只运行一个执行器；Electron 的单实例机制不负责阻止独立 CLI 进程。

## 启动桌面开发版

```bash
npm run desktop
```

Electron 主进程启动本地 Gateway，再打开窗口。默认使用系统分配的 loopback 端口，通常无需手工配置。

使用独立开发数据与固定桌面端口：

```bash
MGB_DATA_ROOT="$HOME/.mygrokbot-dev" MGB_DESKTOP_PORT=8898 npm run desktop
```

这要求该数据根已经初始化，或在界面中新建 Bot。关闭窗口会隐藏到托盘，退出程序使用托盘或应用菜单的「退出」。修改源码后重启开发版；这里只是普通 Electron 启动，没有 HMR。

## 启动 Web/Gateway

```bash
npm start -- --host 127.0.0.1 --port 8899
```

浏览器访问 `http://127.0.0.1:8899/`。默认 loopback 模式不要求 token，`Ctrl+C` 请求关闭 Gateway 与当前执行。若省略 `--port`，端口由系统分配，终端会打印实际 URL。

查看服务状态：

```bash
curl --fail-with-body --silent --show-error http://127.0.0.1:8899/health
```

桌面版自己已经启动 Gateway。使用同一数据根时，桌面开发版、打包 App、Web/Gateway、launchd 常驻服务选择一种运行方式。

## 使用 CLI

本地 checkout 无需把 `mgb` 安装进 PATH：

```bash
node bin/mgb.mjs --help
node bin/mgb.mjs agents ls
node bin/mgb.mjs tail "Main Bot" --limit 20
```

也可以通过 npm 转发：

```bash
npm run cli -- agents ls
npm run cli -- tail "Main Bot" --limit 20
```

只读检查不会恢复后台执行。`prompt`、`verify`、例行任务执行等命令会启动本地工作，应在同一数据根的其他执行器停止后使用：

```bash
node bin/mgb.mjs prompt "Main Bot" "请说明当前工作区的目录结构"
```

## 打包 macOS App

只生成可运行的 `.app`：

```bash
npm run dist:mac -- --arm64
```

当前 Apple Silicon 产物位于 `dist/mac-arm64/MyGrokbot.app`。构建结束后启动：

```bash
open "dist/mac-arm64/MyGrokbot.app"
```

使用隔离数据根启动构建产物，可以直接执行 App 的主程序：

```bash
MGB_DATA_ROOT="$HOME/.mygrokbot-dev" "dist/mac-arm64/MyGrokbot.app/Contents/MacOS/MyGrokbot"
```

打包 DMG：

```bash
npm run dist:dmg
```

当前配置生成 `dist/` 下的 arm64 `.dmg`，不额外生成 zip。实际文件名包含产品名、版本与架构，可查看：

```bash
ls -lh dist/*.dmg
```

打包读取 `package.json` 的 `build` 配置，包含 `desktop/`、`src/`、`bin/` 与包元数据；测试、文档和 Markdown 不进入 App。当前没有正式开发者签名与公证配置。历史产物大小不代表本轮构建大小，构建后以实际文件为准。

## 验证与排错

离线验证：

```bash
env -u MGB_REAL_BASE -u MGB_REAL_KEY npm test
```

P0/P1 交付基线为 174 项：171 通过、3 项真实模型测试跳过。当前命令明确清除真实模型 opt-in 环境变量；普通 `npm test` 在没有这两个变量时同样离线运行。

| 现象 | 检查方法 |
|---|---|
| `No such built-in module: node:sqlite` | 升级终端 Node 至 24 或更新版本；不要把系统旧 Node 与 Electron 内置 Node 混为一谈 |
| `electron: command not found` | 在项目根执行 `npm ci`，不要省略 devDependencies |
| Gateway 报没有 Bot | 对同一个 `MGB_DATA_ROOT` 先执行 `init` |
| 端口被占用 | 停止占用该端口的本项目实例，或修改 `--port` / `MGB_DESKTOP_PORT` |
| 打开后历史不一致 | 检查是否用了另一个数据根，或仍有旧 App/launchd 实例在运行 |
| 模型报缺少密钥或连接失败 | 在界面检查模型、Base URL、API Key；`doctor` 检查绑定与布局，不替代真实模型请求 |
| 出现 `needs-reconciliation` | 按[核心功能指南](CORE_FEATURES.md)核对旧工具实际结果，避免把未知副作用当成未执行 |

升级前停止旧执行器并备份完整数据根；新版本会保存 Transcript 迁移备份。回退时使用一致的数据根快照，不单独删除 `execution.db` 或拷贝正在写入的 SQLite 主文件。迁移细节见 [EXECUTION.md](EXECUTION.md)。

## 本次命令核对范围

已核对 npm scripts、CLI help、electron-builder 26.15.3，以及 Electron 45.0.0/Node 24.22.0 的内存 SQLite 查询。另外在隔离临时数据根实跑 init、doctor、agents ls、Gateway 启动、health、listTasks 和 SIGTERM 退出，均通过；[命令核验记录](../analysis/documentation-validation/commands.json)保留实际结果。本轮文档更新没有重新下载依赖、打包 DMG、启动图形窗口或替换已安装 App。
