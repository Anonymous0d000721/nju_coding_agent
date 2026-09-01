# 只读探索子 Agent

`ReadOnlyExplorer` 是一个由本项目维护的最小子循环，不依赖 LangChain、LlamaIndex、Agents SDK 或其他 Agent 编排框架。主 Agent 可通过 `explore_readonly` 请求一次受限探索；工具返回结构化结论，而不是把子 Agent 的完整 transcript 注入主上下文。

## 边界与失败语义

- 子 Agent 使用独立的 `AgentRunner`、消息数组和 `ToolRegistry`；只注册 `list_files`、`read_file`、`glob_files`、`grep_files`。
- 子 Agent 的 `ToolExecutor` 固定使用 `strict`，不注册写文件、shell、Git、后台任务、插件或 MCP 工具；越界调用会得到 `unknown_tool`，并在结论中标为 `permission_denied`。
- 每次探索有独立 `runId`、固定 workspace root 和可配置 wall-clock deadline。父级 `AbortSignal` 会取消模型和工具等待；deadline 结束时返回 `timed_out`，而不是伪装成完成。
- 模型异常返回 `failed`，父级取消返回 `cancelled`，权限拒绝返回 `permission_denied`，正常无工具回答返回 `completed`。
- 返回值只包含 `summary`、`findings`、`files`、计数、错误和有界 trace；父 Agent 不接收完整子会话历史。

## 审计

探索的 start、progress、tool_result、error、stop 事件可以通过宿主 `onTrace` 回调接入统一 telemetry，并带有子 `runId` 与父 `runId`。因此取消、失败、超时、工具错误和权限边界都可追踪，同时保留工具经过统一 `ToolExecutor`、workspace guard 和输出上限的约束。

## 确定性验收

```powershell
npm test -- --run tests/unit/explorer.test.ts
npm run typecheck
```

测试使用 FakeModel 覆盖正常读取、写入/命令越界、模型失败、父级取消和 deadline 超时；不会访问网络，也不会修改测试 workspace 外的文件。
