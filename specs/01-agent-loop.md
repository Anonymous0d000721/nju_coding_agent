# Spec 01：Agent 主循环

## 1. 目的

本规范约束 coding agent 如何处理一次用户请求：组装上下文、请求模型、解析模型输出、执行工具、回填 tool result，并判断是否继续或停止。

核心原则：**模型可以决定下一步行动，但宿主程序必须控制协议合法性、工具执行、持久化、预算、取消和错误转换。**

## 2. 参考来源

- `Assignment.md`：要求对话历史、上下文管理、本地工具执行、模型输出解析、循环终止条件和错误处理均由我们自行实现，不得依赖 agent 框架。
- `refs/pi-minimal-doc/source/minimal-agent.md`：最小 Agent 循环是“调用 LLM → 检查 tool calls → 执行工具 → 追加 tool results → 继续请求模型”。
- `refs/pi-minimal-doc/source/input-to-llm.md`：Pi 中 `AgentSession.prompt()` 负责输入预处理，`runAgentLoop()` 负责 LLM/tool 循环。
- `refs/pi-minimal-doc/source/architecture.md`：强调 agent loop、tool execution、model runtime、UI 的事件化分离。
- `refs/learn-claude-code/s01_agent_loop/README.zh.md`：说明 tool-calling loop 是 coding agent 的地基。
- `refs/learn-claude-code/s17_goal_loop/README.zh.md`：说明不能只相信模型说“完成”，需要验证目标是否满足。

## 3. 范围

本规范包含：

- 单个前台 agent run；
- 流式/非流式模型响应归一化；
- OpenAI-compatible 原生 tool calls；
- tool call 执行与 tool result 回填；
- 停止原因、重试、预算、取消；
- 事件和 append-only 持久化挂钩。

不包含：

- 具体工具语义：见 `02-tool-protocol.md`；
- 权限和 trust：见 `03-permission-trust.md`；
- 上下文组装：见 `04-context-assembly.md`；
- session JSONL 格式：见 `05-session-persistence.md`；
- telemetry 事件格式：见 `06-telemetry.md`。

## 4. 核心组件

### 4.1 `SessionController`

`SessionController.prompt(userInput)` 负责进入 loop 前的工作：

1. 判断输入是普通 prompt 还是 slash command；
2. 运行 input hooks；
3. 展开已批准的 `@path`、prompt template、skill 引用；
4. 先追加 user message 到 session；
5. 准备 run config、model config、abort signal、预算；
6. 调用 `AgentRunner.run()`。

### 4.2 `AgentRunner`

`AgentRunner.run()` 是唯一的模型/工具主循环所有者。

它不得直接读取 API key、解析 CLI 参数、渲染 TUI、随意读取项目文件。它只能通过接口依赖：

- `ModelClient` / `streamFn`；
- `ContextBuilder`；
- `ToolExecutor`；
- `SessionStore`；
- `EventBus`；
- `StopController`。

### 4.3 `ModelClient`

模型层返回统一的 assistant turn：

```ts
interface AssistantTurn {
  id: string;
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: 'end_turn' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  raw?: unknown;
}
```

归一化后，agent loop 不应依赖 provider 的原始响应结构。

## 5. 主循环算法

一次 run 必须按以下流程执行：

1. 发出 `run_start` 事件；
2. 初始化 `turnIndex = 0`；
3. 当未停止时循环：
   1. 检查 wall-clock、turn、token/cost、abort 等预算；
   2. 由 `ContextBuilder` 生成模型上下文；
   3. 发出 `model_request_start`；
   4. 调用 `ModelClient.complete()` 或等价流式接口；
   5. 归一化并追加 assistant message；
   6. 发出 `assistant_message` / `model_response_end`；
   7. 如果没有 tool calls，交给 `StopController` 判断停止或追加反馈继续；
   8. 如果有 tool calls，通过 `ToolExecutor.executeBatch()` 执行；
   9. 为每个 tool call 追加一个 tool result；
   10. 发出 tool result 事件；
   11. `turnIndex++`；
4. 追加 run end 元数据；
5. 发出 `run_end`。

## 6. 消息合法性不变量

必须满足：

1. 每个 assistant tool call 必须恰好有一个同 `tool_call_id` 的 tool result。
2. 即使工具被拒绝、参数非法、取消、超时或抛错，也必须回填 tool result。
3. 未知工具名必须变成结构化 tool result，不得导致进程崩溃。
4. 非法 JSON 参数必须变成结构化 tool result，不得悄悄跳过。
5. 工具执行错误是 observation，要返回给模型。
6. assistant message 必须在执行其 tool calls 前持久化。
7. tool result 必须尽快持久化，不得等整个 run 成功后再写。
8. loop 不设置固定 turn 或 tool-call 数量上限；正式运行依靠模型自然完成、取消信号、模型/runtime 错误和可选的外部 token/cost/time 预算结束。长上下文应先通过本地 deterministic compaction 压缩后继续。

## 7. 批量 Tool Calls

如果模型一次返回多个 tool calls：

- 只读且确定性的工具可以并行执行；
- 写入、编辑、shell、MCP、未知风险工具默认顺序执行；
- 无论调度方式如何，回填给模型的 tool result 顺序应与 assistant tool call 顺序一致，除非目标 API 明确允许乱序；
- 一个工具失败不必阻止同批次中独立工具完成，但所有工具都必须产生结果。

## 8. 停止条件

允许的停止原因：

| 原因 | 含义 |
|---|---|
| `completed` | assistant 给出最终答复，且必要验证已满足。 |
| `model_finished` | 模型无 tool call 停止，但没有明确验证规则。 |
| `user_cancelled` | 用户取消。 |
| `budget_exhausted` | token/cost/time 预算耗尽。 |
| `context_overflow` | 上下文过长，压缩/重试无法恢复。 |
| `fatal_error` | 不可恢复的模型、runtime 或 session 错误。 |

对于可验证的编码任务，模型说“完成”不等于真的完成。runner 应收集最近证据，例如修改文件、测试结果、git diff 摘要。

## 9. 重试规则

- 模型传输类瞬时错误可以指数退避重试，但必须有次数上限。
- 工具 handler 错误默认不自动重试，除非该工具声明并测试了安全重试策略。
- context overflow 对同一次模型请求最多允许一次自动 compact + retry。
- schema 非法的 tool call 应作为 invalid tool result 返回给模型，不应静默修复；只有明确实现并测试过的小型 JSON 容错例外。
- 必须用错误计数防止“错误 → 重试 → 同样错误”的无限循环。

## 10. 取消

- Ctrl+C 或外部 abort signal 取消当前模型请求或工具执行。
- 被取消的工具仍返回 `ok: false`、`error.code = 'cancelled'`。
- 第一次 Ctrl+C 应取消当前 run；连续 Ctrl+C 可以退出 CLI。
- 取消不得破坏 session JSONL。

## 11. 验收标准

实现满足本规范需要测试证明：

- 纯文本 final answer 能正常停止；
- 一次 tool call 后能回到模型继续；
- 多个 tool calls 都有配对结果；
- 未知工具、非法参数、handler 抛错、超时、取消都产生 tool result；
- assistant/tool 消息顺序满足 API 协议；
- session 中存在 user、assistant、tool result、run end 等 append-only 记录。
