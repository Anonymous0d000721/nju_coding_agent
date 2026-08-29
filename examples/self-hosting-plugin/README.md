# 自举插件题目：nju-mcp-adaptor

为 `nju-agent` 开发一个用户插件 `nju-mcp-adaptor`，让 agent 能够把一个受控的 MCP 工具描述文件转换为本地工具定义并注册到当前运行。

推荐任务描述：

> 阅读 `src/plugins/types.ts`、`src/plugins/loader.ts`、`src/tools/types.ts` 和插件开发 skill。实现一个位于 `.nju-agent/plugins/` 的 `nju-mcp-adaptor` 插件：读取用户明确指定的本地 MCP manifest，校验工具名称、JSON Schema 和风险等级，转换为标准 `ToolDefinition`，并拒绝 workspace 外路径和未声明的外部连接。补充测试，运行主项目测试和示例测试。

约束：

- 插件必须导出 `default` 或 `plugin`；
- 工具必须经过标准 `ToolExecutor`，不能自行绕过权限审批；
- 不得自动读取网络或安装依赖；
- 不得修改测试来绕过失败；
- `ObservationalMemoryPlugin` 仍然不属于本题范围。

验收：插件能够被 `/reload` 发现，并在下一次 agent run 中出现在工具列表；插件错误不会破坏主 agent 启动。
