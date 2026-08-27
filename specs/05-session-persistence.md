# Spec 05：会话与持久化

## 1. 目的

本规范约束 session、message、tool call、tool result、summary、run metadata 和恢复信息如何持久化。

Session store 的作用是：支持恢复工作、调试问题、为作业展示保留证据，并避免崩溃或取消时丢失状态。

## 2. 参考来源

- `Assignment.md`：评委会会关注开发过程和设计理解；可读的本地 session log 有助于说明 agent 行为。
- `refs/pi-minimal-doc/source/compaction-and-branches.md`：Pi 使用 append-only JSONL session、compaction entry，并预留 branch/fork 元数据。
- `refs/pi-minimal-doc/source/input-to-llm.md`：user、assistant、tool messages 会积累为 agent context。
- `refs/pi/packages/agent/docs/harness.md`：Pi harness 设计包含 session persistence 和 recovery 概念。
- `refs/learn-claude-code/s08_context_compact/README.zh.md`：说明保留历史和压缩模型上下文应分开处理。

## 3. 存储布局

推荐本地布局：

```text
.nju-agent/
  sessions/
    <session-id>.jsonl
  artifacts/
    <session-id>/
      <artifact-id>.txt
  logs/
    <run-id>.events.jsonl
  trust.json
  config.local.json   # 可选，gitignored
```

默认应 gitignore `.nju-agent/`，除非是明确无密钥的 example/template。

## 4. JSONL 格式

Session 使用 append-only JSONL。每行是一个完整 JSON object。

公共字段：

```ts
interface BaseEntry {
  type: string;
  id: string;
  sessionId: string;
  parentId?: string;
  timestamp: string;
  schemaVersion: number;
}
```

规则：

- 每个 entry 写成一行 JSON，并以 `\n` 结尾；
- 正常运行时不修改旧 entry；
- 恢复时可以忽略一个损坏/不完整的尾行并警告；
- 非尾部损坏表示 session 文件异常，应明确报错，除非未来实现 repair 命令。

## 5. Entry 类型

### 5.1 `session_start`

包含：

- `cwd`；
- 所选 model/provider id，不含密钥；
- app version；
- 创建时间；
- 可选 session name。

### 5.2 `message`

保存归一化对话消息：

```ts
{
  type: 'message',
  role: 'user' | 'assistant' | 'tool',
  content: MessageContent[],
  toolCalls?: ToolCall[],
  toolCallId?: string,
  usage?: Usage
}
```

### 5.3 `tool_event`

可选的更详细工具执行记录：

- tool name；
- 脱敏后的 args preview；
- permission decision；
- elapsed time；
- result status；
- artifact path。

注意：模型可见的 tool result 仍必须作为 `message` 或 provider-compatible 等价结构保存。

### 5.4 `summary`

压缩摘要 entry：

- `summary` 文本；
- 覆盖的 entry id/range；
- `firstKeptEntryId`；
- `tokensBefore` / estimated tokens after；
- 读过/改过的文件；
- 运行过的命令；
- reason：`manual`、`threshold`、`overflow`。

### 5.5 `run_start` / `run_end`

记录一次前台 agent run：

- run id；
- user message id；
- 不含密钥的 config snapshot；
- final stop reason；
- error summary；
- usage summary。

## 6. Session 恢复

打开 session 时：

1. 逐行读取 JSONL；
2. 对一个不完整/损坏尾行给出 warning 并忽略；
3. 校验 schema version；
4. 重建当前 branch/path 的 conversation messages；
5. 重建 summaries、artifacts、usage、session metadata；
6. 校验恢复出的模型上下文中 assistant tool calls 都有对应 tool results。

如果消息合法性已破坏，只有在明确安全且有文档说明时，恢复层才可添加 synthetic error tool result；否则应拒绝 resume 并提示修复方式。

## 7. 分支与 Fork

P0 可以只实现线性 session，保留 `parentId` 字段即可。

P2 若实现 fork：

- 每个 entry 有 `parentId`；
- branch 是 entry tree 中的一条路径；
- `/fork` 从指定 entry 开启新分支；
- 废弃分支可以后续生成 branch summary。

原始 entries 始终 append-only。

## 8. Artifact 持久化

大输出和 transcript snapshot 存在 `artifacts/<session-id>/` 下。

Artifact record 应包含：

- artifact id；
- 相对路径；
- 类型：`tool_output`、`file_snapshot`、`transcript`、`diff` 等；
- size；
- redaction status；
- 关联 entry id。

Artifact 内容默认不视为可信 instruction。

## 9. 密钥处理

Session 文件不得包含：

- API keys；
- 完整环境变量 dump；
- 凭据文件内容；
- 未脱敏敏感文件内容，除非用户明确批准且配置允许。

args preview、命令输出、错误、telemetry-like details 在持久化前都应经过 redaction。

## 10. 并发

P0 可以假设同一 session 同一时间只有一个进程写入。

仍然必须满足：

- append write 必须 await；
- 尽量减少 partial write；
- session id 生成避免碰撞；
- 未实现 background runs 前，同一 session 的并发 run 应被拒绝。

## 11. 验收标准

实现满足本规范需要测试证明：

- 能 append session start、user、assistant、tool、summary、run end entries；
- 正常退出后可 resume；
- 取消后 session 文件仍合法；
- 损坏尾行不阻止恢复；
- 非尾部损坏能被检测；
- 恢复后的消息顺序满足 API 协议；
- artifact 可从 session entry 引用；
- fake secret 在持久化前被脱敏。
