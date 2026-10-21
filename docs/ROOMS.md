# 群组轮流发言与 server-agent-proxy

## 群组：六态 outcome

从线上 host 的 `group-chat-glue.ts`（`runGroupMemberTurn` / `runTemporalGroupMemberTurn`）移植。

### 六态

`SAND_GATEWAY_ROOM_MEMBER_TURN_OUTCOMES`：

| outcome | 含义 | 是否展示 |
| --- | --- | --- |
| `delivered` | 成员说了有内容的话 | ✅ |
| `pass` | 成员无话可说 | ✅（作为"跳过"展示） |
| `skipped` | 成员不存在 / 停在交互上 | ❌ |
| `timeout` | 超过 deadline | ❌ |
| `cancelled` | 房间回合被取代或取消 | ❌ 且**终止整轮** |
| `error` | 回合失败 | ❌ |

**`pass` 不是失败。** 六态里只有 `delivered` 和 `pass` 会展示，其余只记录。

### 三条硬规则

**1. 轮流，不并行。** 房间回合一次只把发言权交给一个成员，等它的结果，再交给下一个。

**2. `isRoomTurnCurrent()` 门禁。** 每个 `await` 之后都要重新检查房间回合是否还是当前代次。被取代的回合报 `cancelled`，绝不提交过期发言。

**3. 结果按 `(member, nonce)` 幂等。** 迟到的或重复的投递不会发两次。

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

```
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
| `temporal` | `isProxiedAgent` 为真，**所有** gateway 方法先过 proxy |
| `box` | 未代理；本地回合已退役 |
| 缺失/`local` | 本地执行 |

### 两条必须照抄的语义

**1. 同一个守卫，不分方法。** 线上 host 每个方法开头都是：

```js
if (!proxy.isProxiedAgent(id)) return api.<method>(args);
return await act({ method, args }, validate, fallback);
```

没有"某些方法本地、某些远程"的特例。

**2. 拒绝不等于本地兜底。** `act()` 的 fallback 是**逐调用点 opt-in** 的，只用于服务端明确不提供的功能（比如尚未实现的房间接口）。超时或拒绝时回落到本地执行 = 让 box 跑服务端本该跑的回合，这是错的。

### 转发信封

```js
performAction({ method, args }) -> { status: 'ok', result } | { status: 'error', error }
```

`METHOD_CONTRACTS` 定义每个方法调用方可以依赖什么：

| 方法 | 校验 |
| --- | --- |
| `sendPrompt` | `{accepted, clientNonce?, acceptedAtMs?}` — nonce 必须透传，否则调用方无法轮询 |
| `promptAcceptanceStatus` | 原样返回（`outcome: found / not-found`） |
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

房间成员也可能是 temporal 的。`RoomTurns` 对这类成员走 proxy 而不是 `engine.admit`：

```js
const acceptance = this.proxy?.isProxiedAgent(memberId)
  ? await this.admitViaProxy({ memberId, prompt, nonce, room })
  : this.engine.admit({ ... });
```

`engine.admit` 有一条 `viaProxy` 参数，只有 proxy transport 会设——它是这个 agent 的执行器，本地 harness 检查不适用。

---

## 验证

离线（mock provider）：
```
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
