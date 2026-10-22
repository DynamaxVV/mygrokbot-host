# 群组轮流发言与 server-agent-proxy

## 当前群会话协议（2026-10-22，P0/P1 后）

当前持久化与取消协议以 [EXECUTION.md](EXECUTION.md) 为准，功能用法见 [CORE_FEATURES.md](CORE_FEATURES.md)。下面的六态仍适用于轮流发言，但“群聊”包含多种执行策略，并非所有发帖都自动轮流执行。

- 普通用户群帖默认 fan-out；`mentionAgentIds`、`mentions` 或正文明确 @ 决定响应者。显式空列表表示无人响应，不回退全员。`coordinated` 在没有显式响应者时选择协调者，`round_robin` 等待前一成员结果及群投影后再启动下一成员。
- 群 Store 是群业务历史唯一权威来源，群文本不再复制到成员私聊。成员 Run 的私有推理与工具记录按会话归属保存，卡片可在私聊显示，决议仍恢复原群 Run。群、私聊与任务记忆默认隔离。
- 群接纳、成员目标计划、nonce/runId 与结果保存在主机级 `execution.db`，出站投影通过 outbox 和稳定消息 ID 去重。结果查询按固定成员 nonce/runId，远端结果必须有 Run 身份；不扫描该 Bot 的最近回复。
- 轮次超时、取消、替换仅请求取消该轮成员 Run，不按整个 Bot 停止无关私聊；取消请求不等于实际退出，同 Bot 后继执行仍等待槽释放。
- Bot 主动 `postToGroup` 保存原帖并返回成员列表，不自动唤醒全员。空群也可成功保存；`woken=false` 与落盘成功是两件事。附件与 priority 的降级说明以返回 notes 为准，勿把早期“群仅纯文本”的规则套到用户附件入口。
- 群入口优先于 harness 路由，群本身不调用模型；具体 temporal 成员走 Proxy。可靠 `delegate_task` 当前只接纳本地单 Bot 目标，普通消息与群 Proxy 不受此限制。

下文的线上研究与早期真实模型结果保留为历史记录，本次文档更新未重跑真实模型或 GUI。最新全量代码回归为 **174 项：171 通过、3 跳过**。

## 群组轮次：六态 outcome

从线上 host 的 `group-chat-glue.ts`（`runGroupMemberTurn` / `runTemporalGroupMemberTurn`）移植。

### 六态

线上原名为 `SAND_GATEWAY_ROOM_MEMBER_TURN_OUTCOMES`；本项目导出 `OUTCOMES` 与 `SHOWN_OUTCOMES`：

| outcome | 含义 | 是否展示 |
| --- | --- | --- |
| `delivered` | 成员说了有内容的话 | ✅ |
| `pass` | 成员无话可说 | ✅（作为"跳过"展示） |
| `skipped` | 成员不存在 / 停在交互上 | ❌ |
| `timeout` | 超过 deadline | ❌ |
| `cancelled` | 房间回合被取代或取消 | ❌ 且**终止整轮** |
| `error` | 回合失败 | ❌ |

**`pass` 不是失败。** 六态里只有 `delivered` 和 `pass` 会展示，其余只记录。

### round_robin 的三条规则

**1. 轮流，不并行。** 房间回合一次只把发言权交给一个成员，等它的结果，再交给下一个。

**2. `RoomTurns.isCurrent(turn)` 门禁。** 每个 `await` 之后都要重新检查房间回合是否还是当前代次。被取代的回合报 `cancelled`，绝不提交过期发言。

**3. 结果按 `(room, member, nonce)` 幂等。** 迟到的或重复的投递不会发两次。

### pass 的判定（实测踩到的坑）

提示词要求成员"无话可说就只回复 `pass`"。**真实模型真的会输出字面 `pass`**，而不是空字符串。

第一版只把「空文本」当 pass，结果模型回了个 `pass` 被记成 `delivered`——房间里出现一条内容是 "pass" 的发言。

现在两种都认：

```js
export function isPass(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;                    // 沉默
  return /^[\s"'`*_]*pass[\s"'`*_.!]*$/i.test(t);  // 字面 pass（含引号/标点变体）
}
```

`isPass('passed the test')` 是 `false`——真句子不算 pass。

### 房间提示词

成员看到的不是普通对话，开头就说明这是房间：

```text
You are in the group chat "<name>".
Room purpose: ...
Other members: A (id), B (id).

This is a room turn, not a private chat. Rules:
- Reply only if you have something worth adding. If not, reply with exactly "pass" and nothing else.
- You are speaking to the room, not to one person.
- Do not repeat what another member already said.
- Do not acknowledge with pleasantries; silence is the preferred acknowledgement.

Since your last turn:
  [human:operator] ...
```

---

## server-agent-proxy：temporal agent 的转发

### 路由依据

`profile.json` 的 `harness`：

| harness | 行为 |
| --- | --- |
| `temporal` | 单 Bot 的代理方法经 `isProxiedAgent` 转发；群入口先走房间协调 |
| `box` | 未代理；本地回合已退役 |
| 缺失/`local` | 本地执行 |

### 线上代理研究（历史背景）

**1. 同一个守卫，不分方法。** 线上 host 每个方法开头都是：

```js
if (!proxy.isProxiedAgent(id)) return api.<method>(args);
return await act({ method, args }, validate, fallback);
```

这是线上 host 的历史代理约定。当前 gateway 对群入口、显示会话与本机任务查询另有明确的本地协调边界。

**2. 拒绝不等于本地兜底。** `act()` 的 fallback 是**逐调用点 opt-in** 的，只用于服务端明确不提供的功能（比如尚未实现的房间接口）。超时或拒绝时回落到本地执行 = 让 box 跑服务端本该跑的回合，这是错的。

### 转发信封

```js
performAction({ method, args }) -> { status: 'ok', result } | { status: 'error', error }
```

`METHOD_CONTRACTS` 定义每个方法调用方可以依赖什么：

| 方法 | 校验 |
| --- | --- |
| `sendPrompt` | 保留原对象与接纳/Run 身份，规范化 accepted；nonce 透传供固定成员查询 |
| `promptAcceptanceStatus` | 原样保留状态/结果对象；无对象时返回 not-found，群结果还校验 runId |
| `interruptAgentRun` | `{hadActiveRun}` |
| `respondToWidget` | `{accepted}` |

### 本地替身

`createLocalTemporalTransport` 用同一信封在本进程执行回合，**目的是打通路由，不是伪造云端**。换成真实客户端时 gateway 一侧不用改。

```js
const proxy = new ServerAgentProxy({
  roster,
  transport: createLocalTemporalTransport({ engine, roster }),  // ← 换这里
});
```

### 房间里的 temporal 成员

房间成员也可能是 temporal 的。当前调用链是 `RoomTurns.dispatchTarget` → `engine.dispatchAdmission` → Proxy 或 `engine.admit`。目标计划与调用参数先持久保存，再投递并保存返回的 Run 身份；恢复时复用同一成员 nonce。

`engine.dispatchAdmission(args)` 对 temporal 成员执行 `proxy.act({method: 'sendPrompt', args})`，本地成员执行 `engine.admit(args)`。内置 `createLocalTemporalTransport` 在校验会话/成员归属后以 `viaProxy` 接纳；替换真实传输时仍须保留会话身份、runId 与结果契约。

---

## 历史验证记录

离线（mock provider）：
```text
✔ 一轮按顺序跑完每个成员
✔ 房间提示词声明可以 pass
✔ 成员沉默 → pass
✔ provider 不可达 → error，且整轮继续
✔ 取消 → 剩余成员 cancelled
✔ 成员停在审批 → skipped
✔ 超 deadline → timeout
✔ 同 nonce 重复提交返回首次结果
✔ 只有 delivered/pass 展示
✔ 空房间不触碰成员
✔ 成员被删 → skipped
✔ 字面 pass 判定
```

真实模型（`workbuddy/hy3`）：

| 场景 | 结果 |
| --- | --- |
| temporal agent 经 proxy 发消息 | `proxied=true`，`accepted=true`，最终 `done` |
| 双 bot 房间（1 temporal + 1 local） | `delivered` + `pass`，两个成员都走对路径 |
| 角色化房间（架构师 + 怀疑者） | 两个 `delivered`，内容视角明显不同 |
