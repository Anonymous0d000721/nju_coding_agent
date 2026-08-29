# 配置说明

配置可以来自命令行、环境变量和工作区内未入库的 `.env`。命令行参数优先于环境变量；不要提交 `.env`。

## 模型

常用变量：

```text
NJU_AGENT_API_KEY
NJU_AGENT_BASE_URL
NJU_AGENT_MODEL
NJU_AGENT_API_FORMAT
NJU_AGENT_THINKING_LEVEL
NJU_AGENT_TOOL_PREVIEW_LINES
```

支持 OpenAI Chat、OpenAI Responses 和 Anthropic Messages。未设置思考级别时使用 `medium`；推理显示与模型思考强度是两个独立设置。

## 权限与信任

`permissionMode` 支持 `yolo`、`strict`、`confirm`，默认是 `yolo`。`yolo` 不是沙箱。项目 Trust 决定是否加载工作区内的指令、技能、插件和 MCP 配置；可用 `--approve` 或 `--no-approve` 覆盖本次运行。

## 工具活动预览

TUI 默认展示工具活动的前 8 行，可通过 `NJU_AGENT_TOOL_PREVIEW_LINES` 配置（范围 1–100）。`read_file` 显示文件与行范围，`write_file` 显示写入内容头部，`hashline_edit` 显示编辑 diff，`run_command` 显示完整命令与输出头部，其他工具显示关键参数和结果摘要。预览统一脱敏，TUI 只渲染工具事件提供的 preview。

## Agent 运行预算

Agent 不设置固定轮数或工具调用数量上限，会在模型完成、取消或错误时结束；上下文过长时由本地 deterministic compaction 压缩后继续运行。长时间运行应由用户取消或外部运行时预算控制。

## 会话、记忆与记录

- `NJU_AGENT_TOOL_PREVIEW_LINES`：工具活动预览的头部行数，默认 8，范围 1–100。
- `NJU_AGENT_MEMORY_ENABLED`：是否启用本地 Markdown Memory，默认启用。
- `NJU_AGENT_MEMORY_DIR`：记忆根目录；未设置时使用用户目录下的 nju-agent 记忆目录。
- `--telemetry off`：关闭本地运行记录。
- `--no-session`：禁用会话持久化。

## MCP

`NJU_AGENT_MCP_SERVERS` 使用 JSON 数组配置 stdio 服务，例如：

```json
[{"name":"local-tools","command":"node","args":["server.mjs"]}]
```

外部服务只在明确配置后启动，发现的工具仍经过主机的 schema、风险、权限、超时和脱敏处理。

## Hashline 编辑

编辑文件前先调用 `read_file` 并指定 `format: "hashline"`。锚点格式为 `LINE#HASH`，当前 hash 长度为 6 位十六进制字符；读取结果中的 `LINE#HASH:` 可以直接复制，编辑器会兼容剥离尾部冒号，但不能复制后面的正文。`hashline_edit` 会在同一快照中校验所有锚点，拒绝过期或重叠编辑，并返回新的文件 hash、换行风格和 `changedAnchors`。编辑失败时应按提示重新读取文件，不要模糊重定位旧锚点。
