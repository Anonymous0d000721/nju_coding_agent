# 可观测性与性能基准

## 统一事件格式

运行记录写入工作区 `.nju-agent/logs/events.jsonl`。每条事件都是版本化 JSONL envelope：

- `schemaVersion`：当前为 `1`；
- `eventId`、`timestamp`、`type`：事件自身身份与时间；
- `sessionId`、`runId`、`toolCallId`、`approvalId`、`verificationId`、`compactionId`、`mutationId`：可选关联 ID；
- `data`：事件专属字段。

应用层、工具、审批、验证、压缩、文件变更和 MCP 生命周期事件沿用同一 envelope。旧调用若把关联 ID 放在 `data` 中，写入时会提升到 envelope 顶层，便于按字段查询；原始 `data` 仍保留审计信息。

`TelemetryStore.query()` 支持按事件类型和上述关联 ID 过滤，并可限制返回尾部数量。读取会跳过被进程中断截断的单行 JSON，不影响后续记录。写入前统一脱敏：API key、token、私钥和宿主显式提供的 secret 不写入日志。

## 容量与清理

活动日志默认限制为 5 MiB；达到上限后轮转到 `.1`、`.2`、`.3`，最多保留三个轮转文件。单个过大的事件会保留事件身份和字段名，并以 `data.truncated=true` 代替完整 payload。实现使用同一路径写锁，避免并发工具事件交错或轮转竞争。

这是有界日志，不是长期归档系统。需要长期保存时，应由宿主定期导出已脱敏记录；不要直接复制包含本地路径或外部服务诊断的原始日志。

## 性能基准

运行：

```powershell
npm run benchmark
```

脚本只使用 FakeModel、内存 mock transport 和临时工作区，不访问网络，也不依赖真实凭据。输出 JSON 包含：启动初始化、首 token、超大工具输出边界、并发工具批次与平均耗时、长历史 deterministic compaction、模型重试等待、插件加载、MCP 多 server 连接、堆内存变化，以及 telemetry 可查询性和故障隔离检查。

这些数值用于比较同一代码库的回归，不代表生产 SLA。基准特别保留审计字段，不通过删除工具结果、重试或压缩证据来换取速度；外部 MCP 和 PowerShell 仍受宿主用户权限约束。
