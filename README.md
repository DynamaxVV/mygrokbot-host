# MyGrokbot

> **许可：GPL-3.0**（[LICENSE](LICENSE)）。界面规则与布局常量移植自 [Telegram Web K](https://github.com/morethanwords/tweb)（同为 GPL-3.0），逐条记录在 [docs/UI.md](docs/UI.md)。

个人自建的 **Grok-Bot 形态**工作台：多 Bot 名册、按回合流式推理、有审批的本地工具、持久记忆、技能目录、例行任务、本机 Gateway（HTTP RPC + SSE + Web 客户端）。

它照着两台机器上真实跑过的东西重建：`sand-d.tar.gz`（云电脑 `sand-data` 快照）与 `grokbot-analysis.tar.gz`（30MB host bundle + 旧注入代码）。重建的是**协议与数据形状**，不是 bundle 注入 —— 为什么不能注入，见 [docs/PARITY.md](docs/PARITY.md)。

## 文档入口

- [构建与启动](docs/BUILD_AND_RUN.md)：依赖、初始化、桌面/Web 启动、App/DMG 打包与升级。
- [核心功能使用](docs/CORE_FEATURES.md)：群聊、可靠派工、审批问答、停止与任务查询。
- [执行协议与迁移](docs/EXECUTION.md)：Run/Segment、会话隔离、持久恢复和数据迁移。
- [P0/P1 实施交付](docs/2026-10-22_p0-p1-implementation.md)：修复对应关系与已完成验证。

## 结构与职责

```text
你 / Web / CLI
      │  HTTP JSON-RPC  POST /api/<method>   GET /events (SSE)
      ▼
Gateway   ⇄   TurnEngine   ⇄   Provider transport (OpenAI-compatible SSE)
                │  │  │
                │  │  └─ ToolRuntime   本地 shell / 文件 / memory / skill / 跨 bot 派工
                │  └──── 审批闸门        未批准的副作用不执行
                └─────── AgentStore      SQLite：transcript_entries 是唯一真相
```

当前实现遵循三条执行规则：

1. **接纳与执行分离。** `sendPrompt` 立刻返回 acceptance（含 `clientNonce`），回合在后台跑，进度走 SSE。同 nonce 重投返回同一条 acceptance。
2. **先持久接纳和恢复点。** execution.db 保存接纳、Run、交互、任务和待投递记录；Transcript 保存分会话历史。崩溃前已经开始且效果未知的工具进入待核对，不自动重放。
3. **审批是 entry，不是弹窗。** 需要批准的命令把回合停下，批准后执行**同一条命令**并继续，拒绝则写 `denied` 且不执行。

## 快速开始

建议使用 Node 24 或更新版本；当前验证版本为 Node 26.5.0。项目直接运行源码，无独立 `npm run build`。

```bash
cd /Users/vv/Code/opengrok/mygrokbot
npm ci
node bin/mgb.mjs init --bot "Main Bot"
npm run desktop
```

已有数据根可跳过 init；依赖已安装且锁文件不变时可跳过 npm ci。打开界面后，在设置的模型接入页配置实际模型、Base URL 和 API Key。

启动浏览器/Web 版时，停止同数据根的桌面实例，然后运行：

```bash
npm start -- --host 127.0.0.1 --port 8899
```

浏览器打开 `http://127.0.0.1:8899/`。默认数据根是 `~/.mygrokbot`；开发时可设置 `MGB_DATA_ROOT="$HOME/.mygrokbot-dev"` 后再初始化和启动。

CLI 无需全局安装：

```bash
node bin/mgb.mjs --help
node bin/mgb.mjs doctor
node bin/mgb.mjs agents ls
node bin/mgb.mjs tail "Main Bot" --limit 20
```

本文其他地方的 `mgb` 是 `node bin/mgb.mjs` 的简写。会执行工作的 prompt/verify/routine 命令与桌面/Web 共享数据根时，应先停止其他执行器。

离线回归：

```bash
env -u MGB_REAL_BASE -u MGB_REAL_KEY npm test
```

P0/P1 交付记录为 174 项：171 通过、3 项真实模型测试按 opt-in 规则跳过。真实模型验证见 [LIVE.md](docs/LIVE.md)，构建与启动的完整流程见 [BUILD_AND_RUN.md](docs/BUILD_AND_RUN.md)。

## 目录

```
mygrokbot/
├── bin/mgb.mjs                  CLI（init/doctor/serve/prompt/tail/agents/skill/routine/bind/policy）
├── src/
│   ├── host.mjs                 组装：数据根 + 名册 + 技能 + 工具 + 引擎 + routines + gateway
│   ├── gateway.mjs              HTTP RPC / SSE / 静态 Web，loopback + Origin 拒绝 + bearer
│   ├── engine.mjs               模型策略与来源日志；runtime.mjs 负责固定身份和执行生命周期
│   ├── runtime.mjs              固定 Run/Segment 身份、交互与恢复生命周期
│   ├── execution.mjs            主机级 SQLite 协调：接纳、状态、任务与 outbox
│   ├── conversation.mjs         会话身份、显式归属和模型角色投影
│   ├── tasks.mjs                本地可靠委派、依赖、预算和父任务恢复
│   ├── db.mjs                   node:sqlite；Transcript 兼容表与会话索引
│   ├── roster.mjs               agents/<uuid>/{profile,settings,store.db,memory,automations}
│   ├── entries.mjs              entry 构造器（同一 kind 词汇）
│   ├── tools.mjs                shell/文件/memory/skill/消息与 delegate_task + 审批策略
│   ├── skills.mjs               SKILL.md frontmatter 解析 + 内置 5 个种子技能
│   ├── routines.mjs             automation.json/runs.json + 五段 cron（带时区）
│   ├── bus.mjs                  事件总线（SSE 扇出）
│   ├── acceptance.mjs           旧接纳台账兼容；execution.mjs 保存运行状态与可靠投递
│   ├── scheduler.mjs            三 lane 队列 + 每 agent 串行 + 120s/30s watchdog
│   ├── timeline.mjs             pending 发送的排序（tweb 规则 + 本项目的适用性说明）
│   ├── room.mjs                 统一群接纳、fan-out/定向/协调/轮流与精确取消
│   ├── proxy.mjs                server-agent-proxy：temporal agent 的转发与拒绝语义
│   ├── review.mjs               用户审核：NEVER/ASK/ALWAYS 上限、approved/denied/always、
│   │                            常驻规则、陈旧卡失效；有效持久交互可重启恢复
│   ├── paths.mjs                数据根解析（MGB_DATA_ROOT 覆盖）
│   ├── providers/{maps,bindings,transport}.mjs
│   └── ui/
│       ├── index.html           单文件 Web 客户端（名册 + 对话 + 审批 + 右侧信息栏）
│       └── uimap.json           真机 UI 契约（50KB：设置锚点/深链/28 commands/4 布局）
├── test/                        原有回归 + 会话/取消/持久恢复/派工独立 Mock 回归
└── docs/PARITY.md               两个包的对齐结论与不可注入证据
```

数据根默认 `~/.mygrokbot`，结构对齐 `sand-data`：

```
<root>/
├── gateway.json  host-secrets.json  host.lock  settings.json
├── execution.db                  Run、接纳、交互、任务与 outbox（含 SQLite WAL）
├── send-acceptance.json           旧接纳台账兼容诊断
├── agents/active-agent.json
├── agents/<uuid>/{profile.json,settings.json,store.db,memory/,automations/,attachments/,assets/}
├── workspace/                   一个共享工作区（= 真机 /workspace），不按 bot 隔离
├── managed-skills/{cache.json,skills/<slug>/SKILL.md}
├── logs/{local-bound-provenance.jsonl,bot-work-log.jsonl}
└── model-bindings.json  tools.json
```

**可以把它指向一份真实快照**：`MGB_DATA_ROOT=/path/to/sand-data node bin/mgb.mjs agents ls` 会列出那台机器的 9 个 bot（Nas Bot / vv Bot / Ymb Bot / Github Bot …），`tail` 能读到它们真实的 `name-changed` 历史。测试里已经这么跑过一次。

## 用户审核（auto-review）

副作用前面有一道闸门，三态而非两态：

| 解析 | 含义 |
| --- | --- |
| `approved` | 放行**这一次** |
| `denied` | 拒绝，命令不执行 |
| `always` | 放行并写入**常驻规则**，之后同一条命令不再问 |

工具权限上限（`LocalToolPermissionCeiling`）：

| ceiling | 行为 |
| --- | --- |
| `NEVER` | 直接拒，连卡片都不出 |
| `ASK` | 正常出卡（默认） |
| `ALWAYS` | 直接放行 |

两条容易漏的规则：

1. **陈旧卡片必须拒绝。** 已解析、已过期、或 `requestId` 对不上的卡片一律 `auto-review/stale`，不静默套用——否则一个旧标签页的"批准"能复活已结束的回合。
2. **启动时校验持久恢复点。** 有效的 Run/callId 绑定可以恢复；无绑定、已过期或已取消的旧卡才失效，旧标签页不会复活已停止的工作。

规则文件 `<root>/auto-review-rules.json`：

```json
{
  "version": 1,
  "isEnabled": true,
  "ceilings": { "shell": "ASK" },
  "allowInstructions": ["shell:ls*"],
  "blockInstructions": ["shell:rm -rf*"],
  "alwaysAllow": [{ "tool": "shell", "command": "echo hi", "addedAtMs": 0 }]
}
```

## 定时排程（routines）

`automation.json` 支持真机的 trigger 成员形状，包括 group：

```json
{
  "name": "Daily Digest",
  "prompt": "汇总昨天失败的任务",
  "trigger": {
    "type": "group",
    "listeners": [
      { "type": "cron", "schedule": "0 8 * * *" },
      { "type": "webhook", "source": "deploy" },
      { "type": "github", "repo": "acme/app", "events": ["push"] }
    ]
  },
  "enabled": true,
  "provenance": "user"
}
```

支持的 trigger 类型（真机同款 10 种）：`cron` / `webhook` / `email` / `slack` / `github` / `origin` / `microsoftTeams` / `linear` / `sentry` / `pagerduty`。

**本地能真正触发的只有 `cron` 和 `webhook`**；其余照实存下来并标为未接线，不会假装能跑。`mgb` 用 `getTriggerTypes` 如实报告这个边界。

## 界面

单文件 Web 客户端（`src/ui/index.html`），浅色 macOS 风格，自动跟随系统深色模式。

**消息流照 Telegram 的三层结构**，常量与规则取自 tweb 源码（GPL-3.0，逐条见 [docs/UI.md](docs/UI.md)）：

| 层 | 用于 | 表现 |
| --- | --- | --- |
| 消息 | 用户 / bot 文本 | 气泡，同发送者 5 分钟内合并（组尾才显示时间） |
| 服务消息 | `event` / `notice` | 居中灰字胶囊，无气泡（改名、过期等） |
| 系统卡片 | 审批 / 提问 / 工具 / 错误 | 带边框卡片，因为需要人动作 |

其它细节：日期分隔（Today/Yesterday）、相对时间（now/5m/14:32/Sat）、左侧名册彩色几何头像、右侧 6 个 tab、`⌘K` 命令面板（接真机 28 个命令）、`⌘⇧I` 折叠右栏。

移植的精确常量：

| 项 | 值 | 来源 |
| --- | --- | --- |
| 分组窗口 | **121 秒** | `bubbleGroups.ts: newGroupDiff = 121` |
| 气泡圆角 | **15px**（分组内侧 5px） | `_chatVariables.scss` |
| 正文 / 服务 / 时间 | **16 / 15 / 12px** | `base.scss --messages-*-text-size` |
| 时间戳位置 | 气泡内右下，带半透明底 | `.time { position:absolute; bottom:4px; right:8px }` |
| 服务胶囊 | 14px 圆角，`.28125rem .625rem` 内边距 | `.bubble.service .service-msg` |
| 发送中 | 气泡 .72 透明 + 时间槽转圈 | tweb 把时钟放在时间位 |

**pending 的定义是「尚未终结」**：`awaiting-approval` / `awaiting-answer` 也算，因为它们从操作者视角还没交付。park 不阻塞队列（待确认的卡片不该让你没法继续发消息）。

**工具调用从 outline 合并回消息流**：transcript window 按真机的 partial index 过滤掉 `tool-call`，所以 `getAgentOutline` 单独提供，UI 侧按 `id ↔ callId` 合并。

右栏 tab 来自真机契约：`GET /uimap.json` 返回从 `2e44baf` 抽出的 `SAND_UI_MAP`（50 KB）——设置锚点、`grokbot://app/v1/...` 深链、28 个命令、6 个 tab、4 种布局。

## 模型绑定

`model-bindings.json` 按 agent 记模型与线格式控制，**key 只写环境变量名**：

```json
{
  "version": 1,
  "default": { "modelId": "grok-4.6", "baseUrl": "https://api.x.ai/v1", "apiKeyEnv": "XAI_API_KEY" },
  "agents": {
    "<agentId>": { "modelId": "glm-5.3", "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
                   "apiKeyEnv": "ZHIPU_KEY", "maxMode": true,
                   "parameters": [{ "id": "effort", "value": "high" }] }
  }
}
```

`providers/maps.mjs` 只对**有 wire 证据**的路由改 body，其余显式 no-op：

| 路由 | 行为 |
| --- | --- |
| `grok-*` | `maxMode` → `reasoning_effort:"xhigh"`；`fast` → `low`；`effort` 映射，`max`→`xhigh` |
| `claude-*` | pass-through（思考由上游 shim 决定） |
| `gemini-*` | 仅 `gemini-3.6-flash` 系列把 effort 变 slug 后缀 |
| `deepseek-*` | thinking 开启时补 `reasoning_effort:"high"` 与 `max_tokens`，**不覆盖**调用方已给的值 |
| `glm-*` | `fast` → `thinking:{type:disabled}`；effort → `reasoning_effort` |
| `qwen-*` | `chat_template_kwargs.enable_thinking`，尊重显式 `false` |
| 其它 | 返回 `"none"`，body 原样 |

换模型时 binding 会清掉同一 entry 下残留的 `baseUrl/provider`，避免"换了模型还在打旧 shim"——这是真实快照里 Github Bot 记下的那个 bug。

## 工具与审批

`tools.json`：`{"allow":["shell:ls*"],"deny":["shell:rm -rf*"],"autoApprove":false}`。

所有 bot 共用 `<root>/workspace`，与真机 `/workspace` 一致（`exec-daemon` 日志：`workspacePaths:["/workspace"]`）。**目录不是安全边界**，只防误触。

- 命中 `deny` → 直接失败，不执行。
- 命中 `allow` 或 `autoApprove` → 执行。
- 否则 → 回合停在 `approval-request`，Web 上出现 Approve/Deny；批准后执行**命令原文**，拒绝写 `denied` 且不执行。
- `ask_user` 是另一条闸门：回合停在 `widget-request`，用户选项即答案，答复写回 tool result 再续跑；同一 widget 只答一次。

## 交互流程

图版见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，文字版见 [docs/FLOW.md](docs/FLOW.md)。当前执行协议见 [docs/EXECUTION.md](docs/EXECUTION.md)。四个必须知道的规则：

1. **先落盘再执行。** 接纳、固定 Run 身份和 outbox 同事务写入 `execution.db`，提交后才投影并入队。同 nonce 同完整输入返回原回执，目标、附件、引用或策略不同会返回 `send/nonce-digest-mismatch`；旧 JSON 台账保留作迁移与诊断。
2. **按 harness 路由。** `harness=temporal` 经 server Proxy，`box` 标记退役，其它走本地执行。普通远端失败不降级本地代跑。
3. **每个 Bot 一个执行槽，三条 lane**：user > agent > background；群成员回合给直接消息让路。审批、问题和子任务等待释放执行槽，恢复时仍通过同一个队列。
4. **取消等待真实退出。** watchdog 请求取消，宽限期后仍未退出则标记 stuck 并保留执行槽；不会让旧工具与后继回合重叠。每段 controller/timer 独立清理，关机等待实际 drain。

## bot 之间怎么说话

`message_agent` 的 `priority` 是**必填**，它决定投递语义：

| priority | 行为 |
| --- | --- |
| `true` | 可执行：立即投递并唤醒对方，进 agent lane，优先于 routine/后台，但不打断正在跟用户说话的回合 |
| `false` | 仅供参考：held，**不唤醒**，等对方下次私聊回合读取 |

入站保留发送者身份，让模型区分队友与用户。投递对 `(目标, messageId)` 持久幂等，重启保留去重记录。群帖**纯文本、先落群时间线、不唤醒成员**；成员下次参与该群时读取权威历史，`priority` 对群组无效。

**主 bot 不是权限**：它是用户用 `SetPrimaryBot` 指定的指针（侧栏置顶 + 默认收件人）。普通通知使用 `message_agent`，可靠委派使用 `delegate_task`；主 Bot 指针不授予读取其他 Bot 私聊历史的权限。

路径类的工具（`read_file`/`write_file`/`list_dir`/`shell` 的 `workdir`）被限制在 `<root>/workspace/` 内，越界直接抛错。

## 跨 Bot 派工

模型调 `delegate_task(to, objective, expectedOutput)` 发起可靠本地委派。任务使用隔离会话，父 Run 等待时释放执行槽；子任务终态、结果和完成投递同事务保存，依赖满足后自动恢复父 Run 汇总，不需要用户再发消息。根链默认限制 4 个活动任务、2 层嵌套、12 个任务。普通 `message_agent` 继续用于通知和对话，不保证回复；非本地可靠委派返回明确的不可用状态，不暗中代跑。详见 [执行与迁移说明](docs/EXECUTION.md)。

## 例行任务

`agents/<id>/automations/<slug>/automation.json`，字段与 harness 一致（`name/prompt/schedule/enabled/provenance/createdAt/lastRunAt`），`runs.json` 记 `running/ok/error`。`serve` 期间每 30 秒按 `settings.json` 的 `userTimeZone` 匹配五段 cron；`mgb routine tick` 可手工触发一次做验证。例行结果是普通回合，不是另一条执行路径。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 对话 | 流式回合、中断（Esc/停止）、接受确认、待处理条目、失败重试 |
| 思考 | 推理流折叠、工具调用内联、按时长与步数摘要、DSH 式单行头 |
| 多 Bot | 名册、创建/删除/改名、分组、分支会话、名称模糊解析（`nas` → Nas Bot） |
| 模型 | 运行时切换、provider 目录、按 bot 绑定、端点与密钥分离 |
| 工具 | shell、读写文件、列目录、分会话记忆、技能、`delegate_task`、`message_agent`、`message_user`、`ask_user` |
| 审批 | 卡片、批准/拒绝/总是允许、常驻放行、允许与拒绝规则、过期处理 |
| 附件 | 上传（25MB）、粘贴图片、气泡内联预览、路径注入模型上下文 |
| 检索 | 跨 Bot 可见私聊历史搜索（⌘F）、当前会话 Markdown 导出 |
| 消息 | 引用回复、图片内联、bot 主动通知（「主动通知」标记） |
| 设置 | 分页面板（模型接入/外观/通知与网络/自动审批/关于与维护），深合并写盘 |
| 外观 | SVG 轮廓头像（12 形状 × 12 色 × 眼睛或自定义字符）、磨砂输入框、纸纹壁纸 |
| 角色 | 幕僚长（置顶主 bot），可设/可换/可取消，取消后无人担任 |
| 群聊 | 默认各成员作答；`@` 定向；RPC 可选协调/串行策略；群与私聊历史隔离 |
| 附件 | 图片/文件在气泡上方独立成块；群聊同样支持，路径随消息下发成员 |
| 例行任务 | cron、webhook 触发、立即运行、编辑、删除 |
| 技能 | 目录、安装、移除、刷新 |

## 桌面端

```bash
npm run desktop                    # 开发运行源码
npm run dist:mac -- --arm64         # 生成 dist/mac-arm64/MyGrokbot.app
npm run dist:dmg                   # 生成 dist/ 下的 arm64 DMG，不额外生成 zip
```

Electron 主进程直接跑 Gateway，没有 sidecar。App 产物在 `dist/`，打包不会自动替换已安装版本；详细命令见 [构建与启动](docs/BUILD_AND_RUN.md)，桌面行为与分发配置见 [DESKTOP.md](docs/DESKTOP.md)。

## 持久化部署

开发时直接 `mgb serve` 即可；要让它常驻，做两件事：

**① 密钥落盘**（否则重启后模型报缺少 key）

桌面版的「设置 → 模型接入」可以直接填 Base URL 和 API Key，保存后由 `src/secrets.mjs`
写入 `~/.mygrokbot/secrets/env.json`（创建即 0600，先写临时文件再 rename，避免短暂可读）。
也可以手动：

```bash
mkdir -p ~/.mygrokbot/secrets
cat > ~/.mygrokbot/secrets/env.json <<'JSON'
{ "PROVIDER_KEY_ENV": "your-key-here" }
JSON
chmod 600 ~/.mygrokbot/secrets/env.json
```

`createHost()` 启动时把其中的键注入 `process.env`（显式环境变量优先），所以 CLI、桌面版、
gateway 三个入口行为一致。binding 文件里依然只存**环境变量名**，不存密钥本身。

**② 开机自启**（macOS launchd 示例）

```xml
<!-- ~/Library/LaunchAgents/com.mygrokbot.gateway.plist -->
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/path/to/mygrokbot/bin/mgb.mjs</string>
  <string>serve</string><string>--port</string><string>8899</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>MGB_DATA_ROOT</key><string>/Users/you/.mygrokbot</string>
  <!-- 如果本机走代理，launchd 不会继承 shell 的代理变量，必须显式给 -->
  <key>NODE_USE_ENV_PROXY</key><string>1</string>
  <key>http_proxy</key><string>http://127.0.0.1:7890</string>
  <key>https_proxy</key><string>http://127.0.0.1:7890</string>
  <key>no_proxy</key><string>127.0.0.1,localhost</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
```

```bash
launchctl load   ~/Library/LaunchAgents/com.mygrokbot.gateway.plist   # 启用
launchctl unload ~/Library/LaunchAgents/com.mygrokbot.gateway.plist   # 停用
```

`KeepAlive` 让进程崩溃后自动拉起；`RunAtLoad` 让登录后自动启动。

## 已知边界

- 单进程、单机、无多租户；一个数据根使用一个执行器。local 本地执行、box 退役，temporal 通过 Proxy；默认 transport 是本地协议替身，连接真实服务端需要接入实际 transport。可靠 delegate_task 当前只支持本地 Bot。
- 没有桌面/VNC：真机是 3 个常驻 X 桌面（:1/:3/:5）+ 5 个 shared 服务共 21 个受管进程，`getServiceMap` 只如实列出端口，不模拟。
- 没有 provider 目录/授权模型（真实 host 靠服务端 `availableModels`）。
- `blobs` 表已启用 AES-256-GCM 静态加密（`12B IV + 16B tag + 密文`，密钥为口令的 SHA-256）；真机把它放在独立的 `conversation-blobs.db`。
- SSE 断线不补历史：重连后靠 `getAgentTranscript` 重拉，真实 host 也是这样分层。
- 没有做 `search-index.db` 的 FTS 增量重建；快照里的索引可读但本实现不写它。真机那份只是本地索引，权威数据在服务端 agent store。

## provenance 日志

`logs/local-bound-provenance.jsonl` 在模型步骤结束或执行失败时追加记录，字段集合保持真机兼容。一次含工具调用的 Run 可有多行，traceId 对应执行段：

```json
{"schema":"GROKBOT_LOCAL_PROVENANCE_V1","event":"local-bound-terminal","traceId":"...",
 "hopBaseUrlHostOrRouteLabel":"http://127.0.0.1:18790/v1","httpStatus":200,
 "visibleOutputSha256":"c0535e...","outcome":"success","nullReasons":{}}
```

缺值不省略：`null` + `nullReasons` 说明原因（`no_http_response` / `stream_usage_not_received` / `not_received_or_unsafe`），所以"没拿到 usage"和"usage 是 0"可区分。

## 参考

- 包内事实与不可注入证据：[docs/PARITY.md](docs/PARITY.md)
- 核心功能使用：[docs/CORE_FEATURES.md](docs/CORE_FEATURES.md)
- 功能清单与验收记录：[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
- 本轮改动明细：[docs/CHANGELOG.md](docs/CHANGELOG.md)
- 桌面端构建与分发：[docs/DESKTOP.md](docs/DESKTOP.md)
- 本次重建的取舍：[docs/FLOW.md](docs/FLOW.md)
