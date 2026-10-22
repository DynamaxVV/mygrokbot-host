# 功能缺口分析

## 当前能力与剩余验证（2026-10-22，执行 P0/P1 后）

这里的“执行 P0/P1”指会话、取消、审批与可靠派工改造；下文旧 P0/P1/P2 是早期 UI 功能分级，两者不是同一份计划。当前协议见 [EXECUTION.md](EXECUTION.md)，核心功能见 [CORE_FEATURES.md](CORE_FEATURES.md)，启动与打包见 [BUILD_AND_RUN.md](BUILD_AND_RUN.md)。

| 领域 | 当前状态 | 剩余边界 |
| --- | --- | --- |
| 接纳与恢复 | `execution.db` 统一持久接纳、Run、交互、任务与 outbox | 执行中崩溃且副作用结果未知时为 `needs-reconciliation`，不自动重放 |
| 取消与审批 | 单执行段、取消退出屏障、同 Run 新 segment 排队恢复 | 完全脱离受管理进程组且未被观察到的后台进程没有通用追踪保证 |
| 会话隔离 | 群单权威历史；私聊/群/任务上下文与记忆默认分区 | workspace 仍共享；显式开启记忆共享会改变默认隔离 |
| 可靠派工 | 本地 `delegate_task`、依赖持久化、父 Run 自动恢复 | 非本地目标返回 `task/agent-unavailable`；每根链默认 4 活动/2 层/12 总任务 |
| 群策略 | fan-out、显式 @、coordinated、round_robin；精确 Run 取消 | 真实远端服务的身份/结果契约仍需与实际部署联调 |
| 桌面端 | 已有 Electron 入口与 app/DMG 打包脚本 | 本次未重做打包、安装与桌面 GUI 验收；不再按“待选 Tauri”规划 |
| 验证 | 此前全量 174 项中 171 pass、3 skip | 真实模型默认 opt-in；执行改造后的人工 GUI 清单见 [ACCEPTANCE.md](ACCEPTANCE.md) |

本项目仍不是线上 212 个方法与云端运行环境的完整复刻。方法数量不是能力验收替代品，接口以当前 gateway 导出为准。外部 bundle 研究保留在 [PARITY.md](PARITY.md) 与架构历史章节中。

## 早期 UI 缺口与完成记录（历史）

> **早期 UI 状态更新（2026-10-22，历史）**：P0 与 P1 全部完成，P2 除「多机代理」外全部完成。
> 逐项验收结果见 [ACCEPTANCE.md](ACCEPTANCE.md)。

已实现 70+ 个 gateway 方法。真机 212 个。下表保留为历史对照：

## P0 — 日常必用但缺失
1. **附件上传**（图片/文件发给 bot）
   - 真机：`POST /api/attachments/*`、`uploadAttachment`、`getAttachment`
   - 现状：`sendPrompt` 不接受附件，UI 无上传入口
2. **会话搜索**（history search）
   - 真机：`searchIndex` / `searchMessages` / `searchMedia`
   - 现状：无；`search-index.db` 已有结构但未接线
3. **会话导出/分享**
   - 真机：`exportTranscript`、`shareConversation`
   - 现状：无

## P1 — 已有数据但未暴露
4. **自动审批规则 UI**（allowInstructions / blockInstructions）
   - 后端 `getAutoReviewRules` 有，UI 只读展示 shell ceiling
5. **Routine 编辑**（现在只能 create / run / delete）
6. **Skill 编辑与查看**（只能 install / remove）
7. **工具策略 UI**（`getToolPolicy` 有，UI 无入口）

## P2 — 结构在但没做完
8. **分支会话**（`branchConversation`，真机 tweb "在新对话中分支"）
9. **消息引用回复**（`replyTo` 字段存在，UI 未用）
10. **conversation-blobs.db AES-GCM**（结构已实现，未接持久化）
11. **媒体预览**（图片消息渲染）

## P3 — 平台能力
12. **桌面打包**（早期计划 Tauri，后续已采用 Electron）
13. **多机代理**（`server-agent-proxy` 已有骨架）
14. **Webhook 触发 routine**（`fireRoutineWebhook` 已有，未文档化）


---

## 完成情况

### P0 — 全部完成

| # | 功能 | 状态 |
| --- | --- | --- |
| 1 | 附件上传 | ✅ 上传/粘贴/预览/注入上下文 |
| 2 | 会话搜索 | ✅ ⌘F 跨 bot 全历史 |
| 3 | 会话导出 | ✅ Markdown 下载 |

### P1 — 全部完成

| # | 功能 | 状态 |
| --- | --- | --- |
| 4 | 自动审批规则 UI | ✅ 总开关/策略/常驻放行/允许与拒绝规则 |
| 5 | Routine 编辑 | ✅ 新建/编辑/删除/立即运行 |
| 6 | Skill 查看 | ✅ 目录列表与刷新 |
| 7 | 工具策略 | ✅ 主机页展示 |

### P2 — 基本完成

| # | 功能 | 状态 |
| --- | --- | --- |
| 8 | 消息引用回复 | ✅ Alt+点击引用 |
| 9 | 图片消息渲染 | ✅ 内联预览 |
| 10 | 分支会话 | ✅ 复制到新 bot，名称去重 |
| 11 | blobs 加密持久化 | ✅ AES-256-GCM |

### P3 — 当时尚未完成（历史）

| # | 功能 | 说明 |
| --- | --- | --- |
| 12 | 桌面打包 | 当时为浏览器版；后续已采用 Electron，当前见上表 |
| 13 | 多机代理 | `server-agent-proxy` 骨架已有 |
