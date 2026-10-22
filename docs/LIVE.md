# 真实模型验证

默认测试离线且确定。真实模型是**显式 opt-in**，不设环境变量就跳过。

> 下表是早期版本的真实模型验证记录，不代表 P0/P1 改造后重新执行了真实模型或 GUI 验证。当前离线交付结果是 171 通过、3 跳过；启动方式见 [BUILD_AND_RUN.md](BUILD_AND_RUN.md)，当前行为见 [EXECUTION.md](EXECUTION.md)。

## 历史已跑通的链路

对 `workbuddy/hy3`（`http://192.168.49.201:3425/v1`）实测：

| 链路 | 结果 |
| --- | --- |
| 流式回合（reasoning + text） | 通过，usage 1621 tok |
| 工具调用（shell → 结果 → 二次推理） | 通过，`echo live-tool` 输出被正确读回 |
| 审批 park → 批准 → 恢复 → 执行 | 通过，pending 从 1 归零 |
| 经 gateway HTTP + SSE（浏览器路径） | 通过，事件序列完整 |
| `mgb verify` CLI 冒烟 | 通过 |

## 这个 provider 的三个协议特点

实测抓到的，和标准 OpenAI 有出入：

**1. 首帧是注释，不是 data。**
```
: heartbeat
```
SSE 解析必须跳过冒号开头的行，否则第一帧 JSON 解析失败。

**2. reasoning 与 content 同时出现在 delta 里，且 reasoning 先来。**
```json
{"delta":{"content":"","reasoning_content":"The user wants me"}}
{"delta":{"content":"OK","reasoning_content":null}}
```
两者互斥但同字段并存；`content` 为 `""` 时不能当成空响应。

**3. usage 挂在最后一个 choice 帧上，不是独立 usage 帧。**
```json
{"choices":[{"delta":{...,"finish_reason":"stop"}}],
 "usage":{"prompt_tokens":23,"completion_tokens":27,...}}
```
标准 OpenAI 会把 usage 放在 `choices: []` 的空帧里。两种都接受才行。

## 怎么跑

```bash
# 在项目根目录输入自己的服务信息；API Key 输入不回显。
printf 'Base URL: '
IFS= read -r MGB_REAL_BASE
printf 'Model ID: '
IFS= read -r MGB_REAL_MODEL
printf 'API Key: '
IFS= read -r -s MGB_REAL_KEY
printf '\n'
export MGB_REAL_BASE MGB_REAL_MODEL MGB_REAL_KEY

node --test test/real-model.test.mjs

# 或在其他执行器停止后做 CLI 单次验证。
node bin/mgb.mjs verify "Main Bot" --model "$MGB_REAL_MODEL" \
  --base-url "$MGB_REAL_BASE" --key-env MGB_REAL_KEY
```

`mgb verify` 会打印解析后的模型、route、usage、reasoning 摘要和回复正文——一眼能看出是「通了」还是「被 provider 拒了」。

## 泄露面

模型绑定文件只存**环境变量名**（`model-bindings.json` 里没有 key）；界面可把实际密钥保存到数据根的 `secrets/env.json`，由受限文件权限保护。`getAgentBinding` 返回时把 key 替换成 `***set***`。

测试用的 key 通过 `process.env` 传递，不出现在任何提交文件里。
