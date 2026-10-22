# 执行、会话与可靠派工

日常操作见[核心功能指南](CORE_FEATURES.md)，安装和启动见[构建指南](BUILD_AND_RUN.md)。本文描述当前 MyGrokbot 的本地执行实现。此前的架构对照文档保留线上协议研究背景；当前取消、持久化与群聊语义以本文和源码为准。

## 使用可靠派工

普通 Bot 消息使用 `message_agent`：`priority=true` 唤醒收件人，`false` 只持久保存消息，不保证回复。需要明确结果与自动汇总时使用 `delegate_task`，模型工具接口的 `to`、`objective`、`expectedOutput` 三个字段均必填。调用方的 Run、任务关系和返回会话由运行时注入。

子任务在独立 `task:` 会话执行。父 Run 等待时释放 Bot 执行槽，因此同 Bot 委派和有限的 A→B→A 链不会因为占着执行槽等待自己而死锁。子任务到达完成、失败、取消或待核对终态后，结果与 completion outbox 同事务保存；依赖满足时只恢复一次父 Run。普通 `held` 通知不承担父任务恢复职责。

默认每条根任务链最多 4 个活动委派、2 层嵌套、12 个任务。等待审批的子任务仍计入活动任务，不会被当成已完成。可靠 `delegate_task` 当前针对本地 Bot；非本地目标返回明确的 `task/agent-unavailable`，不会悄悄在本地代跑。群聊与普通消息的 temporal 路由继续使用 Proxy。

## 会话与执行身份

| 身份 | 用途 |
|---|---|
| botId | 长期 Bot 身份、角色、模型、技能 |
| conversationId | `dm:`、`group:`、`task:` 历史空间 |
| runId | 逻辑工作的固定身份，审批或派工等待后保持不变 |
| segmentId / turnId | 一次实际占用 Bot 执行槽的执行段 |
| clientNonce | 客户端接纳与重试幂等键 |
| interactionId / callId | 交互卡与原工具调用的精确绑定 |

用户入站、工具、结果、流式事件和恢复点携带固定会话与 Run 归属。`hidden` 是逐条记录的兼容展示属性，Store 不再提供影响其他入站的全局开关。

群业务历史只有群 Store 一份权威投影；成员不再收到群文本的私聊副本。其他 Bot 发言作为带发送者身份的外部输入，当前 Bot 的发言才投影为 assistant。每个 Run 固定输入水位，排队中的未来私聊不会在当前工具步骤中被提前读取。

群、私聊与任务的记忆默认分开。私聊沿用原 profile/log；群和任务记忆放在会话哈希对应文件中。只有 Bot profile 显式设置 `shareMemoryAcrossConversations=true`，才把原记忆共享给其他会话。共享 workspace 仍是共享文件系统，会话隔离不是文件系统隔离。

## 取消与等待

同一个 Bot 同时只有一个实际执行段。Scheduler 的 watchdog 在用户排队超时后请求取消；宽限期后仍未退出则标记 `stuck`，保留执行槽。`forceRelease` 同样只请求取消，`drain` 等待真实任务与取消钩子结束，不再提前返回。

Run 的活动状态为 `accepted → running`，交互或依赖等待为 `awaiting-approval`、`awaiting-answer`、`waiting-children`。取消先进入 `cancelling`，实际执行退出后才进入 `interrupted`。终态另有 `done`、`error`、`needs-reconciliation`。

每个执行段拥有自己的 controller 与 timer，所有出口清理自身资源，旧 timer 不再按 Bot ID 操作后继 Run。工具在副作用前检查取消与执行身份。shell 取消会终止进程组并等待父子进程退出；正常 shell 退出后仍有受管理后台子孙时也继续保持取消与超时能力。取消之前已经完全脱离进程组、重托管且未被观察到的进程不具备通用跨平台追踪保证。

## 审批与问答恢复

卡片持久绑定 Run、工具调用、参数摘要和取消版本。群来源的卡片可显示在对应 Bot 私聊中，但恢复目标仍是原群或任务。

批准只保存决议并入队；被批准工具与模型续跑都经过同 Bot Scheduler。单次批准只作用于原调用，`always` 才保存长期规则。拒绝结束原工作且记录结果，不执行命令。停止会使对应待决或已批准但尚未执行的交互失效。

多个问题卡按 entryId/callId 匹配，反序回答也不会绑定到最近的其他调用。同一卡重复回答返回已记录的答案，不覆盖原决议。模型一次返回多个工具调用时，审批或问答恢复后继续处理保存的剩余调用。

## 群聊策略

普通发帖保留默认 fan-out；结构化 `mentionAgentIds` 或明确 `@` 决定响应者，显式空选择不会回退成全员。可选 `coordinated` 只在没有显式指定成员时选择协调者；`round_robin` 逐个等待成员结果并确认群投影后，再启动下一成员。

Bot 主动发群帖只保存原帖并返回接收成员列表，不因 priority 自动唤醒全员。空群仍可以成功保存帖，`woken=false` 与成功落盘是不同语义。图片与 priority 的降级说明保留在 notes。

轮次超时、取消和替换只对该轮成员 Run 发出取消请求；不会按整个 Bot 停止无关私聊。成员结果使用固定 nonce/runId 查询，不扫描 Bot 最近一条回复。远端成员必须返回完整 Run 身份与结果；本地群投影使用稳定消息 ID 去重。

## 持久化与迁移

新增主机级 `execution.db`，使用 Node 内置 SQLite、WAL 与 FULL 同步，保存接纳、Run、交互、任务和 outbox。现有 `agents/.../store.db` 保留兼容 Transcript 表，补充会话索引和 JSON 字段。

- 完整输入摘要覆盖目标、会话、正文、附件、引用、提及与执行策略。同 nonce、同有效输入返回原接纳；同 nonce、不同输入返回冲突。
- outbox 与业务终态同事务保存；Transcript 的稳定 entry ID 是幂等投影键。已确认投递保留去重记录，重启不复活。
- 安全的已接纳未启动工作可重新排队。崩溃前已在执行、工具结果未知的 Run 标记 `needs-reconciliation`，不自动重放副作用。
- `done` 与结果保存在执行库中，重启不会回退成 `accepted`。待决交互按持久恢复点恢复；无绑定的旧卡过期。
- 旧 `send-acceptance.json` 只读导入并保留原文件，同时继续作为兼容诊断。缺少执行恢复点的旧接纳标记待核对。
- Transcript 迁移前先 checkpoint 并保存 `.pre-conversations-v2` 备份。可确认历史标注私聊或群会话；旧隐藏记录归属不明时保留在只读 legacy 命名空间，不猜测归入当前私聊。

投递采用持久重试与消费幂等，结果提交、投递、确认分别记录。它不把外部工具副作用宣称为天然 exactly-once。回退旧程序前，应停止新执行器并整体备份数据根，协调库与 Transcript 必须使用一致快照。

## 查询与客户端

Transcript、Tail、All、Outline、导出、分支、搜索和 pending 查询按当前显示会话过滤。SSE 在更新 Bot 忙闲后按显示会话路由；群私有推理、工具和迟到 delta 不进入私聊展示。前端发送前生成 nonce，失败且输入未变时复用；切换聊天后，旧请求结果不会写入新聊天。

| RPC | 参数 | 返回 |
|---|---|---|
| listTasks | 可选 agentId、parentRunId、conversationId、state | 本机 Task 列表 |
| getTask | taskId | Task 与结果/状态 |
| cancelTask | taskId、可选 reason | 取消请求及当前任务快照，不伪造结束 |
| getRunStatus | runId | 持久 Run 状态与结果 |
| getAcceptanceLedgerStatus | 无 | 旧台账诊断及执行库状态计数 |

分支会重新映射会话、消息与工具调用 ID，旧审批卡保持历史状态。fresh/rollback 只标记当前会话可见历史并请求取消对应 Run，不借显示在私聊的群卡跨范围中止群工作。

## 验证

运行离线回归：

```bash
npm test
```

回归覆盖真实 SQLite、Host、HTTP/SSE Mock、shell 父子进程、取消退出屏障、计时器、审批与问答、群私交错、输入水位、重启迁移、投递去重、任务依赖恢复和 API 投影。真实模型测试保持 opt-in；填写对应环境变量才会运行。
