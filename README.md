# MyGrokbot

> **许可：GPL-3.0**（[LICENSE](LICENSE)）。界面规则与布局常量移植自 [Telegram Web K](https://github.com/morethanwords/tweb)（同为 GPL-3.0），逐条记录在 [docs/UI.md](docs/UI.md)。

个人自建的 **Grok-Bot 形态**工作台：多 Bot 名册、按回合流式推理、有审批的本地工具、持久记忆、技能目录、例行任务、本机 Gateway（HTTP RPC + SSE + Web 客户端）。

它照着两台机器上真实跑过的东西重建：`sand-d.tar.gz`（云电脑 `sand-data` 快照）与 `grokbot-analysis.tar.gz`（30MB host bundle + 旧注入代码）。重建的是**协议与数据形状**，不是 bundle 注入 —— 为什么不能注入，见 [docs/PARITY.md](docs/PARITY.md)。

## 三层，各管一件事

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

三条不可让步的规则，全部来自快照里真实行为：

1. **接纳与执行分离。** `sendPrompt` 立刻返回 acceptance（含 `clientNonce`），回合在后台跑，进度走 SSE。同 nonce 重投返回同一条 acceptance。
2. **一切落 transcript。** 流式文本改的是同一行 entry，崩在中间仍可恢复；工具调用/审批/错误都是 entry。
3. **审批是 entry，不是弹窗。** 需要批准的命令把回合停下，批准后执行**同一条命令**并继续，拒绝则写 `denied` 且不执行。

## 快速开始

```bash
cd mygrokbot
node bin/mgb.mjs init --bot "Main Bot" --model grok-4.6 \
  --base-url https://api.x.ai/v1 --key-env XAI_API_KEY
export XAI_API_KEY=...          # 只有环境变量，binding 文件里永远不存 key
node bin/mgb.mjs doctor
node bin/mgb.mjs serve          # 打开打印出的 http://127.0.0.1:<port>/
```

CLI：

```bash
mgb prompt "Main Bot" "看一下这个仓库的结构"     # 流式打到 stdout
mgb tail "Main Bot" --limit 20
mgb agents new "Nas Bot" && mgb bind "Nas Bot" --model glm-5.3 --base-url https://open.bigmodel.cn/api/paas/v4 --key-env ZHIPU_KEY
mgb routine add "Main Bot" --name "Daily Digest" --prompt "汇总昨天的失败任务" --cron "0 8 * * *"
mgb policy set --allow "shell:ls*" --allow "shell:cat*" --deny "shell:rm -rf*"
```

无模型也能验收整条链路（离线、确定性）：

```bash
node --test 'test/**/*.test.mjs'   # 72 通过 + 3 跳过（真实模型需显式开启）
```

真实模型是 opt-in，见 [docs/LIVE.md](docs/LIVE.md)：

```bash
mgb verify "Main Bot" --model workbuddy/hy3 \
  --base-url http://192.168.49.201:3425/v1 --key-env MGB_REAL_KEY
```

## 目录

```
mygrokbot/
├── bin/mgb.mjs                  CLI（init/doctor/serve/prompt/tail/agents/skill/routine/bind/policy）
├── src/
│   ├── host.mjs                 组装：数据根 + 名册 + 技能 + 工具 + 引擎 + routines + gateway
│   ├── gateway.mjs              HTTP RPC / SSE / 静态 Web，loopback + Origin 拒绝 + bearer
│   ├── engine.mjs               回合引擎：建 prompt → 流式 → 工具 → 落 entry → 审批续跑
│   ├── db.mjs                   node:sqlite；与 sand-host agent store 同 schema
│   ├── roster.mjs               agents/<uuid>/{profile,settings,store.db,memory,automations}
│   ├── entries.mjs              entry 构造器（同一 kind 词汇）
│   ├── tools.mjs                shell/文件/memory/skill/message_agent + 审批策略
│   ├── skills.mjs               SKILL.md frontmatter 解析 + 内置 5 个种子技能
│   ├── routines.mjs             automation.json/runs.json + 五段 cron（带时区）
│   ├── bus.mjs                  事件总线（SSE 扇出）
│   ├── acceptance.mjs           持久接纳台账（send-acceptance.json，三种 lookup）
│   ├── scheduler.mjs            三 lane 队列 + 每 agent 串行 + 120s/30s watchdog
│   ├── timeline.mjs             pending 发送的排序（tweb 规则 + 本项目的适用性说明）
│   ├── room.mjs                 群组轮流发言 + 六态 outcome
│   ├── proxy.mjs                server-agent-proxy：temporal agent 的转发与拒绝语义
│   ├── review.mjs               用户审核：NEVER/ASK/ALWAYS 上限、approved/denied/always、
│   │                            常驻放行规则、陈旧卡片拒绝、启动过期
│   ├── paths.mjs                数据根解析（MGB_DATA_ROOT 覆盖）
│   ├── providers/{maps,bindings,transport}.mjs
│   └── ui/
│       ├── index.html           单文件 Web 客户端（名册 + 对话 + 审批 + 右侧信息栏）
│       └── uimap.json           真机 UI 契约（50KB：设置锚点/深链/28 commands/4 布局）
├── test/{e2e,unit}.test.mjs, mock-provider.mjs   （mock 会演 TOOL / ASK / ECHO 三个分支）
└── docs/PARITY.md               两个包的对齐结论与不可注入证据
```

数据根默认 `~/.mygrokbot`，结构对齐 `sand-data`：

```
<root>/
├── gateway.json  host-secrets.json  host.lock  settings.json
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
2. **启动时过期所有 pending。** 上个进程留下的卡片没有活的 resolver 在后面，留着只会被误点。

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

单文件 Web 客户端（`src/ui/index.html`，约 900 行），浅色 macOS 风格，自动跟随系统深色模式。

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

图版见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，文字版见 [docs/FLOW.md](docs/FLOW.md)。四个必须知道的规则：

1. **先落盘再执行。** `sendPrompt` 的第一件事是写 `send-acceptance.json`（含 `inputDigest`），然后才入队。同 nonce 同内容返回原记录，不同内容返回 `send/nonce-digest-mismatch`。
2. **按 harness 路由。** `profile.json` 的 `harness=temporal` → 拒绝本地执行（`send/agent-unavailable`）；`box` → 标记退役；其它 → 本地跑。拒绝发生在写台账之前。
3. **每个 bot 一个队列，三条 lane**：user > agent > background，群聊成员回合给直接消息让路，同一 bot 同时只有一个回合。
4. **卡住会被踢掉。** user 回合在 active 后面等超过 120s 触发 trip，再 30s 未完成则 escape（放弃该回合、跑下一个），之后迟到的完成只记 `late_settle`。

## bot 之间怎么说话

`message_agent` 的 `priority` 是**必填**，它决定投递语义：

| priority | 行为 |
| --- | --- |
| `true` | 可执行：立即投递并唤醒对方，进 agent lane，优先于 routine/后台，但不打断正在跟用户说话的回合 |
| `false` | 仅供参考：held，**不唤醒**，等对方下次任意回合开头再读 |

入站文本带 `[agent]` 前缀，让模型分得清"队友"和"用户"。投递对 `(目标, messageId)` 幂等（账本 512 条）。群组是**纯文本、立即广播、不打断**，`priority` 对群组无效。

**主 bot 不是权限**：它是用户用 `SetPrimaryBot` 指定的指针（侧栏置顶 + 默认收件人）。协调靠 `message_agent` 这种普通工具，拿不到别的 bot 的私有资料。

路径类的工具（`read_file`/`write_file`/`list_dir`/`shell` 的 `workdir`）被限制在 `<root>/workspace/` 内，越界直接抛错。

## 跨 Bot 派工

模型调 `message_agent(to, text)`：消息以 `fromAgent` 落进目标 bot 的 transcript 并触发它的回合，答案作为那个 bot 的消息回到同一会话。调用方不阻塞 —— 与快照里 "A→B→A 通知链路" 的语义一致。

## 例行任务

`agents/<id>/automations/<slug>/automation.json`，字段与 harness 一致（`name/prompt/schedule/enabled/provenance/createdAt/lastRunAt`），`runs.json` 记 `running/ok/error`。`serve` 期间每 30 秒按 `settings.json` 的 `userTimeZone` 匹配五段 cron；`mgb routine tick` 可手工触发一次做验证。例行结果是普通回合，不是另一条执行路径。

## 功能一览

| 模块 | 能力 |
| --- | --- |
| 对话 | 流式回合、中断（Esc/停止）、接受确认、待处理条目、失败重试 |
| 思考 | 推理流折叠、工具调用内联、按时长与步数摘要、DSH 式单行头 |
| 多 Bot | 名册、创建/删除/改名、分组、分支会话、名称模糊解析（`nas` → Nas Bot） |
| 模型 | 运行时切换、provider 目录、按 bot 绑定、端点与密钥分离 |
| 工具 | shell、读写文件、列目录、记忆、技能、`message_agent`、`message_user`、`ask_user` |
| 审批 | 卡片、批准/拒绝/总是允许、常驻放行、允许与拒绝规则、过期处理 |
| 附件 | 上传（25MB）、粘贴图片、气泡内联预览、路径注入模型上下文 |
| 检索 | 跨 bot 全历史搜索（⌘F）、Markdown 导出 |
| 消息 | 引用回复、图片内联、bot 主动通知（「主动通知」标记） |
| 设置 | 分页面板（模型接入/外观/通知与网络/自动审批/关于与维护），深合并写盘 |
| 外观 | SVG 轮廓头像（12 形状 × 12 色 × 眼睛或自定义字符）、磨砂输入框、纸纹壁纸 |
| 角色 | 幕僚长（置顶主 bot），可设/可换/可取消，取消后无人担任 |
| 例行任务 | cron、webhook 触发、立即运行、编辑、删除 |
| 技能 | 目录、安装、移除、刷新 |

## 桌面端

```bash
npm install && npm run desktop    # 开发运行
npm run dist:dmg                  # 打 DMG（未签名，可任意分发）
```

Electron 主进程直接跑 gateway，没有 sidecar。`.app` 245MB / DMG 112MB，其中代码只有 1.2MB，
其余是 Chromium。细节、分发方式与限制见 [docs/DESKTOP.md](docs/DESKTOP.md)。

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

- 单进程、单机、无多租户；`harness` 永远是 `local`，没有 temporal 远端回合，也没有真机的 `/cursor/stores` FUSE（那才是权威 transcript 存储）。
- 没有桌面/VNC：真机是 3 个常驻 X 桌面（:1/:3/:5）+ 5 个 shared 服务共 21 个受管进程，`getServiceMap` 只如实列出端口，不模拟。
- 没有 provider 目录/授权模型（真实 host 靠服务端 `availableModels`）。
- `blobs` 表已启用 AES-256-GCM 静态加密（`12B IV + 16B tag + 密文`，密钥为口令的 SHA-256）；真机把它放在独立的 `conversation-blobs.db`。
- SSE 断线不补历史：重连后靠 `getAgentTranscript` 重拉，真实 host 也是这样分层。
- 没有做 `search-index.db` 的 FTS 增量重建；快照里的索引可读但本实现不写它。真机那份只是本地索引，权威数据在服务端 agent store。

## provenance 日志

`logs/local-bound-provenance.jsonl` 每回合一行，21 个字段与真机**逐字一致**：

```json
{"schema":"GROKBOT_LOCAL_PROVENANCE_V1","event":"local-bound-terminal","traceId":"...",
 "hopBaseUrlHostOrRouteLabel":"http://127.0.0.1:18790/v1","httpStatus":200,
 "visibleOutputSha256":"c0535e...","outcome":"success","nullReasons":{}}
```

缺值不省略：`null` + `nullReasons` 说明原因（`no_http_response` / `stream_usage_not_received` / `not_received_or_unsafe`），所以"没拿到 usage"和"usage 是 0"可区分。

## 参考

- 包内事实与不可注入证据：[docs/PARITY.md](docs/PARITY.md)
- 功能清单与验收记录：[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)
- 本轮改动明细：[docs/CHANGELOG.md](docs/CHANGELOG.md)
- 桌面端构建与分发：[docs/DESKTOP.md](docs/DESKTOP.md)
- 本次重建的取舍：[docs/FLOW.md](docs/FLOW.md)
