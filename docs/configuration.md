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
```

支持 OpenAI Chat、OpenAI Responses 和 Anthropic Messages。未设置思考级别时使用 `medium`；推理显示与模型思考强度是两个独立设置。

## 权限与信任

`permissionMode` 支持 `yolo`、`strict`、`confirm`，默认是 `yolo`。`yolo` 不是沙箱。项目 Trust 决定是否加载工作区内的指令、技能、插件和 MCP 配置；可用 `--approve` 或 `--no-approve` 覆盖本次运行。

## 会话、记忆与记录

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
