# 架构与调度图

## 当前本地架构（2026-10-22，P0/P1 后）

当前执行协议以 [EXECUTION.md](EXECUTION.md) 为准；功能入口见 [CORE_FEATURES.md](CORE_FEATURES.md)，编译与启动见 [BUILD_AND_RUN.md](BUILD_AND_RUN.md)。下文线上 bundle 图与标记 **F** 是外部历史证据，标记 **M（历史）** 是早期映射，均不代表当前执行保证。

| 层 | 当前实现 | 关键行为 |
| --- | --- | --- |
| 接入 | `gateway.mjs` / `host.mjs` | RPC 与 SSE；群入口先于单 Bot Proxy 路由 |
| 执行协调 | `execution.mjs` / `runtime.mjs` | 主机级 `execution.db` 以 WAL/FULL 保存接纳、Run、交互、任务与 outbox |
| 调度 | `scheduler.mjs` | 每 Bot 三 lane、单执行段；watchdog 请求取消，宽限期后记 `stuck` 并继续占槽 |
| 会话 | `conversation.mjs` / `db.mjs` | `dm:`、`group:`、`task:` 分区；输入水位固定；群只有一份业务历史 |
| 交互 | `runtime.mjs` | 卡片绑定 Run/callId；批准后同 Run 的新 segment 入队，工具与模型续跑均串行 |
| 群组 | `room.mjs` | fan-out、@ 定向、coordinated、round_robin；按成员 nonce/runId 查结果和取消 |
| 派工 | `tasks.mjs` | 本地 `delegate_task` 持久依赖与父恢复；普通 `message_agent` 不保证回复 |

`send-acceptance.json` 保留作兼容导入与诊断，已由协调库承担 Run 状态权威。崩溃前仍在执行的工作转为 `needs-reconciliation`，不自动重放工具；有持久恢复点的待决交互可恢复，无绑定旧卡过期。任务等待和交互等待释放实际执行槽，恢复始终重新排队。

回归基线为 **174 项：171 通过、3 跳过**；这是此前完整代码回归的结果，本次文档整理未新增 GUI 或打包验证。

## 历史重建与早期映射

以下历史图依据线上 bundle `2e44baf`（sha256 `e2caadd9…`）与 `sand-d` 快照。图用 Mermaid；`docs/FLOW.md` 是文字版，本文是图版。

图例：**实线** = 必然发生；**虚线** = 条件/异步；**灰色** = 线上存在但个人版未实现。

---

## 1. 整体分层：谁在跑，跑在哪

```mermaid
flowchart TB
    subgraph client["客户端层"]
        UI["Grok Bot 桌面 / 手机<br/>或 mgb Web"]
    end

    subgraph box["云电脑 box（/home/box）"]
        GW["host gateway :1340<br/>212 个 RPC + SSE /events<br/>bearer token，拒 Origin 头"]

        subgraph host["sand-host 进程"]
            ROUTE{"harness 路由<br/>profile.json"}
            PIPE["send-pipeline<br/>沙盒回合已退役"]
            LEDGER[("send-acceptance.json<br/>持久接纳台账")]
            SCHED["run-scheduler<br/>每 bot 一队列 / 三 lane"]
            A2A["agent-to-agent<br/>priority / held / 幂等"]
            TR["transcript<br/>store.db + conversation-blobs.db"]
            PROXY["server-agent-proxy<br/>temporal agent 转发"]
        end

        subgraph boxsvc["box 常驻服务"]
            EXEC["exec-daemon :1337<br/>workspace /workspace"]
            PTY["pty host :1338"]
            WR["window-router :1339<br/>owner-token"]
            EG["egress-tunnel :8790/8791"]
            CDP["chrome CDP :9222+"]
            VNC["x11vnc :5900-5905<br/>noVNC :6080"]
        end

        FUSE["/cursor/stores<br/>agent-store FUSE"]
    end

    subgraph cloud["服务端（包里没有）"]
        SRV["agent 回合执行<br/>InferenceService.Stream"]
        STORE["AgentStoreService<br/>权威 transcript"]
        INFER["推理凭据<br/>短期 workload JWT"]
    end

    UI -->|"POST /api/&lt;method&gt;"| GW
    GW --> ROUTE
    ROUTE -->|"temporal"| PROXY
    ROUTE -->|"box / 缺失"| PIPE
    PIPE -.->|"无条件抛<br/>SandBoxHarnessRetiredError"| LEDGER
    PIPE --> LEDGER
    PIPE --> SCHED
    SCHED --> TR
    SCHED <--> A2A
    A2A --> TR
    PROXY <-->|"Connect / Protobuf"| SRV
    PROXY -.->|"tail 缓存"| TR
    FUSE <--> STORE
    TR -.-> FUSE
    SRV --> INFER
    GW -->|"Shell/RPC"| EXEC
    EXEC --- PTY
    EXEC --- WR
    EXEC --- CDP

    classDef ghost fill:#eee,stroke:#999,stroke-dasharray: 4 3,color:#666
    class SRV,STORE,INFER ghost
```

**读图要点**

- `harness=temporal` 的 bot，回合**从来不在 box 里跑**；box 负责接纳、排队、tail 缓存和回执。
- `harness=box` 或字段缺失会掉进 `send-pipeline`，而那条路最后一行是 `throw SandBoxHarnessRetiredError`——这是死路，不是慢路。
- `/cursor/stores` 是权威 transcript 的本地映射，`store.db` 里往往只有事件（快照里 9 个 bot 全空就是这个原因）。

---

## 2. 一次用户消息的完整时序

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户 / 客户端
    participant G as gateway :1340
    participant L as acceptance ledger
    participant R as harness 路由
    participant Q as run-scheduler
    participant X as 回合执行
    participant T as transcript

    U->>G: POST /api/sendPrompt {agentId, prompt, clientNonce}
    G->>R: profile.json 的 harness 是什么？
    alt harness = temporal
        R-->>G: server-hosted
        G->>G: 转发 server-agent-proxy
        Note over G: 本地不执行，只回执 + 缓存 tail
    else harness = box / 缺失
        R-->>G: 本地路径（已退役）
        G-->>U: 503 SandBoxHarnessRetiredError
    else harness = local（个人版新增）
        R-->>G: 可本地执行
        G->>L: record(nonce, sha256(prompt))
        Note over L: 先落盘，后执行<br/>同 nonce 同内容 → 回原记录<br/>同 nonce 异内容 → nonce-digest-mismatch
        L-->>G: { acceptedAtMs, status=accepted }
        G->>T: append user entry
        G->>Q: enqueue(lane=user, ackToken=nonce)
        G-->>U: { accepted, clientNonce, acceptedAtMs }
        Q->>Q: pump → active run（带 generation）
        Q->>X: task()
        X->>T: 流式 entry / 工具 / 审批
        X-->>Q: settle
        Q->>Q: onTaskSettled（generation 不符则只报 late_settle）
    end
```

---

## 3. 排队：三 lane + watchdog

```mermaid
stateDiagram-v2
    [*] --> Enqueued: enqueue(lane)
    Enqueued --> PendingUser: lane = user
    Enqueued --> PendingAgent: lane = agent
    Enqueued --> PendingBackground: lane = background

    PendingUser --> Active: pump 优先取<br/>（群聊成员让路给直接消息）
    PendingAgent --> Active: user 空了才取
    PendingBackground --> Active: 最后

    Active --> Settled: task resolve
    Active --> Interrupted: user 排队 > 120s（trip）
    Interrupted --> Escaped: 再等 30s（grace）
    Escaped --> Active: pump 下一个<br/>被放弃的丢进 zombies
    Settled --> Active: pump 下一个

    Active --> LateSettle: 已被 escape 后才完成<br/>generation 不符 → 只上报，不复活
```

```mermaid
flowchart LR
    subgraph lanes["同一 bot 的队列"]
        direction TB
        L1["user<br/>人的消息"]
        L2["agent<br/>priority bot 消息"]
        L3["background<br/>routine / 后台"]
    end
    L1 -->|1| ACT((active<br/>同一时刻仅 1 个))
    L2 -->|2| ACT
    L3 -->|3| ACT
```

**F**：`RUN_WATCHDOG_DEFAULT_MS = 120000`，`RUN_WATCHDOG_GRACE_DEFAULT_MS = 30000`。watchdog 只在**有 user 任务在排**时才装。

---

## 4. bot 之间通讯

```mermaid
flowchart TB
    SEND["发送方 bot<br/>调 SendToAgent"]

    SEND --> CHK{"priority?"}

    CHK -->|"true：可执行"| NOW["立即投递<br/>+ 唤醒"]
    CHK -->|"false：仅供参考"| HOLD["held<br/>不唤醒"]

    NOW --> ALANE["进对方队列 agent lane<br/>优先于人之外的一切<br/>但不打断正在跟用户说话的回合"]
    HOLD --> NEXT["对方下次任意回合开头读取"]

    ALANE --> INB1["对方 transcript<br/>[agent] 前缀"]
    HOLD --> INB2["对方 transcript<br/>held=true"]

    INB1 --> REPLY["对方自己决定回不回<br/>异步——发送方不等"]
    INB2 --> REPLY

    SEND -->|"目标是群组"| GRP["群发<br/>纯文本，立即送达<br/>不打断任何人"]
    GRP --> INB3["每个成员 transcript<br/>[group:名字] 前缀"]

    classDef note fill:#fff8e1,stroke:#d0b060
    NOW:::note
    HOLD:::note
```

**F** 语义原文（`SEND_TO_AGENT_PRIORITY_DESCRIPTION`）：

> true：对方应当行动，或有人在等回复（任务、提问、交接、STOP、改计划）。立即送达并唤醒；若对方正在跟用户对话或处理另一个 bot 的消息，则排在其后。
> false：仅信息（状态更新、FYI、致谢、没人等的回复）。**held，等对方下次回合开头再读，不唤醒。**
> 群组忽略此项，总是立即 post。

其它约束：

| 规则 | 值 |
| --- | --- |
| 文本上限 | `AGENT_MESSAGE_MAX_TEXT_LENGTH = 8000` |
| 入站提示词 | `AGENT_INBOUND_WAKE_CUE = "[agent]"` |
| 幂等键 | `(toAgentId, messageId)`，账本上限 512 |
| 不能自消息 | `toAgentId === fromAgentId` → 拒绝 |
| 图片 | 1:1 可投；群组拒绝并回注说明 |
| priority | 仅 1:1；跨机也不支持，降级为普通发送 |

**M（历史）** 已按此实现 `sendToAgent` / `postToGroup` / 幂等账本；测试覆盖 priority 唤醒、held 不唤醒、幂等、群组只发文本。

---

## 5. 主 bot：不是权限，是"用户指定谁接活"

```mermaid
flowchart LR
    USER["用户"] -->|"SetPrimaryBot<br/>或侧栏点击"| PRIM["primary bot<br/>钉在侧栏顶端"]
    PRIM -->|"收到任务"| DECIDE{"怎么分"}
    DECIDE -->|"自己做"| SELF["本地/服务端回合"]
    DECIDE -->|"派给谁"| PICK["从 teammates 列表选<br/>ListAgents / 名册"]
    PICK -->|"SendToAgent<br/>priority=true"| WORKER["worker bot"]
    WORKER -->|"异步回复<br/>[agent] 消息"| PRIM
    WORKER -.->|"有产出"| ART["产物 / 结论"]
    ART -.-> PRIM
```

**F** `SetPrimaryBot` 工具描述的关键句：

> 把它**做成用户现有某个 agent 的 primary bot**：钉在侧栏顶端、用户最先派活的那个。**只有用户要求改**时才调用。调用前先把现有 bot 列出来、每人一句适不适合，问用户要哪个，等回答。

**所以"主 bot"不是超级用户**。它是：

- **用户指定**（不是自封、不是程序推断）
- **一个指针**（侧栏排序 + 默认收件人），不是权限提升
- **协调靠工具**：`SendToAgent` / `ListAgents` / `CreateAgent` / `UpdateAgent` / `ListSections`，全是普通工具调用
- **它拿不到别的 bot 的私有资料**——没有特权读取通道

配套工具：`WakeParent`（子 agent 唤醒父级）、`StopSubagent`、`ReadTranscript`（读别的会话记录需要明确 id）。

---

## 6. 群组（多 bot 房间）

```mermaid
sequenceDiagram
    participant H as 人
    participant R as 房间
    participant M1 as bot A
    participant M2 as bot B

    Note over R: group.json<br/>{version:1, memberIds:[...]}

    H->>R: 说话
    R->>M1: runRoomMemberTurn<br/>{nonce, room, peers, newMessages, deadlineMs}
    M1-->>R: deliverRoomMemberTurnResult<br/>{outcome: delivered|pass|skipped|timeout|cancelled|error}
    R->>M2: runRoomMemberTurn
    M2-->>R: result

    Note over R,M2: 每个成员回合带 nonce，结果幂等<br/>outcome=pass 表示这轮不发言

    M1->>R: 主动发言（postToGroup）
    R-->>M2: 以 [group:名字] 形式进 M2 的 transcript
```

**F** outcome 六态：`delivered` / `pass` / `skipped` / `timeout` / `cancelled` / `error`。`pass` 是"这轮我没什么可说"的正当结果，不是失败。

**F** 群组消息**纯文本**，图片会被拒并附说明；**priority 对群组无效**（不会打断成员）。

**M（历史）** 群组用 `group.json` 的 `memberIds`，`isGroup: true` 标记；广播时逐成员写 transcript，不唤醒。

---

## 7. 一个 bot 内部：回合循环

```mermaid
flowchart TB
    START["active run"] --> BUILD["buildMessages<br/>system + memory + 工具定义"]
    BUILD --> ROUTE2["provider map<br/>按模型改 wire 字段"]
    ROUTE2 --> STREAM["POST /chat/completions<br/>stream=true"]
    STREAM --> EV{事件}
    EV -->|text| T1["追加到同一 entry<br/>streaming=true"]
    EV -->|reasoning| T2["reasoning entry"]
    EV -->|tool_calls| TOOL{"工具"}
    TOOL -->|"策略 allow"| RUN["执行"]
    TOOL -->|"策略 deny"| DENY["拒绝，不执行"]
    TOOL -->|"无匹配"| PARK["park：approval entry<br/>回合结束"]
    TOOL -->|"ask_user"| WIDGET["park：question widget"]
    PARK -->|"批准"| RUN
    PARK -->|"拒绝"| DENYD["写 denied，不执行"]
    WIDGET -->|"作答"| RESUME["写回 tool result 续跑"]
    RUN --> STREAM
    T1 --> DONE["turn-end<br/>+ provenance 行"]
    DENY --> STREAM
    DONE --> PERSIST["transcript 落盘<br/>+ 事件广播"]
```

**审批与提问都是 entry，不是弹窗**：它们把回合停下来，写入 transcript，然后等一个显式解析来续跑。

---

## 8. 时间线：一次典型的多 bot 协作

历史时间线：用户派活给主 Bot；主 Bot 唤醒 Worker A，同时向 Worker B 留下 held 通知；A 的回复稍后抵达，B 在下次回合读取通知，主 Bot 再汇总。这里表达异步顺序，不作为执行时限。

关键：**派活是异步的**。主 bot 发完 `SendToAgent` 立刻继续，不阻塞等结果；worker 的回复作为新消息异步唤醒主 bot。

---

## 9. 主 bot 派工的一个具体例子

以 `sand-d` 快照里的真实名册为例（vv Bot 是幕僚长，下面挂 Ymb / Github / Nas）。

```mermaid
sequenceDiagram
    autonumber
    participant U as 小v
    participant V as vv Bot（primary）
    participant Y as Ymb Bot
    participant N as Nas Bot
    participant G as Github Bot

    U->>V: 「把 failed 任务清一下，顺便查断连根因」
    V->>V: 接纳（user lane）→ 拆解
    V->>Y: SendToAgent(priority=true)<br/>「failed 433 条，按 2 并发重跑，避开 05:30-06:30」
    V->>G: SendToAgent(priority=true)<br/>「只读查 DB 断连根因，别改代码」
    V->>N: SendToAgent(priority=false)<br/>「稍后可能要重启，先待命」
    Note over V: 三条都是异步，V 不阻塞，继续做自己的部分

    N-->>V: [agent] 待命收到（held，下次回合读）
    Y->>Y: 执行批处理
    Y-->>V: [agent] 首批 10 成 8 败 2，已停手
    V->>U: SendToUser「Ymb 部分成功，已让其停手」

    G->>G: 只读排查
    G-->>V: [agent] 根因：PG 连接被中途断开
    V->>U: SendToUser 汇总：清理进度 + 根因 + 待裁项
```

**为什么 Nas 用 `priority=false`**：它此刻没有要做的事，只是待命。用 `true` 会打断它的空闲回合、白跑一次；用 `false` 则等它下次被唤醒时自然读到。这正是 `priority` 存在的理由。

**为什么 V 不等待**：`SendToAgent` 的回执明说"This is asynchronous — if they reply, it'll arrive later as a new message that wakes you; don't wait on it now."

---

## 10. 早期个人版与线上的映射（历史快照）

| 环节 | 线上 `2e44baf` | mygrokbot | 状态 |
| --- | --- | --- | --- |
| gateway RPC + SSE | 212 方法 | 同词汇子集 | 已对齐 |
| 持久接纳 | `send-acceptance.json` 三态 lookup | `acceptance.mjs` | 已对齐 |
| 三 lane 队列 | user/agent/background | `scheduler.mjs` | 已对齐 |
| watchdog | 120s + 30s escape | 同 | 已对齐 |
| group-member 让路 | 有 | 有 | 已对齐 |
| harness 路由 | temporal/box/缺失 | 三态 + 拒绝语义 | 已对齐 |
| bot 通讯 | priority/held/幂等/群组 | 同 | 已对齐 |
| 主 bot | 用户指定的指针 | 同上（无特权） | 已对齐 |
| 群组房间回合 | `runRoomMemberTurn` 六态 outcome | 仅广播，无轮流发言 | **部分** |
| 回合执行 | 服务端 agent proxy | 本地 provider | 结构不同 |
| `/cursor/stores` FUSE | 权威存储 | 无 | 未实现 |
| 桌面/VNC | 3 常驻 + 5 shared，21 进程 | 无 | 未实现 |
| 错误分类 | 9+ 种 | 3 种 | 未对齐 |
