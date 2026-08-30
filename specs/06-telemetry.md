# Spec 06：遥测与运行报告

## 1. 目的

本规范约束本地 telemetry：用事件日志和 run report 记录 agent 做了什么、花了多久、调用了哪些工具、为什么停止、是否发生错误。

Telemetry 用于调试、评估和演示，不是远程 analytics 系统。

`specs/07-cli-ux.md` 中的 JSON Event mode 必须复用本规范的事件 schema：写入 telemetry JSONL 的事件与输出到 stdout 的 JSONL events 应尽量同构，只允许根据隐私模式和输出目的裁剪 payload。

## 2. 参考来源

- `Assignment.md`：面试会关注是否理解 agent 为什么这样运转；本地 telemetry 可以提供具体证据。
- `specs/07-cli-ux.md`：`--mode json` 复用本规范的 run event schema。

## 3. 原则

- 本地优先：JSONL 写入 `.nju-agent/logs/`；
- 不含密钥：写日志前必须 redaction；
- 默认记录元数据：路径、大小、耗时、状态、计数，而不是完整私密内容；
- 可关联：每个事件都有 `runId`、`sessionId`、timestamp，可选 `turnIndex`；
- 有界：事件 payload 有大小限制；
- 可测试：integration tests 能断言 telemetry 行为。

## 4. 事件格式

```ts
interface TelemetryEvent {
  type: string;
  id: string;
  timestamp: string;
  sessionId?: string;
  runId?: string;
  turnIndex?: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  data?: unknown;
}
```

Telemetry JSONL 是 append-only。每个事件必须是一行合法 JSON。

同一事件结构也用于 `--mode json` 的 stdout JSONL 输出，但二者职责不同：

| 用途 | 位置 | 生命周期 | 内容 |
|---|---|---|---|
| telemetry | `.nju-agent/logs/` | 可跨 run 持久保存 | 调试/评估用 metadata，受隐私模式控制。 |
| JSON event mode | stdout | 当前进程输出 | 机器可读 run events，必须保持 stdout 协议纯净。 |

JSON event mode 不得输出比 telemetry `normal` 模式更敏感的内容；debug telemetry 中允许的额外 preview 不应默认出现在 stdout。

## 5. 必须事件类型

### Run lifecycle

- `run_start`
- `run_end`
- `run_error`
- `run_cancelled`

### Turn lifecycle

- `turn_start`
- `turn_end`

### Model lifecycle

- `model_request_start`
- `model_response_end`
- `model_error`
- `model_retry`

### Tool lifecycle

- `tool_call_start`
- `tool_permission_decision`
- `tool_result`
- `tool_error`

### Context/session lifecycle

- `context_built`
- `context_omission`
- `compaction_start`
- `compaction_end`
- `session_resume`

## 6. Payload 约束

### `run_start`

可以包含：

- model id；
- workspace path；
- permission mode；
- max turns/tool calls/time；
- session id。

不得包含 API key 或含密钥的原始 config。

### `model_response_end`

可以包含：

- duration；
- stop reason；
- provider 返回的 token usage；
- tool call 数量；
- response size。

默认不需要包含完整 assistant text，因为 session 已保存消息。

### `tool_call_start`

可以包含：

- tool name；
- redacted args preview；
- risk category；
- timeout。

不得包含完整敏感文件内容。

### `tool_result`

可以包含：

- status；
- elapsed time；
- output bytes/lines；
- 命令 exit code；
- truncation flag；
- artifact reference。

大输出或敏感输出默认不写完整 stdout/stderr。

## 7. Redaction

写 telemetry 前必须脱敏：

- 配置中的 API key 值；
- 常见 key 模式，例如 `sk-...`；
- OAuth tokens；
- private-key blocks；
- 环境变量名包含 `KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL` 的值；
- `03-permission-trust.md` 中定义的敏感文件内容。

测试必须配置 fake secrets，并断言它们不会出现在 telemetry 中。

## 8. Run Report

run 结束时生成简短报告对象或 markdown 片段：

- status / stop reason；
- 用户目标摘要；
- turns 和 tool-call 数量；
- 读过/改过的文件；
- 运行过的命令和 exit codes；
- 观察到的 tests/checks；
- warnings/errors；
- token/cost，如果 API 返回。

报告可显示给用户，也可用于 README/demo 说明，未来可作为 goal gate 的证据输入。

## 9. 隐私模式

推荐模式：

| 模式 | 行为 |
|---|---|
| `off` | 不写 telemetry 文件；session persistence 仍工作。 |
| `normal` | 默认，metadata-only events。 |
| `debug` | 更多 preview 和 raw error details，但仍然脱敏且有界。 |

远程上传不在范围内。若未来添加，必须 opt-in。

## 10. 验收标准

实现满足本规范需要测试证明：

- run、turn、model、tool、compaction lifecycle 都会写 JSONL events；
- events 有 correlation ids；
- fake secrets 被脱敏；
- payload 有界；
- run report 总结状态、工具、文件、命令和验证证据；
- telemetry 可以关闭。