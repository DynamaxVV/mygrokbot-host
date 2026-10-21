# MVP 验收清单

服务已在跑：**http://127.0.0.1:8899**

数据根 `~/.mygrokbot`（3 个 bot + 1 个群组 + 1 个 routine），模型 `workbuddy/hy3` @ `192.168.49.201:3425`。

---

## 1. 界面骨架

打开 http://127.0.0.1:8899

| 位置 | 应该看到 |
| --- | --- |
| 左栏 | 主 Bot / Nas Bot / Github Bot / **运维群**（圆形 ☰ 头像） |
| 顶部 | bot 名、模型 `workbuddy/hy3`、连接状态 `已连接` |
| 右栏 | 3 个 tab：**详情 / 任务 / 主机**（真机 6 个合并而来，见下） |
| 底部 | 输入框 + 发送按钮 |

**建议先点 Main Bot**，再依次点其他 bot 看切换。

---

## 2. 一次真实对话

在 Main Bot 里发：

```
用一句话说明你能做什么
```

预期：
- 你的消息立刻出现在右侧（暗色气泡）
- 出现"发送中"转圈
- 几秒后出现 bot 回复（浅色气泡，左侧）
- 回复上方有可折叠的 `thinking`（推理过程）
- 底部状态栏显示 `done · N tok · Nms`

---

## 3. 审批闸门（核心）

再发：

```
用 shell 跑一下 ls 看工作区有什么
```

预期：
- 出现**审批卡片**（黄色边框）
- 卡片里是真实命令（`ls -la ...`）
- 三个按钮：`Always allow` / `Approve` / `Deny`

点 **Approve** → 命令执行 → 结果卡片出现 → bot 继续回答。

点 **Deny** → 命令**不执行**，bot 收到"已拒绝"。

> 这是与普通聊天框最重要的差别：副作用前有一道闸门，且拒绝真的不执行。

---

## 4. 群组轮流发言

点左栏 **Ymb 运维** → 右栏 **Members** tab → 点 `Run a room round`。

预期：
- 三个成员**依次**发言（不是并行）
- 每个成员的结果以服务消息出现：`Main Bot → delivered` / `Nas Bot → pass` 等
- `pass` 是正当结果（"这轮我没话说"），不是失败

其中某个成员如果停在审批上，会记 `skipped` 并说明原因，整轮继续。

---

## 5. 命令面板

按 `⌘K`（或点左下 Settings）。

预期：弹出 28 个命令（来自真机 UI 契约），可搜索、上下键选择、回车执行。

`⌘⇧I` 折叠右栏。

---

## 6. 定时任务

右栏 **Tasks** tab。

预期：看到 `Daily Digest`，cron `0 8 * * *`，点 `Run` 可立即触发一次。

---

## 7. 持久化

关闭浏览器、重启服务，再打开：

```bash
pkill -f "mgb.mjs serve"
MGB_DATA_ROOT="$HOME/.mygrokbot" MGB_REAL_KEY=... node bin/mgb.mjs serve --port 8899
```

预期：对话历史、群组、routine、审批状态全都还在。

---

## 已实测通过的（我这边的记录）

| 项 | 方式 | 结果 |
| --- | --- | --- |
| 真实模型流式回复 | HTTP | `MVP-OK` |
| reasoning 持久化 | transcript | 有独立 reasoning 行 |
| 工具调用 → 审批 → 执行 | 全链路 | `echo hello-mvp` 输出 `hello-mvp` |
| 群组三人轮流 | `runRoomTurn` | `delivered, delivered, delivered` |
| 群组 pass 语义 | 真实模型 | `pass` 被正确记为 pass |
| 页面启动 10 个 RPC | 顺序模拟 | 全 ok |
| 离线测试套件 | `node --test` | 97 pass / 3 skipped |

---

## 已知边界（不是 bug，是范围）

| 项 | 现状 |
| --- | --- |
| 移动端 | 有断点（<900px 隐藏侧栏），未专门设计 |
| 媒体/贴纸 | Library tab 为空 |
| 桌面端 | 未打包（可后续 Tauri） |
| `harness=temporal` 的 bot | 走本机代理替身，不是真云端 |


---

## 附：这一轮按验收反馈做的改动

| 反馈 | 改动 |
| --- | --- |
| 一直 connecting、发不出消息 | gateway 拒绝了所有带 `Origin` 的请求；改为**同源放行、跨源拒绝** |
| 6 个 tab 太挤、换行不优雅 | 合并为 3 个：详情 / 任务 / 主机（原 Tasks+Library → 任务，原 Computer+Meetings+Members → 主机） |
| 输入框文字不居中 | `align-items: center` + 显式 `line-height: 24px`，实测偏移 0px |
| 加号没居中 | 按钮自身 padding 清零、`line-height: 0` + `place-items: center`，实测偏移 0px |
| 不同宽度应该有滑动条 | 去掉横向滚动；`minmax(0,1fr)` 网格 + 断点：>1200px 常显右栏，≤1200px 右栏可展开，≤820px 左栏可展开 |
| 要中文 | 界面文案、日期（今天/昨天）、命令面板 28 条全部中文 |
| 顺手修的 | 用户消息重复渲染（乐观插入 + SSE 双推）、空气泡、`</think:…>` 泄漏、`已创建` 噪音行 |
