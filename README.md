# nju-agent

一个自行实现的 TypeScript / Node.js 本地 coding agent。它通过模型原生工具调用读取、修改和检查当前工作区，并将对话和工具结果保存为可恢复的 JSONL session。

## 运行

要求 Node.js 22+。

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，填写本地未入库的 API 配置：

```text
NJU_AGENT_API_KEY=your-key
NJU_AGENT_BASE_URL=https://api.anthropic.com
NJU_AGENT_MODEL=your-model
NJU_AGENT_API_FORMAT=anthropic
```

运行单条任务：

```powershell
npm run dev -- --print "列出当前项目的文件，并说明每个目录的用途"
```

也支持 `openai-chat`、`openai-responses` 和 `anthropic` 三种协议，可用 `--api-format` 覆盖环境变量。`--json` 输出单行机器可读结果，`--no-session` 禁止持久化。

不带 prompt 时进入交互模式：

```powershell
npm run dev
```

交互命令包括 `/help`、`/new`、`/sessions`、`/resume <id>`、`/session` 和 `/quit`。

## 当前能力

- 自建有限 agent loop：模型回复、批量工具调用、结果回填、最大轮数和工具调用预算。
- 文件工具：`list_files`、`read_file`、`write_file`、`hashline_edit`、`glob_files`、`grep_files`。
- PowerShell `run_command`：工作区 cwd、超时、取消、退出码、输出截断和基本危险命令拒绝。
- 工作区路径保护、敏感路径保护、参数 JSON Schema 校验、未知工具和工具异常的结构化结果。
- Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 原生适配，工具调用 ID 会被严格配对。
- JSONL session：追加保存 user / assistant / tool 消息，支持重启后通过 `--session <id>` 或 `/resume` 继续。

## 安全边界

API key 只从环境变量或未入库 `.env` 读取，不传入命令行，不写入 session 和日志。文件访问限制在 workspace 内；工具结果有大小上限；`strict` 和 `confirm` 模式在没有审批回调时拒绝写入和 shell 工具。项目内容属于不可信数据，不能替代宿主安全策略。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

本项目不依赖任何 agent 框架；agent loop、工具注册与校验、消息转换、会话持久化和安全边界均由本项目实现。参考资料仅位于 `refs/`，不参与运行时。
