# JSON-RPC 使用说明

nju-agent 提供长期运行的标准输入/输出 JSONL 服务。启动后，标准输出只写协议消息；诊断信息写入标准错误。

## 启动

```powershell
npm run dev -- --mode rpc
```

每行一个 JSON-RPC 2.0 请求。请求失败只返回错误，不会使服务进程退出。

## 方法

- `initialize`：返回协议版本、`clientId` 和能力集合。
- `session/new`：创建会话并返回会话 ID。
- `session/resume`：恢复指定会话。
- `session/state`：读取当前会话状态和显示名称。
- `prompt`：异步提交用户提示，可返回运行 ID。
- `cancel`：取消当前运行。
- `approval/resolve`：提交待审批工具调用的决定。
- `slash`：执行受支持的斜杠命令。
- `shutdown`：取消活动运行并安全退出。

## 审批协议

`confirm` 或 `strict` 模式下，涉及写入、高影响命令、外部工具的调用不会绕过权限系统。运行在工具边界暂停，并发送一个无 `id` 的通知：

```json
{"jsonrpc":"2.0","method":"approval/request","params":{"requestId":"...","clientId":"...","runId":"...","toolCallId":"...","toolName":"write_file","risk":"medium","args":{"path":"src/app.ts","token":"[REDACTED]"},"workspacePath":"src/app.ts","reason":"Mutation requires explicit approval in this permission mode.","timeoutMs":30000,"grantKey":"write_file:mutation-approval"}}
```

客户端必须回传同一 `requestId`、`clientId`、`runId` 和 `toolCallId`：

```json
{"jsonrpc":"2.0","id":"approve-1","method":"approval/resolve","params":{"requestId":"...","clientId":"...","runId":"...","toolCallId":"...","outcome":"allow_once","reason":"Approved for this call."}}
```

`outcome` 支持：`allow`、`deny`、`allow_once`、`allow_session`、`cancel`、`timeout`。`allow` 与 `allow_once` 只作用于当前调用；`allow_session` 对当前审批会话中相同工具策略复用授权。响应成功返回 `{ "resolved": true, "requestId": "..." }`；过期、错配或重复响应返回 JSON-RPC 错误。

审批结束后还会发送 `approval/result` 通知，并将结果、原因、授权范围和耗时写入工具结果、RunStatus/RunReport、session JSONL 与 telemetry。`cancel`、`shutdown`、超时以及 stdin 断开会结束待审批请求；断开还会取消活动运行。没有审批回调时，`strict`/`confirm` 不会静默升级为 `yolo`，而是拒绝需要审批的操作。

## 示例

```json
{"jsonrpc":"2.0","id":"1","method":"initialize"}
{"jsonrpc":"2.0","id":"2","method":"session/new"}
{"jsonrpc":"2.0","id":"3","method":"prompt","params":{"text":"检查当前项目"}}
{"jsonrpc":"2.0","id":"4","method":"session/state"}
{"jsonrpc":"2.0","id":"5","method":"cancel"}
{"jsonrpc":"2.0","id":"6","method":"shutdown"}
```

`prompt` 运行期间，服务会发送运行开始、文本增量、推理增量、工具调用、工具结果、消息完成、运行完成或错误事件。取消只影响对应运行。关闭服务时会等待活动运行收尾，再结束输入输出。

RPC 模式仍使用普通配置、权限、Trust、会话和插件规则；它不是额外的安全边界。请勿把 API 密钥写入请求或日志。
