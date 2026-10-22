# 交互调度全流程

## 当前执行流程（2026-10-22，P0/P1 后）

当前协议以 [EXECUTION.md](EXECUTION.md) 为准；常用功能见 [CORE_FEATURES.md](CORE_FEATURES.md)，启动命令见 [BUILD_AND_RUN.md](BUILD_AND_RUN.md)。本节之后保留线上 bundle 的 **F** 事实与早期 **M（历史）** 对照，旧 escape 与 JSON 台账语义属于历史。

1. `gateway.sendPrompt` 校验显示会话，群消息先进入 RoomTurns，单 Bot 按 harness 决定本地或 Proxy。目标不可运行时，在新接纳前返回错误。
2. `TurnRuntime.admit` 计算有效输入摘要，涵盖目标、会话、文本、附件、引用与执行属性。协调库事务保存接纳、Run 与投递；同 nonce 同输入回原记录，异输入报冲突。
3. outbox 幂等投影入站后，Run 排进对应 Bot 的 `user > agent > background` 队列；直接私聊在 user lane 内优先于 group-member。
4. 每 Bot 仅一个实际 segment。用户排队超过 120 秒请求取消，再过 30 秒尚未退出记 `stuck`，执行槽保持占用；`forceRelease` 也仅请求取消。`drain` 等待执行与取消钩子真实结束。
5. 工具前检查执行身份与取消版本。审批/问答保存绑定 Run、callId、参数摘要的恢复点并释放槽；批准保存决议，同一 Run 的新 segment 重新排队，单次批准只覆盖原调用。停止使待决及批准未执行卡失效。
6. 群成员读取群 Store 的唯一业务历史；其他成员作为外部输入，自己的发言作为 assistant。当前 Run 固定输入水位，未来排队消息不会提前进入模型上下文。私聊、群、任务记忆默认分开。
7. `delegate_task` 在独立 task 会话执行，只接受本地目标。父 Run 等依赖时释放槽；子任务终态和 completion outbox 同事务保存，结果满足依赖后只恢复一次父 Run。
8. 终态和结果持久保存，SSE 按显示会话路由，重连可重拉快照。重启重排安全的 accepted 工作；执行中但结果未确认的工作记 `needs-reconciliation`。有绑定的待决交互恢复，无绑定旧卡过期。

| 查询 | 当前用途 |
| --- | --- |
| `promptAcceptanceStatus` | 按 clientNonce 查询接纳与 Run 状态 |
| `getRunStatus` | 按 runId 查询持久结果 |
| `listTasks` / `getTask` | 任务关系、状态与结果 |
| `cancelTask` | 请求取消指定任务，返回当前快照，不提前宣告结束 |
| `getAcceptanceLedgerStatus` | 旧台账诊断加协调库状态计数 |

此前全量回归为 **171 通过、3 跳过（共 174）**；本次为文档核对，未重新验证 GUI、真实模型或安装包。

## 历史线上流程与早期实现

以下历史分析基于线上 bundle `2e44baf`（`sand-host-bundle-2e44baf.tgz`，sha256 `e2caadd9…`）逐模块核对。标 **F** 为源码事实，**M（历史）** 为本项目对应实现。

## 0. 一句话结论

**一次用户消息先被持久化成一个 acceptance 记录，再进该 bot 的三条 lane 队列，然后才轮到"这个 bot 由谁执行"——而线上答案几乎总是"服务端，不是 box"。**

这个顺序决定了后面所有行为：重投不重复执行、崩溃后可查、本地回合退役但仍能回执。

---

## 1. 接纳（Admission）

```text
client                gateway               ledger                queue
  │  POST /api/sendPrompt                     │                     │
  ├────────────────────>│                      │                     │
  │                     ├─ record(nonce,digest)┤                     │
  │                     │   （先落盘）          │                     │
  │                     │<─────────────────────┤                     │
  │                     ├─ append user entry ───────────────────────>│
  │                     ├─ enqueue(lane) ────────────────────────────>│
  │<── {accepted, clientNonce, acceptedAtMs} ─┤                     │
```

**F** `prompt-acceptance-ledger.ts`：

- 文件 `<sand-data>/send-acceptance.json`
- 记录：`{accountSlot, clientNonce, inputDigest, status, acceptedAtMs, agentId, echoEntryId, rejectionCode}`
- `status ∈ accepted | rejected | pending`
- 键是 `${accountSlot}\0${clientNonce}`
- 同 nonce 同内容 → 返回原记录（`replayed`）；同 nonce 不同 digest → `send/nonce-digest-mismatch`
- 查找有三种结果，**不是两种**：
  - `found`
  - `not-found`（确实没见过）
  - `unknown-durability`（历史被淘汰或降级，无法诚实回答）
- 写坏的文件必须隔离成 `send-acceptance.json.corrupt-<ms>`，并记 `corruptResetAtMs`；淘汰旧记录记 `evictionHorizonMs`；写入失败记 `.degraded` 标记

**M（历史）** `src/acceptance.mjs` 逐条实现，含 `MAX_DEGRADED_WINDOWS=8`、`.degraded` marker、`corrupt-` 隔离。测试覆盖三种 lookup 结果、nonce 冲突、坏文件降级。

---

## 2. 路由：这条消息归谁执行

**这是最容易误解的一层。**

**F** `send-pipeline.ts` `sendPrompt()`：

```js
if (gatedAgentId != null && sessions.isServerHostedAgent(gatedAgentId)) {
  throw isGroupAgentId ? SandServerRoomSendError : SandBoxHarnessRetiredError;
}
this.refuseBoxTurn(gatedAgentId ?? "unknown");   // ← 无条件
```

`refuseBoxTurn()` 内部直接 `throw new SandBoxHarnessRetiredError()`。**没有任何分支能走到本地执行。**

**F** 判定依据是 `profile.json` 的 `harness` 字段（`readSandProfileHarness`）：
- `"temporal"` → 走 `server-agent-proxy`，全部 RPC 转发
- `"box"` → 本地回合，已退役
- 字段缺失 → `null`

**F** gateway 层逐个方法做 `proxy.isProxiedAgent(id)` 判断，proxied 就转发：

| 方法 | 转发条件 |
| --- | --- |
| `sendPrompt` | `isProxiedAgent(agentId)` |
| `promptAcceptanceStatus` | 同上 |
| `interruptAgentRun` | `isProxiedAgent(id)` |
| `startFreshConversation` / `rollBackConversation` | 同上 |
| `respondToWidget` / `submitSecret` / `dismissWidget` | 同上 |

**M（历史）** `engine.route(agentId)` 返回 `{harness, lane, runnable, reason}`：
- `temporal` → `lane: 'server'`, `runnable: false`，拒绝时抛 `send/agent-unavailable`
- `box` → `lane: 'retired'`, `runnable: false`
- 其它 → `lane: 'local'`, `runnable: true`

**关键取舍：拒绝发生在写 acceptance 之前。** 一个被拒的 prompt 从未被接纳，记成 accepted 就是撒谎。

---

## 3. 排队（Scheduling）

**F** `run-scheduler.ts`：

- **每 agent 一个队列**，三个 lane：`pendingUser` / `pendingAgent` / `pendingBackground`
- 取下一个：`user` → `agent` → `background`
- user lane 内部：`takeNextUserTask` 优先取 `source !== "group-member"` 的，即**群聊成员回合给直接消息让路**
- 一个 agent **同时只有一个 active run**
- 每次出队带 `generation`（自增），用于识别"迟到的完成"

**F** watchdog：
- 默认 `RUN_WATCHDOG_DEFAULT_MS = 120000`（120s），`RUN_WATCHDOG_GRACE_DEFAULT_MS = 30000`（30s）
- 触发条件：**有 user 任务排着，且它已在 active run 后面等了超过 120s**
- 三阶段 telemetry：`trip` → （等 30s）→ `escape`
- `escape` 做的是：`active.item.resolve()`，把 active 的 settled promise 丢进 `zombies`，`queue.active = null`，然后 `pump()` 下一个
- 被放弃的 run 之后真完成时，`onTaskSettled` 发现 `queue.active.generation !== active.generation`，只上报 `late_settle`，**不复活、不改状态**

**M（历史）** `src/scheduler.mjs` 逐条实现。测试覆盖：lane 优先级、群聊让路、单 agent 串行、多 agent 并行、120s+30s 的 trip/escape/late_settle 三阶段、`dispose` 取消排队任务、诊断字段。

---

## 4. 回合内部

**F** `turn-execution` 扩展本身只有一个字段：

```js
var TurnExecutionRegistry = class {
  localWorkAllowed = true;
  get isLocalWorkAllowed() { ... }
  setLocalWorkAllowed(allowed) { ... }
};
```

真正的回合循环**不在这里**。它属于 `server-agent-proxy`（远端）或已退役的本地路径。

**F** 错误分类 `classifyAgentError`，9 种终态：

| 分类 | 触发 |
| --- | --- |
| `checkpointPublicationFailed` | 检查点发布失败 |
| `turnBackendUnreachable` | backend 不可达 |
| `backendCapacityDeferred` | 容量不足 + 有 retry-after |
| `providerOverloaded` | provider 过载 |
| `firstTokenStall` | 首 token 卡住 |
| `streamIdleStall` | 流空闲超时 |
| `contextWindowOverflow` | 上下文溢出 |
| `conversationTooLarge` | 会话过大 |
| `turnRetryable` / `streamReset` / `backendRejected` / `agentUnclassified` | 其余 |

**M（历史）** 我实现的是简化的 `turn-error` 事件 + `interrupted`/`error`/`done` 三态。**这层没有对齐**，因为本地执行器本来就是假的；照抄分类表只会得到一堆永远触发不了的分支。

---

## 5. 通知与回执（Transcript → 客户端）

**F** `server-agent-proxy` 日志出现过：

```text
server transcript tail evicted 2 settled agent state(s) holding 3 row(s);
2 state(s) holding 525 row(s) retained
server transcript tail dropped (attempt 1): ConnectError
```

即：客户端订阅的是**服务端 transcript 的 tail**，box 缓存若干 settled state，超出就淘汰；断线（ConnectError）会重试。

**F** `TranscriptEntryPublisher.publishAgent` 对 temporal agent 直接跳过（旧分析已确认）。

**M（历史）** 我的等价物是 `GET /events` SSE + `getAgentTranscript` 重拉。语义相同（事件流 + 快照兜底），实现不同（本地内存总线 vs 服务端 tail）。

---

## 6. 完整时序（把上面拼起来）

```text
用户发一条消息
  │
  1. gateway 看 profile.harness
  │    ├─ temporal → 转发 server-agent-proxy（box 只做回执与 tail 缓存）
  │    └─ box/缺失 → 写 acceptance，进队列
  │
  2. 写 acceptance（落盘，含 inputDigest）
  │    └─ 同 nonce 重投 → 回原记录，不重跑
  │       └─ 内容不同 → send/nonce-digest-mismatch
  │
  3. 进该 agent 的队列：user > agent > background
  │    └─ 群聊成员回合给直接消息让路
  │
  4. pump 一个 active run（带 generation）
  │    └─ 有 user 在后面等 >120s → trip，再 30s → escape（放弃该 run，跑下一个）
  │
  5. 回合执行（线上：服务端；本地：已退役）
  │    └─ 完成 / 失败 / 被 escape 后 late_settle
  │
  6. 结果进 transcript；客户端经 tail/SSE 看到
       └─ 断线 → 重连 + 快照重拉
```

---

## 7. 早期本项目与线上的差距（历史快照）

| 环节 | 线上 | mygrokbot | 差异性质 |
| --- | --- | --- | --- |
| acceptance 持久化 | `send-acceptance.json` + 三种 lookup | **已对齐** | — |
| 三 lane 队列 | 有 | **已对齐** | — |
| group-member 让路 | 有 | **已对齐** | — |
| watchdog 120s+30s | 有 | **已对齐** | — |
| generation / late_settle | 有 | **已对齐** | — |
| harness 路由 | temporal / box / 缺失 | **已对齐**（拒绝语义） | — |
| 回合执行 | 服务端 agent proxy | 本地 provider 直连 | **结构不同**：没有服务端可转发 |
| 错误分类 | 9+ 种 | 3 种 | 未对齐（本地执行器没有那些故障源） |
| transcript 分发 | 服务端 tail + 淘汰 + ConnectError 重试 | 本地 SSE + 快照 | 语义同、实现不同 |
| 本地回合 | 已退役 | 仍在跑 | **故意保留**：个人版没有服务端 |

最后一行是刻意的：线上把本地执行退役了，是因为主推理搬去了服务端。个人版没有那个服务端，所以本地执行必须保留——但**拒绝语义、排队语义、回执语义全部照抄**，这样一旦将来接上服务端代理，形状是对的。

---

## 8. 还没搞清的部分（继续要的东西）

| 问题 | 为什么重要 | 怎么才能答 |
| --- | --- | --- |
| `server-agent-proxy` 的请求/响应 wire 格式 | 决定能否把本地 provider 伪装成"服务端" | 需要一次真实转发抓包，或 `2e44baf` 里 `server-agent-proxy.ts` 的完整实现（bundle 里有，但只有 5 个模块线索，转发帧结构需逐行读） |
| `tail` 的 `settled state` 淘汰策略参数 | 决定客户端重连时丢多少历史 | 读 `server-agent-proxy` 的 retained/evicted 阈值常量 |
| `SandBoxHarnessRetiredError` 是否对所有 box agent 永久生效 | 决定"本地执行"这条路是死了还是休眠 | 需要官方说明或后续版本对照 |
| ~~`turn-execution` 的 `localWorkAllowed` 谁在翻转~~ | **已答**：`ResumeOwnershipService`，见下节 | — |

---

## 9. `localWorkAllowed` 的真实语义（补：已从源码确认）

这个开关不控制"能不能发消息"，它控制**启动恢复期间是否允许本地工作**。三个翻转点：

**F** `resume-ownership.ts`：

```js
async resumeAtStartup() {
  this.deps.setLocalWorkAllowed(false);        // ① 启动即关
  const recovered = await this.serialize(async () => {
    const preparedMigration = await migrationBarrier.prepare();
    const ownership = await this.reconcileWithMigration({ ... });
    if (!recovered) throw new ResumeOwnershipRecoveryPendingError();
  }, signal);
}

resumeAutomationWakesWhenReleased() {
  if (!this.disposed && this.deps.getPauseOwner() === null) {
    this.deps.setLocalWorkAllowed(true);       // ② 恢复完成后开
    this.deps.resumeAutomationWakes();
    this.deps.resumeDeferredLocalWork();
  }
}

parkFailedRecreate(startedAt) {
  this.deps.setLocalWorkAllowed(false);        // ③ recreate 失败则关
  this.deps.park();
  this.recreateRecoveryPending = true;
}
```

即：

```text
host 启动
  → localWorkAllowed = false
  → reconcile 身份 + 迁移 barrier（可能多条 lane）
  → 成功且未被 park → true，并补跑被延迟的本地工作与 routine wake
  → 失败 → 保持 false，进入 parked（等 recreate 恢复）
```

**这条解释了为什么"本地回合退役"与"本地工作仍有开关"并存**：退役的是 `sendPrompt` 的用户回合路径；`localWorkAllowed` 管的是 routine wake、延迟本地任务、以及启动恢复期的并发安全。两者不在同一层。

**M（历史）** 我没有实现这一层（个人版没有迁移 barrier、没有 parked 状态）。这是**已知差距**，不是遗漏：照抄一个没有迁移对象的 barrier 只会得到死代码。
