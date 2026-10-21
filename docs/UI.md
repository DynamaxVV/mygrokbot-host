# 界面：从 Telegram Web K 移植的规则

参照 [tweb](https://github.com/morethanwords/tweb)（Telegram Web K，**GPL-3.0**）。本项目据此也按 GPL-3.0 发布——见仓库根 `LICENSE`。

移植的是**规则与常量**，不是代码。tweb 的分组器深度依赖 Telegram 的 `Message`/`PeerId` 类型体系，把 `bubbleGroups.ts` 原样搬过来需要的适配层比重写还大。

## 1. 消息分组：121 秒

`bubbleGroups.ts`：

```ts
private newGroupDiff = 121; // * 121 in scheduled messages

return item2.fromId === item1.fromId &&
  item1.dateTimestamp === item2.dateTimestamp &&
  Math.abs(item2.timestamp - item1.timestamp) <= this.newGroupDiff &&
  ...
```

**121 秒**——不是 5 分钟，也不是 2 分钟。我第一版凭印象写了 5 分钟，是错的。

判定条件（移植后）：

| 条件 | 说明 |
| --- | --- |
| 同一发送者 | `senderKey` 相同 |
| 同一自然日 | `dayTimestamp` 相等（跨午夜必断组） |
| 间隔 ≤ 121s | 严格小于 121000ms |
| 都不是单条 | tweb 的 `!item1.single && !item2.single` |

结果分四种位置：`single` / `start` / `mid` / `end`。

## 2. 圆角：15px / 5px

`_chatVariables.scss`：

```scss
$bubble-border-radius-medium: 5px;
$bubble-border-radius-big: 15px;
```

`_chatBubble.scss` 用 `--border-start-start-radius` 等逻辑属性做分组：

```scss
&.no-brt { --border-start-start-radius: 0; --border-start-end-radius: 0; }
&.no-brb { --border-end-start-radius: 0; --border-end-end-radius: 0; }
```

移植规则：

| 位置 | 收方（左） | 发方（右） |
| --- | --- | --- |
| single | 15px 四角 | 15px 四角 |
| start | 左下 5px | 右下 5px |
| mid | 左上 5px + 左下 5px | 右上 5px + 右下 5px |
| end | 左上 5px | 右上 5px |

## 3. 时间戳在气泡内

`_chatBubble.scss`：

```scss
.time { position: absolute; bottom: 4px; inset-inline-end: 8px; }
.time-inner { margin-bottom: 5px !important; }
```

不是气泡下方独立一行——是**气泡右下角**，且带半透明底以便压在文字上仍可读（`.time-inner` 的 `background-color: var(--message-time-background)`）。

HTML 结构用 `float: inline-end` + `height: 0` 实现，让它占位但不撑高气泡。

## 4. 字号阶梯

`base.scss`：

```scss
--messages-text-size: 16px;
--messages-secondary-text-size: calc(var(--messages-text-size) - 2px);
--messages-service-text-size: calc(var(--messages-text-size) - 1px);
--messages-time-text-size: calc(var(--messages-text-size) - 4px);
```

| 元素 | 字号 |
| --- | --- |
| 正文气泡 | 16px |
| 服务消息 / 日期分隔 | 15px |
| 时间戳 | 12px |
| 次要文字 | 14px |

## 5. 服务消息是胶囊

`.bubble.service .service-msg`：

```scss
padding: .28125rem .625rem;
border-radius: inherit;   // 14px (.875rem)
```

居中、无气泡边框、半透明底。日期分隔用同一个形状，只是字重更粗。

## 6. 三层消息结构

这是 Telegram 的核心抽象，也是本项目最该照抄的部分：

| 层 | 本项目的 entry | 表现 |
| --- | --- | --- |
| 消息 | `message` / `send-message`（text） | 气泡，参与分组 |
| 服务 | `event` / `notice` | 居中胶囊，不参与分组 |
| 系统卡片 | `approval` / `question` / `tool-call` / `error` | 带边框卡片，因为需要人动作 |

**工具调用为什么不进消息流 window**：真机的 transcript partial index 过滤 `tool-call`，工具活动从 outline 单独取。本项目补了 `getAgentOutline`，UI 按 `id ↔ callId` 合并回去。

## 7. 与 tweb 的差异（有意为之）

| tweb | 本项目 | 原因 |
| --- | --- | --- |
| 蓝色主题 | 浅色 macOS + 跟随深色 | 参考图的设计语言 |
| 气泡内时间带贴纸/回形针等 | 只有时间 | 没有贴纸/回形针 |
| `mid` 排序用 server mid | 用 `timestampMs` | 没有服务端 mid |
| 分组还要求 `peerId`/`post_author` 等相等 | 只要求发送者相等 | 本项目只有一个对话维度 |

## 8. 测试

`test/grouping.test.mjs` 覆盖边界：

- 120s 内 → `start,end`
- 恰好 121s → 不分组
- 三条连续 → `start,mid,end`
- 中间断开 → `single,start,end`
- 换发送者 → 全 `single`
- 跨午夜但在 121s 内 → 仍不分组

---

## 9. 发送中（pending）状态

移植自 tweb 的 `bubbleTimelineOrder.ts` + `appMessagesIdsManager.ts`。**但这个项目里那条竞态并不存在，`src/timeline.mjs` 开头就写明了这一点，不做假移植。**

### tweb 解决什么

一条消息发出时拿临时 id，服务端确认后换真 id。如果两条连发、**第二条先被确认**，第一条就卡在旧临时 id 上，画面往上一跳。tweb 的修法：

```
BEHIND_SENT = 0.00005              // 被确认后，其它 pending 落到 confirmedMid + 这个偏移
generateTempMessageId = id + 0.0001 // 临时 id 紧跟在真 id 后面
```

### 本项目为什么不需要

| 事实 | 证据 |
| --- | --- |
| 接纳是同步的 | `admit()` 先 `appendEntry` 拿到单调 `seq`，再入队 |
| 同一 bot 回合串行 | `run-scheduler` 每 agent 同时只有一个 active |
| 因此 pending 行不可能被后来的**用户**行超越 | — |

所以 `orderWithPending` 默认按 transcript 顺序返回，只有调用方显式标记 pending 才动排序。

### 真正保留的语义：pending 的定义

**pending = 尚未终结**。终结态只有三个：

| 状态 | 算 pending？ | 理由 |
| --- | --- | --- |
| `accepted` | 是 | 已接纳，还没跑 |
| `running` | 是 | 正在跑 |
| `awaiting-approval` | **是** | 回合停下了，但从操作者视角工作还没交付 |
| `awaiting-answer` | **是** | 同上 |
| `done` / `error` / `interrupted` | 否 | 终结 |

这一条我在实现时先写错了：把 `awaiting-approval` 当成终结，导致 UI 上审批卡片一出现，"发送中"就消失了——而实际上它正等你点。

### park 不阻塞队列

我一度让 park 阻塞后续 prompt，**这是错的**。Telegram 里一张待确认的卡片不会让你没法继续发消息。`parked` Map 只用于状态展示（`isParked`），不参与调度。

### 续跑时必须关闭旧 acceptance

`resolveApproval` 会创建一个**新的** acceptance（新 nonce）。旧的 parked acceptance 如果不同时置为 `done`，它会永远留在 pending 集合里，UI 永远显示"发送中"。

这是实现时踩到的第二个坑，`parked` Map 里存了旧 acceptance 的引用专门用来关闭它。

### 客户端表现

| 元素 | 表现 |
| --- | --- |
| 气泡 | 透明度 .72 |
| 时间位 | 旋转的时钟圈（tweb 也是把时钟放在时间槽） |
| 清空时机 | `turn-end` / `turn-error` 后重拉 `getPendingEntryIds` |

### 测试

`test/timeline.test.mjs` 9 项 + `test/e2e.test.mjs` 2 项：

- 临时 id 紧贴真 id
- 被超越的 pending 落到 confirmed + BEHIND_SENT
- 排序是全序（无 a<b<c<a 环）
- 日期边界优先于位置
- 慢回合期间 pending，结束后清空（用 mock 的 `SLOW` 分支确定性地撑开窗口）
- parked 的审批行保持 pending，直到被解析

