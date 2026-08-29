# JSON-RPC 使用说明

nju-agent 提供长期运行的标准输入/输出 JSONL 服务。启动后，标准输出只写协议消息；诊断信息写入标准错误。

## 启动

```powershell
npm run dev -- --mode rpc
```

每行一个 JSON-RPC 2.0 请求。请求失败只返回错误，不会使服务进程退出。

## 方法

- `initialize`：返回协议版本和能力。
- `session/new`：创建会话并返回会话 ID。
- `session/resume`：恢复指定会话。
- `session/state`：读取当前会话状态和显示名称。
- `prompt`：异步提交用户提示，可返回运行 ID。
- `cancel`：取消当前运行。
- `slash`：执行受支持的斜杠命令。
- `shutdown`：取消活动运行并安全退出。

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
