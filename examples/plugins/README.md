# 官方用户插件示例

这些示例只演示 `UserPlugin` 模块格式，不绕过主 Agent 的 `ToolExecutor`。

- `template.mjs`：最小模板，复制后修改 `id`、描述、schema 和 handler。
- `workspace-inventory.mjs`：只读示例，只使用受限的 workspace API 读取一个明确的相对路径。
- `controlled-note.mjs`：受控写入示例，只能通过 `ctx.workspace.writeText` 写入 workspace 内文件；写入仍由宿主的 policy、Change Journal、路径 guard 和审批控制。

插件目录：`.nju-agent/plugins/*.mjs`。只有受信任 workspace 才会加载用户插件。加载时宿主会校验版本、工具名、严格 JSON Schema、风险与 readonly 一致性，并记录源文件 SHA-256。单个插件加载失败只产生诊断，不阻止其他插件或主 Agent 启动。

插件 handler 必须尊重 `ctx.signal`，不得直接调用 shell、网络、子进程或访问 workspace 外路径。插件工具的实际执行仍统一经过 `ToolExecutor`。
