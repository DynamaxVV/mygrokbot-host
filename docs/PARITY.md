# 两个包的真实差异（对照 + 结论）

日期：2026-10-21。对象：`sand-d.tar.gz`（新版云电脑 `sand-data` 快照）、`grokbot-analysis.tar.gz`（旧版 30MB `host-main.cjs` + opengrok 注入代码）。

标注：**F** 已验证静态/运行事实，**I** 代码推断，**U** 包外未知。

## 1. 两个包各是什么

| 包 | 内容 | 能回答什么 |
| --- | --- | --- |
| `grokbot-analysis.tar.gz` | `host/host-main.cjs`（30,065,017 B，sha256 `22ea7582…f987da`，781,144 行 esbuild bundle）、opengrok 旧注入工具、AST 索引脚本 | 新版 host 的内部协议、gateway 方法表、transcript 存储、（否定）旧注入锚点 |
| `sand-d.tar.gz` | 一台真实云电脑的 `sand-data` 运行时：`settings.json`、`gateway.json`、`host-secrets.json`、9 个 agent（`profile.json` + `store.db`）、57 个 managed skills、6 个 plugin 缓存、`local-bound-provenance.jsonl`、`search-index.db`、`logs/*.jsonl` | 真实数据形状、真实 agent 名册、真实会话/技能/插件规模 |

**F**：`sand-d` 的 `agents/<uuid>/store.db` 表结构与 bundle 第 711496–711528 行的 `agent-db-schema.ts` 完全一致（`kv` / `blobs` / `transcript_entries` / `automation_completion_inbox` + 两个 partial index）。也就是说快照能被同版本 host 直接认领。

**F**：`search-index.db` 表结构与 bundle 第 540231–540268 行 `search-index-db.ts` 的 `CORE_SCHEMA` 一致（`meta`/`agents`/`messages`/`media`/`server_cursors`），实测 1956 条 messages、14 条 media、9 条 server_cursors。

## 2. 旧注入面在新版全部消失（F）

在 `host-main.cjs` 上逐字计数：

| 锚点 | 计数 | 旧工具要求 |
| --- | --- | --- |
| `new e("openai_session"` | 0 | `openai-hop-install.py` 要求 == 1 |
| `"openai_session"` | 0 | 同上 |
| `hopBaseUrl` | 0 | `apply-box-patch.py` 要求存在 |
| `model-bindings` | 0 | 同上 |
| `createOpenAiHopSession` | 0 | 同上 |
| `resolvedTopLevelModelId` | 0 | 同上 |

**结论**：`apply-box-patch.py` 与 `openai-hop-install.py` 对这个版本的 bundle 都装不上，失败是设计内的（锚点 count 断言），不是参数问题。

## 3. 新版真正的执行边界（F）

主推理不在本地：

- `applySandInferenceRequestContext(headers, ctx)`（B:224129）写的是 `x-inference-authentication-jwt`、`x-cursor-workload*`、`x-cursor-traffic-type`；也就是说推理走服务端代理，凭据是短期 workload JWT，不是用户 API key。
- `createSandInferenceInterceptor`（B:224181 起）拦截 `aiserver.v1.InferenceService/Stream`，`req.header.delete("authorization")` 后重写整套 header —— 客户端根本拿不到上游 provider 的直连机会。
- `SAND_BACKEND_URL` 只有 4 处，用于整个 backend 身份与 Connect transport，不是 OpenAI-compatible endpoint 开关。
- 官方留了口子但没接线到主链：`RequestedModel.api_key_credentials` 出现 9 次、`ModelAllowlistByok` 19 次，`SAND_AGENT_MODEL` 1 处（图片生成路径）。

**结论**：想在旧的位置劫持主模型，需要改的是服务端推理实现，不是 box 里的 bundle。这也是 `OPENGROK_COMPATIBILITY.md` 的 S3/S4 分支。

## 4. 但 gateway 本身是完整可实现的面（F）

新版把能力收敛到一个本机 gateway，旧版没有这层：

- `startGatewayServer`（B:492389）：`GET /health`、`GET /events`（SSE）、`POST /api/<method>`、`POST /prepare-upgrade`、`GET /api/avatars/*`、`GET /api/attachments/*`。
- `GATEWAY_METHOD_DECLARATIONS`（B:488602）实测 **212** 个 rpc 方法，含 `sendPrompt`、`promptAcceptanceStatus`、`getAgentTranscript*`、`resolveAutoReviewApproval`、`createAgent`、`getAgentAutomations`、`skillsCatalog`、`deliverAgentMessage`、`runRoomMemberTurn` 等。
- 鉴权：`gateway.json` 里的 token + `Authorization: Bearer`，`timingSafeEqual` 比较；带 `Origin` 头的请求一律 403（`rejectUntrustedBrowserRequest`）；无 token 时强制 loopback Host。
- `gateway.json` 形状实测：`{port, pid, startedAt, scheme, host, token}`。

这就是我重建的那一层。**它不是注入，是照抄协议。**

## 5. 数据形状（F，可直接复用）

| 路径 | 真实内容 |
| --- | --- |
| `settings.json` | `accountScopes`、`activeAccountScope`、`autoReviewInstructions{allowInstructions,blockInstructions,isEnabled}`、`localToolPermissionByMachineId`、`userTimeZone`、`mcp*` |
| `agents/active-agent.json` | `{"activeAgentId":"04d7a890-…"}` |
| `agents/<id>/profile.json` | `name/description/title/avatarShape/avatarColor/namedBy/serverId/harness:"temporal"` |
| `agents/<id>/settings.json` | `notifyOnAgentUpdates` |
| `agents/<id>/store.db` | `kv`（`metadata`、`hiddenEntryRepairVersion`、`unreadState`）、`transcript_entries`（`kind: event` 的 `name-changed` 等） |
| `agents/<id>/attachments/*.md` | agent 自己写的交接文档（vv Bot 的流程手册、Github Bot 的代码审查） |
| `managed-skills/skills/<slug>/SKILL.md` | 57 个，YAML frontmatter + 正文 |
| `managed-skills/cache.json` | `{fetchedAt, skills:[{id,name,description,body}]}` |
| `plugin-skills/cache.json` | `{installFolders[], skills[]}`，插件市场缓存 |
| `local-bound-provenance.jsonl` | 每回合一行 `MYGROKBOT_LOCAL_PROVENANCE_V1` 风格记录 |
| `logs/bot-work-log.jsonl` | bot 级任务流水（end/agent/task/status/magpie_calls） |
| `secrets/mac-local-llm.env` | 本地模型网关地址与 key（值是占位符） |

**F**：`local-bound-provenance.jsonl` 共 11 行，全部在 2026-10-21T08:17:29–08:17:50 这 21 秒内产生，每行指向**不同**的 `127.0.0.1:33xxx–46xxx` 端口，token 数呈 10/5、20/15、50/100 这类整数阶梯。这不是真实用户回合，是本地 hop 包装器的自测探针：5 行 `error`（无 HTTP 响应）+ 6 行 `success`（`stop` / `tool-calls`），说明那台机器上的本地路由此刻能连通但端口每次随机，链路本身仍是一次性验证。

## 5.1 服务端推理的真实凭据形态（F）

`applySandInferenceRequestContext` 只写三类东西：短期 inference JWT（`x-inference-authentication-jwt`，且值以 `$` 开头时跳过，说明允许未注入）、workload 三元组（`x-cursor-workload` / `-job-id` / `-user`）、traffic type。**没有任何 provider 的 `Authorization` 从本地流向外部**；`createSandInferenceInterceptor` 甚至先 `req.header.delete("authorization")` 再写回自己那套。这条路要接管主模型，只能改服务端，box 侧无落点。

## 6. 我据此做的取舍

| 决策 | 理由 |
| --- | --- |
| 不复制 30MB bundle、不做字节注入 | 锚点为 0，且主推理已移走；注入即使成功也只接管本地非主链 |
| 照抄 gateway 协议与方法词汇 | 这是新版唯一稳定、可验证的对外契约 |
| 照抄数据布局（agents/store.db/skills/automations） | 可直接吃 `sand-d` 快照，工具链和心智模型都能复用 |
| provider 层保留 opengrok 的 maps 思想，砍掉具体 shim 端口 | 映射规则有 wire 证据；shim 端口是本机私有的，不该进通用实现 |
| 承认并保留 approval / acceptance / routine inbox 三件事 | 它们才是"像 Grok Bot"的部分；少了这三样就只是聊天壳 |

## 7. 尚未能验证（U）

- 服务端 `RequestedModel.credentials → provider client` 的实际数据流（不在包里）。
- 212 个 rpc 方法的**响应** schema：`GATEWAY_METHOD_DECLARATIONS` 只声明入参。
- `harness: "temporal"` 的真实 turn 执行器：`sand-data` 里没有任何 turn 历史，只有 name-changed 事件。
- `store.db` 的 `blobs` 表用途（注释说已被 `conversation-blobs.db` 取代，快照里为空）。

---

# 补充：`mgb-bundle2.tgz` + `mgb-supervisor.tgz` 带来的修正

日期：2026-10-21（第二轮材料）。这两份材料推翻了我第一轮的两个判断，都是"我原来按源码推断、现在被真机否掉"。

## A. 被推翻的判断 1：workspace 不是按 agent 隔离的

我原来实现成 `agents/<id>/workspace/`。真机日志否掉：

**F** `exec-daemon.log:5` — `Discovered exec-daemon workspaces {"workspacePath":"/workspace","usesReposRoot":false,"workspacePaths":["/workspace"]}`
**F** `exec-daemon.log:6` — `"workspacePath":"/workspace","projectDir":"/home/box/.cursor/projects/workspace"`
**F** bundle `B:475257` — `SAND_BOX_WORKSPACE_ROOT = "/workspace"`，`B:475256` — `SAND_BOX_UPLOADS_DIR = "/workspace/uploads"`，`B:475258` — `BOX_PATH_ROOTS = ["/workspace", "/home", "/root"]`

整个 host 只有一个 workspace，所有 agent 共用。agent 目录放的是**状态**（profile/store.db/memory/attachments），不是工作树。

已改：`paths.mjs` 只有一个 `workspace`；`tools.mjs` 的路径护栏改为围 `/workspace`；system prompt 明写"别的 bot 共享同一目录，不要把目录当安全边界"。这条比原来更危险，因为原来的实现暗示了一种并不存在的隔离。

## B. 被推翻的判断 2：我对着的 bundle 不是线上跑的版本

**F** `sand-supervisor.log` —
```
host version b0849cb → boot-fetch: latest pointer 2e44baf != baked b0849cb
→ applied b0849cb -> 2e44baf (swap 1698ms)
```
**F** `sand-supervisor/status.json` — `"hostVersion":"2e44baf"`

也就是说：镜像里烤的是 `b0849cb`，启动时被 supervisor 换成了 `2e44baf`。而 `grokbot-analysis.tar.gz` 里那份 bundle 是**更早**的。

硬证据是两份 `debugging-the-box.md` 的差异：

| 内容 | bundle 内嵌 | 线上生成 |
| --- | --- | --- |
| `$DISPLAY` | **无** | 有 |
| "an agent with its own desktop runs on :2 or higher" | **无** | 有 |
| `/tmp/sand-window-N/start-desktop.log` | **无** | 有 |
| 字数 | 4292 | 4525 |

所以线上已经支持**每 agent 独立桌面**（`:2` 起），我分析的 bundle 只认 `:1`。这是新能力，不是文案改写。

**这解释了 `sand-d` 里 12 个 agent 只有 9 个有 store.db 的疑点**：桌面数和 agent 数是两套资源。

## C. 新事实：端口地图（全部来自日志，非文档）

| 端口 | 服务 | 证据 |
| --- | --- | --- |
| 1337 | exec-daemon | `exec-daemon.log` `ExecDaemon server listening {"port":1337}` |
| 1338 | pty host (ws) | `PtyHost WebSocket server listening {"port":1338}` |
| 1339 | window-router | `sand-window-router.log` `port=1339 primary=1337 fork_base=14000 (owner-token enforced)` |
| 1340 | **host gateway** | `sand-host.log` `gateway listening on http://0.0.0.0:1340 (auth required)` |
| 8790 / 8791 | egress tunnel ws / proxy | `egress-tunnel.log` |
| 9225 | Chrome CDP | `sand-session-sync.log` `connected to monitor on CDP port 9225` |
| 5900–5905 | x11vnc per display | `x11vnc:1..5.log` `PORT=5900..5905` |
| 6080 / 6081 | noVNC / fork websockify | `novnc:1.log`, desktop-health components |

**F** gateway 实际绑 **`0.0.0.0`**，不是 loopback；安全边界只有 token。我原来的实现强制 loopback，比真实更严——已改为"有 token 时可绑任意地址，无 token 时强制 loopback"（`getServiceMap` 也把这套端口表暴露出来）。

## D. 新事实：桌面是 21 个受管进程，不是"一个 VNC"

**F** `sand-supervisor/desktop-health.json` — `total:21, up:21, down:0, crashlooping:0`，组件：

```
d1/xvfb  d3/xvfb  d5/xvfb
d1/xfwm4 d3/xfwm4 d5/xfwm4
d1/picom d3/picom d5/picom
d1/x11vnc d3/x11vnc d5/x11vnc
d1/dock  d3/dock  d5/dock
shared/egress-proxy  shared/fork-router  shared/fork-websockify
shared/ua-governor   shared/web-bot-auth
```

即 **3 个常驻桌面（:1/:3/:5）+ 5 个 shared 服务**，每个桌面 5 个进程。`:2/:4` 是临时 fork 出来的（`x11vnc:2.log`/`:4.log` 里有 `caught signal: 15`，即被回收过）。supervisor 日志还有 `idle desktop park: :5 reason=idle idleMinutes=30 outcome=parked` —— 空闲 30 分钟自动 park。

我原来的实现只有一个 workspace、没有桌面概念。这条我**没有**去仿（个人机上没有意义），但已经在 `getServiceMap` 里如实暴露，避免以后误以为只有 :1。

## E. 新事实：provenance 的精确字段集（已按此重写）

**F** `local-bound-provenance.jsonl` 每行 21 个键，顺序固定：

```
schema event timestamp traceId agentId modelId hopBaseUrlHostOrRouteLabel
requestKind upstreamId responseModel httpStatus promptTokens completionTokens
finishReason elapsedMs visibleOutputSha256 visibleOutputBytes
visibleOutputCharacters outputComplete outcome nullReasons
```

关键设计：**缺值不是省略，是 `null` + `nullReasons` 说明为什么缺**。

```json
"upstreamId": null,
"nullReasons": {
  "upstreamId": "not_received_or_unsafe",
  "httpStatus": "no_http_response",
  "promptTokens": "stream_usage_not_received"
}
```

这解决了"没拿到 usage"和"usage 是 0"不可区分的问题。我原来写的是 `null` 但没写原因、字段名也不同（`baseUrlHostOrRouteLabel`、`MYGROKBOT_` 前缀、多余的 `route` 字段）。

已全部对齐：字段名、`GROKBOT_LOCAL_PROVENANCE_V1` schema 串、`visibleOutputSha256` 真实计算、`outputComplete`/`outcome` 二值语义、`nullReasons` 五类原因。测试里断言了完整 21 键集合。

## F. 新事实：skills/automations 在真机上是空的

**F** `managed-skills/` 有 57 个 skill，但 **`agents/*/automations/` 全空**（只有目录没有文件），**`agents/*/memory/` 目录根本不存在**。

所以我上一轮"要 memory 和 automation.json 来校准格式"的请求，答案是：那台机器上**从来没有建过 routine，也没有写过 memory**。我的 `routines.mjs` / `agents/<id>/memory/` 实现目前只能继续按 bundle 的 `parseStoredAutomationConfig` 推断，没有真机样本可对。

`cli-config/` 也是空目录——`BOX_HOME_PRUNE_GUARDED_FOREIGN_TREES` 里点名保护它，但这台机器没往里放东西。

## G. 新事实：另一条存储路径 —— agent store FUSE

**F** `agent-store-fuse.log` —
```
starting cursor-agent-store-fuse mount_root=/cursor/stores
backend_mode=Direct service_path="aiserver.v1.AgentStoreService"
self_store_id=bc-sand-c5d0becf8927081643fb self_store_identity_only=true
initial_agent_count=0 ready_sentinel_path=/run/agent-store-fuse/ready
events_path=/run/agent-store-fuse/events.jsonl spill_dir=/tmp
```
**F** `sand-copy-in.log` — `outcome=hydrated store_entries=6032 files=6032 bytes=1708473071 verified=6032`
**F** bundle `B:8809` — `AgentStoreService`，39 处引用，方法含 `ListAgentStores` / `ReadAgentStoreFile` / `WriteAgentStoreDocument` / `MintAgentStoreToken` / `CheckAgentStoreVersions`

这是**第三套 transcript 存储**（前两套是 `store.db` 和 `conversation-blobs.db`）：一个 FUSE 挂载把远端 `aiserver.v1.AgentStoreService` 映射成本地目录，`initial_agent_count=0` 说明它按需拉取。`sand-copy-in` 一次 hydrate 了 6032 个文件、1.7 GB。

我第一轮说"对话正文在 search-index.db"——现在更准确：**search-index.db 只是本地全文索引，权威数据在服务端 store，经 FUSE 挂到 `/cursor/stores`**。这也解释了为什么 9 个 `store.db` 里只有 name-changed 事件。

## H. 新事实：启动顺序与扩展图

**F** `sand-host.log` 的 49 个扩展按依赖图启动：

```
agent-cpu-saturation → credential-fill → memory → messages-grants → settings
→ auth → box-lifecycle → box-timezone → experiments → browser-ua
→ chrome-cookie-import → inference → notifications → privacy-mode
→ codebase-telemetry → orbit → source-map → team-admin-policy → telemetry
→ attachments → bot-template-share → content-search → forever-box
→ cloud-agents → credential-provider → local-exec → managed-setup → mcp
→ box-store-sync → remote-agent-messaging → secrets → session
→ transcript-publish → trays → turn-execution → transcript → agent-identity
→ auto-review → automations → cookie-origin-approval → feedback
→ host-upgrade → local-tool-permission → resume-ownership → server-agent-proxy
→ teach-recording → user-skills-cache → wallpaper → webauthn-proxy
→ working-state-export
```

注意 `memory` 排第 3、`turn-execution` 在 `transcript` 之前、`automations` 在 `auto-review` 之后。我实现里的初始化顺序是 roster → catalog → tools → engine → routines → gateway，**没有 session/transcript 分家**，也没有 resume-ownership。这条记录在案，不再假装对齐。

## I. 仍然未知

- `b0849cb` / `2e44baf` 的 bundle 本体（只有版本号，没有文件）。线上那个才是我该对着的代码。
- `conversation-blobs.db` 的 schema 与 `blobEncryptionKey` 用法（真机 9 个 agent 里没这个文件，因为一次回合都没跑）。
- 一次真实回合在 `store.db` 里长什么样 —— 所有 transcript 都为空。
- `agents/*/memory/` 的真实文件格式 —— 目录不存在。
- `sand-window-N` 那套每 agent 桌面的分配策略（`.sand-window-assignments.json` 没拿到内容，只有 bundle 里 1 处引用）。
