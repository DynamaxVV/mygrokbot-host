# 功能缺口分析

> **状态更新（2026-10-22）**：P0 与 P1 全部完成，P2 除「多机代理」外全部完成。
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
12. **Tauri 打包**（当前是浏览器版）
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

### P3 — 未做

| # | 功能 | 说明 |
| --- | --- | --- |
| 12 | Tauri 打包 | 目前是浏览器版 |
| 13 | 多机代理 | `server-agent-proxy` 骨架已有 |
