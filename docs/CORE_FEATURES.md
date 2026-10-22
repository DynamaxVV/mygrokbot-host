# 核心功能使用指南

面向日常使用：创建 Bot、选择群聊方式、委派任务、处理审批与停止、查看结果及恢复。先按[构建与启动指南](BUILD_AND_RUN.md)启动程序；执行身份和存储协议见 [EXECUTION.md](EXECUTION.md)。

## 创建 Bot 并开始对话

1. 首次初始化创建 Main Bot，或在界面名册中新建 Bot。
2. 在设置的模型接入页配置 Base URL、模型和 API Key，并为 Bot 选择绑定。
3. 选择 Bot 后发送消息。角色、偏好、模型和技能属于 Bot，聊天历史属于具体会话。
4. 文件工具操作数据根下的共享 `workspace/`。附件上传路径随当前消息进入模型输入。

修改 Bot 名称不会移动会话历史。模型绑定文件只保存密钥环境变量名；界面填写的密钥可保存在数据根的受限 secrets 文件中。模型服务仍需具备所使用的流式输出和工具调用能力。

## 选择群聊方式

在界面创建群并选择成员；成员名单保存在群的 `group.json`。群拥有独立时间线，群消息不复制进成员私聊，也不把成员的私聊历史自动带进群。

| 场景 | 使用方式 | 行为 |
|---|---|---|
| 希望每个成员回应 | 普通发送，无有效提及 | 默认 fan-out，各成员分别排队 |
| 只问指定成员 | 使用 `@` 选择成员 | 只调度明确提及的成员 |
| 希望成员依次讨论 | RPC 选择 `round_robin` | 后一成员等前一结果交付后再执行，可读取前一发言 |
| 希望协调者先处理 | RPC 选择 `coordinated` | 未指定成员时选择主 Bot 或首位成员；显式提及仍优先 |
| Bot 主动给群发通知 | `message_agent` 指向群 | 原帖先落群时间线，不因 priority 唤醒全员 |

目前界面默认采用普通发送和 `@`；额外策略通过 `sendPrompt.strategy` 或 `runRoomTurn` RPC 使用。没有专门的策略切换按钮。结构化 `mentionAgentIds:[]` 或 `mentions:[]` 表示明确不唤醒成员，不会回退成全员。

Bot 主动群通知目前是纯文本，图片和 priority 的处理结果记录在回执 notes 中；这与用户群消息随入站传递附件路径是不同入口。

## 区分通知与可靠派工

| 工具 | 何时使用 | 结果契约 |
|---|---|---|
| `message_agent`，priority=false | 给队友补充资料或 FYI | 消息持久保存，等待对方下次私聊工作读取，不唤醒 |
| `message_agent`，priority=true | 需要对方马上处理的普通通信 | 唤醒对方并排队，但不保证父任务自动汇总 |
| `delegate_task` | 明确交付目标，需要返回结果并继续汇总 | 登记父子依赖，子任务终态后自动恢复父 Run |
| `message_user` | Bot 主动向操作者报告 | 在该 Bot 的操作者私聊中产生通知 |

需要可靠回传时，可以这样向 Main Bot 提要求：

```text
请用 delegate_task 把目录结构分析交给 Nas Bot。
objective：检查共享工作区的目录结构，并找出主要入口。
expectedOutput：列出入口文件、各自作用和三条有依据的改进建议。
收到子任务结果后，请由你汇总成中文结论。
```

模型工具接口的 `to`、`objective`、`expectedOutput` 三个字段均必填。父 Run、父任务 ID、返回会话和深度由运行时绑定，模型不自行指定。

可靠委派当前只支持本地 Bot。temporal/box 等非本地委派返回 `task/agent-unavailable`，不会静默改成本地执行。默认 temporal Proxy transport 是用于协议兼容的本地替身；真实远端执行需要接入实际 transport。默认根任务链限制为 4 个活动委派、2 层嵌套、12 个任务；等待审批的子任务仍计入活动数。

父任务等待子任务时释放 Bot 执行槽，不需要用户补发“继续”来触发汇总。同 Bot 委派也走这个机制。失败、取消和待核对结果会交给父任务处理，不会被伪装成成功正文。

## 处理审批与问题卡

需要人工决议的工具先保存卡片，再释放执行槽。期间可以继续向 Bot 发送其他消息。

| 操作 | 效果 |
|---|---|
| Approve / 批准 | 仅批准原工具调用一次；工具与模型续跑重新进入队列 |
| Always / 始终允许 | 除执行本次外，保存长期规则 |
| Deny / 拒绝 | 原命令不执行，结束对应工作并留下结果 |
| 问题卡选择或输入答案 | 答案绑定原 callId，恢复原 Run，不关联最近的其他问题 |

群或任务产生的审批卡可能显示在 Bot 私聊中。显示位置不改变原工作的群/任务来源，批准后仍在原上下文恢复。多个问题卡可以反序回答，重复回答不会覆盖首次答案。

重启时，带有效持久恢复点的卡片继续有效；无绑定、已过期或已取消的旧卡会失效。已经停止的 Run 不会因为旧标签页点击批准而重新启动。

## 理解停止与等待状态

普通 Bot 的停止按钮调用 `interruptAgentRun`，不传 runId 时是 Bot 范围的取消。需要准确停止一项工作时，使用带 runId 的 RPC；群轮次使用 `cancelRoomTurn`，委派任务使用 `cancelTask`。

取消是请求，不是立即宣告工具退出。状态进入 `cancelling` 后，运行时等待实际工具或子进程结束，再进入 `interrupted` 并释放执行槽。旧工具暂时不响应取消时，界面或诊断可能显示 stuck；队列不会靠提前放行制造同 Bot 双执行。

| Run 状态 | 含义 | 操作者下一步 |
|---|---|---|
| accepted | 已接纳、等待调度 | 查询状态，重试时复用相同 nonce 和输入 |
| running | 模型或工具正在执行 | 等待结果，或请求停止 |
| awaiting-approval | 等待工具审批 | 到对应 Bot 私聊处理卡片 |
| awaiting-answer | 等待问题答案 | 回答对应卡片 |
| waiting-children | 等待子任务 | 查看子任务状态，无需补发继续 |
| cancelling | 已请求取消，执行尚未确认退出 | 等待真实退出 |
| done / error / interrupted | 成功 / 失败 / 已中断终态 | 查看结果或错误 |
| needs-reconciliation | 上次执行效果未知，未自动重放 | 核对外部工具实际结果后再决定新的工作 |

Task 的终态名称是 `completed`、`failed`、`cancelled`、`needs-reconciliation`，与 Run 的状态名有区别。

## 查询任务与执行记录

新任务观察接口目前是 RPC，没有专门的 Task 管理面板。默认本地 Web 启动在 8899 时可直接查询：

```bash
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -d '{}' \
  http://127.0.0.1:8899/api/listTasks
```

响应外层是 `{ok,result}`，任务列表在 result。启用 Gateway token 时需另带 Authorization 请求头。

| RPC | 关键参数 | 使用目的 |
|---|---|---|
| listTasks | 可选 agentId、parentRunId、conversationId、state | 查看本机任务及依赖 |
| getTask | taskId | 查看某个子任务结果和目标 Bot |
| cancelTask | taskId、可选 reason | 请求停止指定任务及其子任务 |
| getRunStatus | runId | 查看固定会话、运行状态和结果 |
| promptAcceptanceStatus | clientNonce、可选 agentId | 查询最初那次发送的接纳与结果 |
| getAcceptanceLedgerStatus | 无 | 查看执行状态计数、交互和待投递数量 |
| getRoomDiagnostics | 无 | 查看活动群轮次与近期成员结果 |

同 nonce、同有效输入会返回原接纳。目标、正文、附件、引用、提及或策略发生变化后应生成新 nonce；不要用同一个 nonce 表达新的意图。

## 记忆、分支与恢复

私聊、群、任务的 Transcript 与默认记忆分开；共享 workspace 仍是同一文件系统。需要共享长期记忆时，Bot profile 可显式设置 `shareMemoryAcrossConversations=true`。该配置目前通过 `updateAgent.patch` 或 profile 管理，不是单独的界面开关。

分支会复制当前可见历史并重新映射消息与工具 ID，历史审批卡不会在新分支重新执行。fresh/rollback 只影响对应会话的可见历史与运行，不删除整个 Bot 的其他会话。

遇到 `needs-reconciliation`，先核对上次工具是否已经产生文件、命令或外部系统变更。当前没有“一键确认后自动接着执行”的恢复 RPC；核对完成后可以使用新消息、新 nonce 发起下一项明确工作。不要删除执行库来消除状态。

升级、数据备份与 SQLite 迁移细节见[构建与启动指南](BUILD_AND_RUN.md)和[执行协议](EXECUTION.md)。当前验证结果见[P0/P1 实施报告](2026-10-22_p0-p1-implementation.md)。
