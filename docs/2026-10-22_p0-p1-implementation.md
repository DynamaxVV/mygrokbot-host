# MyGrokbot P0/P1 实施交付报告

日期：2026-10-22（Asia/Shanghai）。审查基线：`d498dd83dca901d8d2a7db6a40e1ecabc9e9a7c4`。实现与验证环境：Node `v26.5.0`。

本交付完成[架构复核报告](2026-10-22_architecture-mygrokbot-report.md)中 F01—F08 的 P0/P1 改造，保留单机单进程、同 Bot 单执行槽和现有 HTTP RPC + SSE + SQLite 架构。先完成生产改造，最后集中补回归并验证；未创建 Git commit 或 push。

## 验收结果

最终全量离线回归：**174 项，171 通过、0 失败、0 取消，3 项真实模型测试按 opt-in 规则跳过**。

```bash
env -u MGB_REAL_BASE -u MGB_REAL_KEY npm test
```

- [完整回归日志](../analysis/p0p1-validation/offline.log)
- [修改模块和前端内嵌脚本的语法检查](../analysis/p0p1-validation/syntax.json)
- [Git 差异格式检查日志](../analysis/p0p1-validation/diff-check.log)：通过；成功时文件为空。

测试通过包括真实 Host、SQLite、HTTP/SSE Mock、shell 父子进程退出与取消；没有把旧缺陷观察脚本的“复现成功”计入修复验收。

## 修复对应关系

| 原问题 | 已交付行为 | 主要回归 |
|---|---|---|
| F01：群与私聊串上下文、并发入站继承隐藏 | 固定 conversationId；逐条可见性；群权威历史和私有轨迹分开；记忆按会话隔离；迁移不明旧隐藏历史到 legacy 区 | 两群共享 Bot 与 DM 交错；park 时 DM 入站；重启回放；模型消息与记忆哨兵 |
| F02：Bot 级群来源被覆盖、虚假群投递 | 接纳时固定输出目标；读取 group.json 成员；正常建群的主动帖先落群时间线；无成员也区分落盘与唤醒 | createGroup 主动帖；群 nonce 并发及重启；空选择不唤醒；无私聊副本 |
| F03：取消提前释放，旧副作用与新 Run 重叠 | watchdog/forceRelease 仅请求取消；保留槽直到真实 settle；shell 管理进程组与子孙退出；副作用前执行权校验；close 等 drain | 不合作工具真实开始/结束屏障；父子 PID 退出；后台子孙取消/超时；preabort 零写 |
| F04：批准绕过队列、旧卡复活、问答错配 | 持久 interaction → Run → callId；点击只保存决议；批准工具重新排队；单次批准只绑定原调用；stop 使旧交互失效；恢复剩余工具批次 | 批准排队；跨 Bot/后继 Run/同 batch 不复用；已批准排队时 stop；反序问答；多工具恢复 |
| F05：旧 timer 取消新 Run | controller/timer 归 Segment 所有；所有出口 finally 清理；身份相等才清理 Bot 占用 | 正常完成、park、中断均无旧 watchdog；新长流跨过旧 deadline |
| F06：接纳、完成、去重和投递只存在内存 | execution.db 统一事务；完整输入摘要；稳定 entry/outbox ID；投递确认保留 tombstone；重启恢复安全 queued；未知副作用进入 needs-reconciliation | 规范化摘要及输入冲突；nested rollback/afterCommit；投递重试；done 重启不倒退；peer 两种半提交窗口；旧 ledger 导入 |
| F07：群执行两条路径、角色错映射、未来输入提前泄露 | 统一 Room 接纳与策略；同一权威历史；其他 Bot 为外部 user；冻结输入水位；轮流成员等待前一结果交付；Proxy 保留身份 | fan-out/@/空选择；A→B 真串行与唯一输入；取消/超时只作用于精确 Run；独立远端结果镜像一次；API/分支隔离 |
| F08：普通消息冒充可靠派工，父任务不自动恢复 | delegate_task 创建持久父子依赖和独立 task 会话；等待释放槽；终态及 completion outbox 同事务；唯一父恢复；根链预算与向下取消 | 无新用户消息时自动汇总；正文回传；重复乱序只恢复一次；同 Bot 不死锁；审批不算完成；多层取消与三个限额 |

回归还确认了前端真实源码的名称前缀误选：`Nas Bot`、`Nas Bot X` 不应把 `@Nas Bot Xylophone` 识别成合法提及。修复采用最长名称选定后再检查尾边界，避免正则回退成更短名称，并同步后端规则。`mentions:[]` 与 `mentionAgentIds:[]` 保持明确空选择语义。例行任务进入 background lane，避免误占 user 优先级。

## 新增回归

| 文件 | 用例数 | 重点 |
|---|---:|---|
| [cancellation.test.mjs](../test/cancellation.test.mjs) | 18 | 工具真实退出、watchdog、timer、精确审批与 batch 恢复 |
| [execution.test.mjs](../test/execution.test.mjs) | 15 | 规范摘要、事务、outbox、重启、迁移与 peer 恢复 |
| [tasks.test.mjs](../test/tasks.test.mjs) | 17 | 自动父汇总、子结果、去重、同 Bot、取消、预算、路由 |
| [conversation.test.mjs](../test/conversation.test.mjs) | 20 | 群私隔离、水位、策略、精确取消、Proxy、API 和 UI 纯函数 |

共新增 70 项。原有 scheduling 用例更新了旧“宽限后放弃 active”预期，改为验证请求取消、stuck 保槽及真实退出后 drain；群主动发帖用例改用正常 createGroup 和权威群时间线，停止断言旧私聊镜像。问题卡重复回答保留兼容回执，原答案不会被第二次值覆盖。

测试使用各自独立的临时数据根与随机端口，关闭 Host/SQLite/HTTP mock 后校验真实绝对路径再清理；未操作用户既有数据根。

## 实现与运维入口

- [runtime.mjs](../src/runtime.mjs)：固定 Run/Segment 上下文、投影、恢复、交互、取消和父恢复。
- [execution.mjs](../src/execution.mjs)：主机级版本化 SQLite 协调库、事务及 afterCommit、接纳、状态和 outbox。
- [conversation.mjs](../src/conversation.mjs)：会话身份与模型角色投影。
- [tasks.mjs](../src/tasks.mjs)：根任务限额、父子依赖、终态和取消传播。
- [room.mjs](../src/room.mjs)：统一 fan-out、定向、协调与串行轮次，精确查询和取消成员 Run。
- Gateway/Proxy/UI 同步会话与身份；提供 listTasks、getTask、cancelTask、getRunStatus 及执行状态诊断。

当前行为、状态机、API、可靠派工和迁移/回退要求详见 [EXECUTION.md](EXECUTION.md)；[README](../README.md) 已移除旧的 watchdog 提前放行、内存 peer 去重和 message_agent 自动回传承诺。

历史证据保留在 [review-2026-10-22](../analysis/review-2026-10-22/scope.md)。原复现测试针对有缺陷的基线，作为审查证据留存，不能当作当前正确行为测试运行。

## 验证范围与明确限制

本次验证是本地离线回归；前端验证包括当前 HTML 内嵌脚本语法与真实纯函数 VM，未执行浏览器或 Electron GUI 交互，也未调用外部真实模型。未打包、安装或替换桌面 App。

可靠 delegate_task 当前面向本地 Bot；非本地目标返回 typed unavailable，不静默本地执行。群聊和普通消息的 temporal Proxy 路由有真实 Mock 集成覆盖。

外部工具副作用未知时进入待核对状态，不自动重复执行。完全脱离进程组且未被观察到的 daemon 不具备通用追踪保证。数据根按单执行器使用；跨进程分布式执行、共享 workspace 资源锁和吞吐基准不在本次实现中。
