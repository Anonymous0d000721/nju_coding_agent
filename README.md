# nju-agent

独立实现的 TypeScript/Node.js 本地 coding agent。模型通过原生 tool calling 读取、修改、检查工作区；项目不使用 LangChain、Agents SDK 等 agent framework。

## 运行

要求 Node.js 22+：

```powershell
npm install
Copy-Item .env.example .env
npm run dev -- --print "检查当前项目并运行测试"
```

在 `.env` 填写 `NJU_AGENT_API_KEY`、`NJU_AGENT_BASE_URL`、`NJU_AGENT_MODEL`，可用 `NJU_AGENT_API_FORMAT` 选择 `openai-chat`、`openai-responses` 或 `anthropic`。`--json` 输出机器可读结果，`--no-session` 不保存会话。

不带 prompt 进入 Ink TUI：

```powershell
npm run dev
```

TUI 支持多行编辑、可见光标、Markdown、流式文本、紧凑工具状态、prompt history 和 slash picker。`/resume` 会恢复最近对话并可按页加载更早历史；`/name <name>` 为当前 session 写入持久名称；`/fork` 创建保留当前可发送上下文的新 child session；`/model`、`/effort`、`/reasoning` 提供选择器。

## 演示 fixture

`examples/buggy-todo-cli/` 提供一个无网络依赖的故意失败任务。可先运行其测试观察失败，再让 agent 读取实现、修复代码并重新运行测试；fixture 自带 Vitest 配置，不参与主项目测试扫描。


- AgentRunner：多轮工具调用、预算、取消、结构化错误和流式事件。
- 文件/搜索/PowerShell 工具：工作区路径保护、超时、截断、权限模式。
- JSONL session：消息即时追加、损坏尾行恢复、历史分页。
- Instructions、catalog-first Skills、`load_skill`、生命周期 hooks 和有界上下文压缩。
- todo 持久化、脱敏本地 telemetry、MCP stdio JSON-RPC 工具发现与注册；MCP 仅在 `NJU_AGENT_MCP_SERVERS` 显式配置时启动。
- OpenAI Chat/Responses、Anthropic Messages 原生适配。

## 安全

API key 只从环境变量或未入库 `.env` 读取。工具不是操作系统 sandbox，按启动用户权限运行；路径保护、权限策略、超时和 redaction 不能替代容器、VM 或最小权限账户。

## 验证

```powershell
npm run typecheck
npm test -- --run
npm run build
```

架构、设计决策和限制见 `docs/architecture.md`、`docs/decisions.md`、`docs/threat-model.md`。参考代码只位于 `refs/`，不参与运行时。
