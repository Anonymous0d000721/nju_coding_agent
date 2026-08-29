# 自举插件：nju-mcp-adaptor

这是一个可恢复的插件开发任务，不是单次生成一个示例文件。目标是在受信任 workspace 中实现一个安全的本地 MCP manifest adaptor，并通过主项目 loader、ToolExecutor 和 RPC/TUI 流程验证。

## 阶段任务

### Phase 1：调查与设计

阅读主项目：

```text
src/plugins/types.ts
src/plugins/loader.ts
src/tools/types.ts
.nju-agent/skills/plugin-development/SKILL.md
```

阅读 `fixtures/` 中的合法、非法、越界 manifest，运行已有测试，明确 manifest 到 `ToolDefinition` 的映射、风险等级、参数 schema 和错误边界。只写计划，不修改测试绕过失败。

### Phase 2：实现 adaptor

实现 `.nju-agent/plugins/nju-mcp-adaptor.mjs`，提供一个本地工具，例如 `nju_mcp_manifest_info` 或 `nju_mcp_call_local`：

- 只读取调用者明确指定的 workspace 内 manifest；
- 校验版本、工具名称、JSON Schema、risk/readonly 字段；
- 拒绝 workspace 外路径、网络 URL、shell 字段和未声明的外部连接；
- 返回稳定、可诊断的错误，不泄露环境变量；
- 所有实际工具调用都经过标准 `ToolExecutor` 和权限模式；
- 不自行安装依赖，不访问网络。

补充 loader、schema、路径、reload、错误恢复测试。实现期间可以退出 agent，之后用 `/resume` 继续，不要重复已完成的调查。

### Phase 3：集成回归

先运行插件自己的专项测试：

```powershell
npm test
npm run reset
```

在受信任 workspace 中验证：

```powershell
npm run dev -- --print "读取 manifest 并列出可用工具"
```

然后修改插件文件，执行 TUI `/reload`，确认新工具在下一次 run 出现；活动 run 不应被热替换。再验证未信任 workspace 不加载插件、非法 manifest 不破坏 agent 启动。

### 重置与重复测试

`fixtures/` 是只读输入；用 `scripts/reset.mjs` 清理生成的临时 manifest 和测试输出。每轮都可从 Phase 1 开始，或恢复任意中断 session。

验收：主项目全量测试、插件专项测试、typecheck 均通过，并能解释 trust gating、标准 ToolExecutor、schema 校验和 cache-busting reload 的作用。
