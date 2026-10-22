# MyGrokbot 多 Bot 协作：代码复核与改造建议

> 日期：2026-10-22（Asia/Shanghai）  
> 基线：`d498dd83dca901d8d2a7db6a40e1ecabc9e9a7c4`；Node `v26.5.0`。  
> 对象：[上一版评估](REVIEW_2026-10-22_MULTIBOT.md)及当前源码。  
> 阅读优先级：本报告替代上一版第二、三部分的评估与补丁建议。上一版第一部分属于对分享对话的整理摘要，不是逐字原文。本次没有重新验证 GrokBot、DSH 的外部资料。  
> 本文是基线版本的代码审查与缺陷复现记录，保留原证据结论。后续 P0/P1 已实施，当前交付状态、修复映射和回归结果见 [实施交付报告](2026-10-22_p0-p1-implementation.md)，执行协议见 [EXECUTION.md](EXECUTION.md)。历史复现通过表示当时观察到了缺陷，不是当前修复验收。

## 1. 我的评估

上一版抓住了正确方向：Bot 身份、会话历史、任务目标和执行生命周期需要分开，现有 Gateway、Roster、Provider、SQLite 也值得保留。但其证据描述、分阶段顺序和补丁示例不足以直接用于实施。尤其是提前移除 `hidden`、请求 abort 后立即放行下一任务、只用 `held` 通知父 Bot，会分别造成隔离回退、执行重叠和派工停滞。

当前最需要解决的是三类一致性问题：**输入属于哪个会话、输出属于哪次执行、等待与恢复属于哪个任务。** 在它们稳定之前，增加更多派工工具和群聊模式会放大问题。

我的建议是保留单机单进程、同 Bot 串行的执行方式，先建立固定 Run 上下文，修复隐藏标记和取消/审批生命周期，再把会话、接纳记录、结果投递做成可恢复的状态，最后实现统一群聊入口和任务依赖恢复。无需移植完整 DSH 插件体系，也无需引入独立服务。

本次已运行：现有 7 个离线测试文件 **101/101 通过**；新增本地 Mock 复现 **9/9 观察成立**；并发/审批/计时器隔离用例 **12/12 观察成立**。后两组断言检验当前缺陷行为。它们说明现有测试遗漏了关键交叉场景。

## 2. 证据、范围与复现方式

详细范围见 [scope.md](../analysis/review-2026-10-22/scope.md)。证据分为真实 Host + SQLite + 本地 Mock、真实源码配合依赖桩、静态路径分析三种，不混用证据等级。并发桩验证了控制流和资源归属，没有执行真实 shell 子进程，也没有完成真实模型压力、真实浏览器或进程 kill/restart 测试。

| Evidence | 方法与产物 | 已观察结果 |
|---|---|---|
| B01 | [基线日志](../analysis/review-2026-10-22/baseline.log)，7 个既有测试文件 | 101 通过，0 失败 |
| E01 | [主复现记录](../analysis/review-2026-10-22/main-observations.json)，正常 `createGroup()` 后 Bot 发帖 | `delivered=true`，收件人数 0，群帖未落盘 |
| E02 | 同上；真实 Mock Provider 请求体 | 私聊哨兵进入群聊模型输入；群 prompt 已隐藏落盘；上轮群消息不进入下一轮 |
| E03 | 同上；用可控队列屏障安排两群任务 | 甲群 0 条回答，乙群收到甲群回答，乙群自身回答丢失 |
| E04 | 同上；同群重复提交相同 nonce | 2 条群帖、2 次模型调用；队列来源均为 `user` |
| E05 | 同上；隐藏群回合开始时入站一条私聊 | 无需审批，私聊 prompt 已被标记隐藏 |
| E06 | 同上；隐藏 Run 进入审批等待并处理否决 | `hideWrites` 残留；私聊隐藏；否决抛出 `turnId is not defined` |
| E07 | 同上；同一数据根重建 Host 对象 | 完成状态由 `done` 变回 `accepted`；不是完整进程故障恢复测试 |
| E08 | 同上；重建 Host 后重发 peer messageId | 同 messageId 产生 2 条入站记录 |
| E09 | 同上；同 nonce、同文本、不同目标 Bot | 返回原 Bot 的 acceptance，没有报告冲突 |
| C01 | [并发记录](../analysis/review-2026-10-22/concurrency-review-results.json)第 1 项；真实引擎 + 工具等待桩 | watchdog 未 abort 旧 controller，escape 后新 Run 与旧工具重叠 |
| C02 | 同上第 2 项；真实 Scheduler | `forceRelease` 后并发数 2；旧任务未退出，`drain` 已返回 |
| C03 | 同上第 3 项；模拟旧报告补丁 E | 即使补上 abort 回调，最大并发仍为 2，后继启动时尚未 quarantine |
| C04 | 同上第 4 项；真实 RoomTurns + Scheduler | 连续两轮 timeout 后，仍只有 1 个成员 Run 启动，另一个排队 |
| C05 | 同上第 5～7 项；审批/问答恢复 | 批准工具绕过队列；停止后旧审批仍可执行；回答旧卡误配最新问题调用 |
| C06 | 同上第 8～9 项；虚拟计时器 | done 后 timer 未清理；空闲回调抛 ReferenceError；旧 timer 可中止新 Run |
| C07 | 同上第 10～12 项；工具和文件系统桩 | park/abort 后隐藏标志残留；工具不接取消信号；中止后模拟副作用仍完成 |
| S01 | 当前源码及旧报告的静态交叉审查 | 上下文字段、返回结构、RPC、UI、迁移和完成协议的接口缺口，详见后文 |

在仓库根目录执行：

```bash
node --test test/unit.test.mjs test/scheduling.test.mjs test/room.test.mjs test/e2e.test.mjs test/proxy.test.mjs test/timeline.test.mjs test/grouping.test.mjs
node --test analysis/review-2026-10-22/main-repro.test.mjs
node --experimental-vm-modules analysis/review-2026-10-22/concurrency-review-harness.mjs
```

新增脚本分别为 [主复现脚本](../analysis/review-2026-10-22/main-repro.test.mjs)与[并发复现脚本](../analysis/review-2026-10-22/concurrency-review-harness.mjs)。主复现创建隔离数据目录，关闭 Host 后校验绝对路径并清理自身目录；观察记录和日志保留。并发脚本使用 VM Modules，其 ExperimentalWarning 是 Node 提示。未启用现有真实模型 opt-in 测试；基线套件沿用现有测试的绑定和错误路径。

## 3. 需要优先修复的实际问题

以下 Finding 均给出 Evidence、代码位置和处理路径。`validated` 指静态代码与动态观察一致；`static-confirmed` 指当前接口或设计缺口已由源码确认，未声称复现所有用户后果。

### F01：会话隔离存在两个方向的问题

- **级别 / 状态：P0，validated；Evidence：E02、E05、E06、C07。**
- **位置：**[上下文过滤](../src/engine.mjs#L131)、[立即写入用户消息](../src/engine.mjs#L290)、[全局隐藏开关](../src/engine.mjs#L398)、[Store 写入](../src/db.mjs#L198)。
- 群回合仍会加载普通非隐藏私聊历史。E02 在实际 Provider 请求体中看到了私聊哨兵。因此当前既有群历史缺失，也有私聊进入群输入的反向泄漏。是否被模型复述给群成员取决于模型，输入层混入已经成立。
- 同一 Store 的 `hideWrites` 影响所有入站写入。Scheduler 只串行执行，不会阻止用户消息在另一个 Run 运行中立即落盘。E05 无需审批就隐藏了私聊 prompt。
- `try/finally` 只修复退出后的残留，修复不了活动期间并发入站被污染。
- **处理路径：**去掉 Store 级 `hideWrites`；每条运行产物由固定上下文显式携带归属与展示属性；入站消息根据自己的会话标记。端到端会话过滤完成前，保留逐条 `hidden` 作为旧 UI 的兼容属性。

### F02：群来源与真实投递结果不一致

- **级别 / 状态：P0，validated；Evidence：E01、E03。**
- **位置：**[Bot 级来源 Map](../src/engine.mjs#L61)、[完成时取群目标](../src/engine.mjs#L996)、[群成员读取](../src/engine.mjs#L1087)、[正常建群](../src/roster.mjs#L108)。
- `groupOrigin[botId]` 在任务排队时就被下一群覆盖，执行层串行也消除不了这个竞态。
- 正常群的成员在 `group.json`，Bot 发帖却读 `profile.memberIds`；同时没有先写原始群帖，成功回执与实际不符。
- **处理路径：**接纳时固定 `conversationId`、`triggerMessageId` 和输出目标；完成后只按本 Run 上下文投递。成员统一读取 `groupMembers()`。把“消息已经持久化”“哪些成员被安排执行”“哪些结果已交付”作为不同字段，别用成员数判断整个群帖是否成功。空群可以成功存下一条帖，且没有成员被唤醒。

### F03：取消只改变队列/流，副作用可能继续

- **级别 / 状态：P0，validated；Evidence：C01、C02、C03、C07。**
- **位置：**[watchdog escape](../src/scheduler.mjs#L299)、[forceRelease](../src/scheduler.mjs#L211)、[工具执行入口](../src/engine.mjs#L536)、[shell 执行](../src/tools.mjs#L238)。
- Scheduler 的 watchdog telemetry 在当前引擎中只发布事件，没有连到 Run 取消。escape 直接让出 active，旧工具仍可运行。
- 工具执行未收到 AbortSignal，shell 也没有可管理的子进程生命周期。中止模型流不等于中止已执行的工具。
- `forceRelease` 还会让 `drain` 提前完成。它经 `interrupt()` 进入的条件是未找到 controller，不能据此宣称“更常见”。
- **处理路径：**保留同 Bot 一个活跃执行段。取消进入 `cancelling`，请求终止具体执行段并等待其实际退出，再放行下一项。工具不响应取消时保留占用并展示原因；如果未来采用隔离 Worker，必须确认 Worker/子进程退出。写入、SSE、镜像、后续工具启动和结果提交都检查 Run + 代际，防止迟到回调污染新执行。

### F04：审批与问答恢复没有绑定原执行

- **级别 / 状态：P0，validated；Evidence：E06、C05、C07。**
- **位置：**[批准后直接执行](../src/engine.mjs#L767)、[问答查最新调用](../src/engine.mjs#L813)、[停止所覆盖状态](../src/engine.mjs#L840)、[审批有效性检查](../src/review.mjs#L131)。
- 批准后的工具在 `enqueue` 之前执行，能与同 Bot 的另一个 Run 重叠。
- TTL 和卡片未决检查没有验证原 Run 仍可恢复；`interrupt()` 也没有终结 `awaiting-approval` 状态，旧卡仍可能启动副作用。
- `answerWidget()` 根据“最新未回答的 ask_user”寻找调用，回答旧卡可以配到另一个 Run。
- 静态补充：[单次批准](../src/engine.mjs#L767)也加入了全引擎 `approvedCommands` Set，后续按命令字符串复用到其他 Bot/工作目录。单次批准应绑定原 callId 与参数，只有 `always` 才建立长期规则；这项尚未单独做动态复现。
- **处理路径：**持久化 `approvalId/widgetId → runId → callId`。点击只提交决议与恢复请求；实际工具执行必须重新进入同 Bot 的调度队列，并在执行前校验取消版本和原调用状态。等待期间可释放执行槽，让私聊继续可用；等待对象与原上下文持续存在。恢复同一逻辑 Run 的新执行段，不新建一条丢失来源的独立任务。

### F05：已结束 Run 的计时器会破坏后续 Run

- **级别 / 状态：P0，validated；Evidence：C06。**
- **位置：**[timer 回调](../src/engine.mjs#L405)、[正常完成](../src/engine.mjs#L647)、[catch 才清理 timer](../src/engine.mjs#L674)。
- 正常结束与进入审批等待均没有清理本段 watchdog。回调按 `agentId` 查 controller，可能取消新的 Run、删除新运行状态。
- 没有 controller 时执行 `acceptances.delete(acceptance.id)`，其中 `acceptances` 未定义；该分支抛出 ReferenceError。实际 Node 对未捕获计时器异常可能终止进程；本次通过假计时器直接调用确认异常，没有让真实进程崩溃。
- **处理路径：**timer 归具体 `segmentId` 所有，所有执行段出口用 `finally` 清理本地 timer。回调操作前验证 Run/执行段仍为当前 active；清理也采用身份相等判断，避免旧 Run 删除新 Run 的资源。

### F06：接纳、完成和投递没有统一持久语义

- **级别 / 状态：P1，validated；Evidence：E04、E07、E08、E09。**
- **位置：**[群接纳](../src/engine.mjs#L1017)、[内存 peer 去重](../src/engine.mjs#L892)、[nonce 摘要](../src/acceptance.mjs#L129)、[严格反序列化](../src/acceptance.mjs#L241)。
- 群接纳不走相同的 nonce 幂等；peer 去重只是 512 条容量的内存 Set，群目标在检查前已经返回。
- nonce 的输入摘要只含文本，改变目标、附件或回复引用不会形成完整的输入冲突语义。
- Ledger 记录的是接纳，当前只更新 echoEntryId；它不保存完成状态、Run 上下文或任务结果。重建 Host 后完成状态回到 `accepted`。直接给记录加新字段也会被当前 `coerceRecord()` 丢弃。
- **处理路径：**接纳幂等、Run 状态、业务结果、投递确认分别持久化。相同请求的重试复用稳定 ID；使用完整规范化请求摘要检测冲突。任务完成与 outbox 同事务写入，投递端以稳定事件 ID 去重。`durable=true` 应明确只表示哪一层状态已经持久化。

### F07：群聊与模型输入的“投影规则”缺失

- **级别 / 状态：P1，static-confirmed；Evidence：S01，部分群连续性后果由 E02 支持。**
- **位置：**[两套入口](../src/gateway.mjs#L178)、[全部 send-message 映为 assistant](../src/engine.mjs#L186)、[逐成员执行](../src/room.mjs#L48)、[扫描最近回答](../src/room.mjs#L179)。
- 普通 UI fan-out 与 `RoomTurns` 是两条执行路径；群的事实历史与成员的私有执行记录没有一致来源。
- 把群时间线直接并入现有 `buildMessages` 会把其他 Bot 的回答当成当前 Bot 的 assistant。用户在排队期间送入的后续 prompt 也可能被当前 Run 提前读到，因为每个工具步骤都读取全表，没有输入水位。
- **处理路径：**群业务消息只有一份权威历史。保存稳定 `messageId`、会话顺序和发送者；当前 Bot 的发言才投影为 assistant，其他 Bot 的发言投影为带明确身份的外部输入。私有工具轨迹只从当前 Bot 对应 Run/执行段取，保持 tool call/result 成对。Run 开始时冻结输入水位；仅显式 steering 才引入后续消息。

### F08：派工缺少等待依赖与父任务恢复协议

- **级别 / 状态：P1，static-confirmed；Evidence：S01、当前 held 分支。**
- **位置：**[Bot 消息投递](../src/engine.mjs#L881)、[held 不唤醒](../src/engine.mjs#L938)、[系统提示对派工的承诺](../src/engine.mjs#L95)。
- `message_agent` 是自由通信，不提供可追踪的任务完成与自动回传协议。模型可以主动发回消息，但系统没有保证。
- 新方案若只把结果写成 `held:true`，父 Bot 已结束时仍不会自动继续汇总。
- **处理路径：**新增任务语义时同时登记父子依赖。子任务终态产生持久化 completion event；依赖满足后只恢复一次父 Run。普通 FYI 继续 held，任务完成是可操作的恢复事件。父 Run 等待期间释放执行槽，避免同 Bot 委派或回环占槽死锁。

## 4. 上一版文档具体需要怎样修正

| 旧报告内容 | 我的修正 | 证据或原因 |
|---|---|---|
| “8 个中 7 个确认，1 个部分成立”，表格又全标成立 | 取消这种计数，按静态确认、动态观察和待测后果分别标记 | 旧报告结论与自身表格不一致 |
| 被 @ 成员完全不写 Store | `admit()` 会写 hidden prompt；问题是后续过滤排除，不是没有存储 | E02；[admit](../src/engine.mjs#L290) |
| 群 timeout 后下一轮立即双活 | timeout 只停止 RoomTurns 等待，active 仍占用；会遗留工作、产生队列积压，双活需要另一个释放条件 | C04 |
| 追加第 9～11 项为独立问题 | 缺 finally 与原审批残留重叠；priority 对群忽略是既定语义；虚假投递是成员数据源问题 | 不重复计数，不把正常协议行为当缺陷 |
| 补丁 A 提前去掉 hidden | 现有模型和 UI 仍依赖 hidden，单独应用会把群记录带入私聊 | [UI 过滤](../src/ui/index.html#L2116)；F01 |
| 补丁 C 用 finally 恢复 hideWrites 即可 | 活动期间的并发入站仍污染；应去掉 Store 级开关 | E05 |
| 补丁 D 从 parked 直接读取来源 | 真正字段在 `parked.acceptance`，并且要恢复完整原调用，不只是复制三个字段 | [parked 结构](../src/engine.mjs#L598)；C07 |
| 补丁 E abort 后立即 pump，2 秒后 quarantine | 仍双活；入队接口还没有保存 abort/quarantine，执行端也没检查 | C03 |
| 按时间戳合并 own + roomRows，后续映射不变 | 会重复、乱序并冒充其他 Bot；不同数据库 seq 不是同一个顺序 | F07 |
| S2 用 Promise.all 实现 round_robin | 实际并行启动全部成员；round_robin 必须逐成员等待提交后再推进 | 旧报告 §3.3 的批量启动示例 |
| S3 complete 只写 held 结果 | 不保证父任务自动汇总；依赖屏障、恢复事件及去重必须一起实现 | F08 |
| “已有去重，补一个群 nonce 测试即可” | 去重未跨群接纳、重启及容量淘汰，需要持久化约束 | E04、E08、E09 |
| “没有 run.end 就是未交付” | 执行结束、结果提交、结果投递和确认是不同状态 | 已投递未记 end / 已记 end 未投递均可能存在 |
| 180/250/320 行的实现规模承诺 | 移除；RPC、UI、代理、迁移、故障恢复尚未覆盖，行数缺乏依据 | 应按可验收切片规划 |

示例还有明确接口错误：`accumulatedRef` 未定义；`st.acceptance?.resultText` 与 [acceptanceStatus 的顶层字段](../src/engine.mjs#L356)不符；`admit` 不支持 `onSettled`；`appendInbound`、`abortRunByTaskId` 尚不存在；TaskDispatcher 构造未保存依赖；`host.on('provider-request')` 不是 [Host](../src/host.mjs#L83)/[EventBus](../src/bus.mjs#L11)提供的接口。因此应把这些代码视为未完成的设计草图，重新按真实接口实现，而不是逐段复制。

## 5. 建议的目标设计

### 5.1 固定身份与状态边界

| 对象 | 不变的身份与职责 | 生命周期 |
|---|---|---|
| Bot | botId、角色、模型绑定、技能、明确允许共享的长期记忆 | 长期存在 |
| Conversation | conversationId、类型、参与者与业务消息顺序 | 独立历史 |
| Task | taskId、目标、父子关系、依赖、结果接收方 | 跨多次模型执行 |
| Run | runId、botId、conversationId、triggerMessageId、taskId、输出目标 | 一次逻辑工作，可等待与恢复 |
| Segment | segmentId、runId、epoch、controller、timer、工具句柄 | 一次实际占用执行槽的区间 |
| Acceptance | requestId/clientNonce、输入摘要、已接纳对象 | 接纳与重试契约 |

先在接纳时分配 `runId`，再排队；等待审批、问答或子任务时，Run 身份不变，后续恢复产生新 Segment。`clientNonce` 保持客户端幂等用途；现有 `turnId` 可在兼容期代表 Segment，避免同时引入同义 ID。

`RunContext` 至少保存：`runId`、`botId`、`conversationId`、`triggerMessageId`、`taskId`、固定输出目标。执行段另保存 `segmentId/epoch/inputThroughSeq`。不要把这些信息分别藏在 Bot Map、提示词前缀和 UI 当前选中项中。

跨会话记忆和工具访问应有明确产品规则：角色/偏好可以共享，私聊事实是否进入长期记忆并供群聊使用要显式区分。修复 Transcript 隔离不代表共享 workspace、记忆或工具自动获得了隔离边界。

### 5.2 一个权威历史，明确模型输入

群业务消息以 `(conversationId, conversationSeq, messageId)` 排序和去重。成员“收到消息”可以保存游标/投递状态，不必复制整段文本到每个私聊 Store。运行诊断和工具轨迹保留在私有 Run 记录。

构造模型输入时：

1. 加载 Bot 的角色、模型策略和允许共享的记忆。
2. 加载当前 Conversation 在输入水位以内的权威消息。
3. 根据 speakerId 相对当前 Bot 决定 role；其他成员携带明确的名称与 ID。
4. 加载当前 Run 的私有工具步骤，保证调用与结果相邻、ID 对应、没有孤立 tool result。
5. 排除 partial、取消代际和归属不明的旧历史；对允许的跨会话引用单独记录来源。

JSON Entry 可以兼容增加字段，但严格过滤启用前必须同时完成所有 writer 的标注和历史迁移。不要通过“缺 conversationId 默认当前会话”掩盖迁移问题。

### 5.3 同 Bot 串行，等待不占执行槽

状态可收敛为：

| Run 状态 | 是否占执行槽 | 后续动作 |
|---|---|---|
| queued | 否 | Scheduler 选择执行段 |
| running | 是 | 推理与工具执行 |
| awaiting_approval / awaiting_answer / waiting_children | 否 | 保存恢复点，接受其他会话工作 |
| cancelling | 是，直至当前工具/执行段退出 | 终止具体资源，禁止继续启动工具 |
| completed / failed / cancelled | 否 | 终态幂等提交与结果交付 |
| needs_reconciliation | 根据是否仍有活资源决定 | 显示待核对原因，避免自动重放未知副作用 |

每段 `finally` 清理自己的 timer/controller，只有 `active.segmentId` 仍匹配才清理 Bot 占用。审批恢复必须先经过 Scheduler，再执行批准的工具。shell 取消要管理子进程退出；仅向 shell 发信号不保证其所有后代已停止。对共享文件的多 Bot 并发可另加资源锁或原子写，Bot 串行并不等于全 workspace 串行。

队列优先级先保留现有三 lane，区分 `source=user/group-mention/group-member/agent/background`，修复普通群帖误标 `source=user`。优先级只影响尚未开始的任务；运行中的任务是否取消是单独策略。后续再按队列等待指标决定是否加入 aging，避免后台任务饥饿。

### 5.4 增量持久化与可靠投递

建议增量增加一个**主机级 SQLite 协调库**，与现有 Bot Store 共存。它仍在本进程内，不引入服务。相比继续扩充严格裁剪字段的 JSON Ledger，更适合把状态转换、依赖与待投递事件放进同一事务。

| 数据 | 至少保存的内容 | 约束 |
|---|---|---|
| admissions | 请求作用域、nonce、完整有效输入摘要、messageId/runIds | 同作用域 nonce 唯一；不同有效输入冲突 |
| conversations/messages | 会话、成员策略、会话序号、发送者、内容、稳定 messageId | `(conversationId, seq)` 与 messageId 唯一 |
| runs/segments | 固定上下文、状态、代际、恢复点、输入水位、结果 ID | 状态转换按预期版本提交 |
| interactions | approval/widget ID、runId、callId、决议、取消版本 | 旧卡和重复点击不产生第二次执行 |
| outbox/inbox | 事件 ID、目的地、尝试次数、消费确认 | 同目的地事件仅应用一次 |
| tasks/dependencies | 后续派工阶段追加父子任务、等待策略、恢复键 | 同依赖完成仅消解一次 |

新业务消息与接纳/待执行项在协调库里统一提交，现有群与 Bot Transcript 可以作为兼容投影，投影以原 messageId 幂等写入。渐进迁移时应明确每个版本的权威来源，禁止把两份镜像同时当独立事实读取。流式 delta 可以继续走现有机制，不必把每个 token 都事件溯源。

请求摘要覆盖目标、会话、文本、附件身份/版本、replyTo、明确提及、执行策略和其他影响执行的参数。客户端发送前生成 nonce，重试复用；新一轮用户意图使用新 nonce。不要仅凭目标与文本哈希的短时间相同就合并合法的重复任务。

采用“持久投递至少一次 + 消费幂等”的协议；把结果提交、结果投递和消费确认分开。崩溃恢复优先补投递，再依据工具执行状态判断是否恢复执行。外部副作用已启动但结果未知时标记待核对，不能把重试宣称为天然 exactly-once。

### 5.5 群聊共用入口，策略与执行器分开

在现有 [room.mjs](../src/room.mjs)上逐步收敛协调职责，避免新增一套 Coordinator 后仍保留原两套独立引擎。统一执行路径为：接纳并落盘 → 决定发言成员 → 调度固定 Run → 提交业务结果 → 决定是否继续轮次。

第一版先保留现有 fan-out 与明确 @ 的行为作为兼容策略，把 directed、coordinated、round_robin 做成可选策略；不要在修复中悄悄把默认全员响应改成只由一个主 Bot 回答。

- 定向模式尊重结构化 mentionAgentIds；显式 @ 优先于默认协调策略。无有效成员时返回明确状态，不回退成全员执行。
- 轮流模式逐个等待结果，提交并更新群水位后再启动下个成员，后者能读到前者刚发的内容。
- 成员取消/超时按 runId 传播；轮次结果直接读取对应 Run 的结果 ID。旧轮次只清理属于自己的 roundId，不能删除新轮次。
- Bot 主动向群发一条 FYI 只产生消息，不默认开启新轮次；`pass` 属于成员执行结果，不作为普通内容再广播唤醒。
- remote/temporal 成员沿用代理路由，不得因为入口合并而改成无条件本地 `engine.admit()`。

### 5.6 派工必须完成父任务自动恢复

`message_agent` 继续用于普通通信，`delegate_task` 承担目标、完成条件与返回关系。后者应在 Run/Conversation/持久投递稳定后上线。

工作流程应为：父任务创建子任务并登记依赖 → 父 Run 进入 `waiting_children` → 子任务执行、等待交互或到达终态 → 同事务保存结果与 completion outbox → 消费事件并消解依赖 → 满足等待策略时生成唯一 parent-resume → 父 Run 继续汇总并交付用户。

完成、失败和取消都必须进入上述协议；`awaiting_approval` 不是任务完成。重复、乱序完成只消解一次依赖；用户取消父任务后，子结果仍可用于审计，但不再唤醒旧父任务。恢复不能只靠非持久 onSettled 回调。

活动上限 4、嵌套深度 2 可以作为初始配置，计数应覆盖整条根任务链，而不只是单个发送 Bot。另限制总激活次数、总耗时或总 token，防止浅层反复通信消耗无限预算。具体默认值需根据使用数据调整。

### 5.7 RPC、SSE、UI 与迁移要同步

[Transcript/Outline RPC](../src/gateway.mjs#L193)目前只按 agentId 读取，Outline 还会抹掉隐藏和上下文信息；[SSE UI](../src/ui/index.html#L3338)主要按 agentId 分流。仅改 `buildMessages()` 无法解决展示归属。

新事件与查询应带 conversationId、botId、runId、segmentId；Bot 忙闲按 botId 统计，聊天时间线按 conversationId。包括 text/reasoning delta、工具纲要、审批卡、错误和通知，都使用同一规则。保留 [发送回执](../src/ui/index.html#L3106)里的 entryId/clientNonce/acceptedAtMs，新增字段应向后兼容，附件与 replyTo 也要原样传递。

迁移时保留旧 entryId 与 nonce，并记录 schemaVersion/migrationVersion。可明确归属的私聊与群历史按来源导入；`hidden` 或 `[group:名字]` 前缀本身不足以证明群 ID，归属不明记录进入只读 legacy 区，不自动归入当前私聊。旧运行标记 interrupted/needs_reconciliation，再恢复可确认的投递。切换读路径前备份并验证新旧投影数量和摘要一致，回滚程序也必须识别新的执行段状态。

## 6. 推荐实施顺序与验收标准

| 切片 | 必须一起完成的内容 | 完成门槛 |
|---|---|---|
| PR1：当前运行时稳定化 | 固定 Run 输出身份；每条写入显式归属，移除 Store hideWrites；成员来源与群帖落盘；timer 全出口清理；具体执行段取消；审批进入队列并绑定原调用；Room 结果与 roundId 校验 | E01/E03/E05/E06 与 C01/C05/C06/C07 对应“正确行为”回归通过；真实不可取消慢工具另测退出前不放行 |
| PR2：持久接纳与生命周期 | 版本化协调库、稳定 ID、完整 digest、Run 终态、投递 outbox/inbox、旧 ledger 导入 | 重启后状态不倒退；同 nonce 群重试、peer 重试与投递重试不重复；确认每个故障窗口 |
| PR3：端到端 Conversation | 统一上下文字段、权威历史、role 投影、输入水位、所有 writer/RPC/Outline/SSE/UI/代理同步、历史迁移和读切换 | 私聊/两群哨兵绝不串；其他 Bot 身份正确；一个 messageId 只入模型一次；刷新前后展示一致 |
| PR4：群聊入口收敛 | 在同一 room 协调层实现兼容 fan-out、定向与串行轮次，稳定结果引用 | 显式 @ 行为、附件/引用/回执/代理不退化；B 确实在 A 结果提交后启动并读到结果 |
| PR5：任务闭环 | delegate_task、父子依赖、等待/取消/失败、唯一恢复事件、根任务预算 | 没有新用户消息时父任务也能自动汇总；重复/乱序子结果只恢复一次；取消父任务后不再唤醒 |
| PR6：性能与可观测性 | 按会话索引、上下文预算、角色/记忆版本缓存、任务详情与队列指标 | 依据数据比较模型输入规模、读库耗时、队列等待、重复投递率，不以行数或组件数验收 |

PR1 不提前移除逐条 `hidden`；直到 PR3 的新投影、RPC 和 UI 同步切换后，它才降级为纯展示属性。PR2 的恢复基础先于 PR5，执行日志也从 PR1 就开始携带 Run 身份，不留到所有功能完成后再补。

性能方面，[当前 buildMessages](../src/engine.mjs#L137)每个工具步骤都全表读，系统提示也反复读取角色/记忆与名单。正确性修好后再引入 `(conversationId, seq)` 查询与 token 水位、按版本缓存系统提示、按 Run 统计 queueWait/modelTime/toolTime/resumeWait/deliveryLag。没有本次基准数据支撑，暂不承诺吞吐提升倍数。

验收测试必须在真实边界上观察：Provider 测试桩捕获最终 messages 并检查唯一哨兵与身份；慢工具记录真实开始/结束和副作用时间，不只检查 Map 里有一个 active；审批/问答携多个并存等待对象；在接纳提交后入队前、子完成/outbox 后、投递后确认前分别做故障注入。不能依赖不存在的 `host.on` 或 Provider message.conversationId 字段做空断言。

## 7. 调用路径：证据如何支持改造顺序

| Path | 当前调用与观察 | Finding | 优化落点 |
|---|---|---|---|
| P01：群输出归属 | `postFromOperator` 先写 `groupOrigin[bot]`，两个群排队覆盖，`mirrorToGroup` 在结束时读最后群；E03 | F02 | 接纳时固定输出目标，结果提交按 Run |
| P02：私聊隐藏 | 群 Run 开 `store.hideWrites`，私聊 `admit` 立即 append；E05。park 后开关继续残留；E06 | F01、F04 | 每条记录显式标记，交互保留固定恢复点 |
| P03：取消与重叠 | 旧工具 await → user 等待触发 watchdog → active 清空 → 新执行开始 → 旧工具完成；C01 | F03 | 先取消并确认退出，再让出执行槽 |
| P04：结束后的计时器 | Run done 未清 timer → 新 Run 更新 bot controller → 旧 timer 操作新 controller；C06 | F05 | Segment 资源所有权 + 全出口清理 |
| P05：派工完成 | 消息投递并唤醒 worker → worker 自己完成 → 系统没有父恢复协议；S01 | F08 | 持久化子完成、等待依赖、唯一父恢复 |

仍待下一阶段验证：真实 shell 进程树取消；真实浏览器对分段 SSE/重连的呈现；真实进程在多个持久化窗口的 kill/restart；代理跨进程结果身份。当前报告已区分这些验证缺口，不把控制流桩的结果扩大成全系统恢复保证。

## 8. 交付与审查核对

- [x] 重读旧报告全文，并把事实、推断和草图区分。
- [x] 根据当前源码核对可达调用链、接口与读写路径。
- [x] 已有离线测试 101 通过；9 项 Mock 观察与 12 项隔离控制流观察均成立。
- [x] 每项 Finding 关联源码与 Evidence，给出具体处理路径。
- [x] 列出旧方案的隔离回退、取消缺口、任务恢复与迁移遗漏。
- [x] 保留源码未改状态；复现脚本、日志、观察记录可独立运行。
- [x] 提供阶段依赖和行为验收；未把示例写成已验证补丁。

[主复现日志](../analysis/review-2026-10-22/main-repro.log)、[并发复现日志](../analysis/review-2026-10-22/concurrency-review-run.log)与[证据哈希清单](../analysis/review-2026-10-22/manifest.json)用于复核执行结果与源码基线。
