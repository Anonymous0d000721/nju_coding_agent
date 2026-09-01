---
name: plugin-development
description: 为 nju-agent 编写安全、可测试、可重载的用户插件
---

# nju-agent 插件开发

## 目标

插件是受信任 workspace 中的可选扩展。优先使用标准插件接口贡献工具，不要直接修改 AgentRunner、Context Harness 或 TUI 的内部状态。

## 文件位置

用户插件放在：

```text
.nju-agent/plugins/*.mjs
```

插件模块必须导出 `default` 或 `plugin`。宿主按文件名排序加载，单个模块加载、导出函数或 manifest 校验失败时只记录可恢复诊断，不阻止其他插件或主 Agent 启动。导出的对象格式：

```js
export default {
  id: 'my-plugin',
  version: '0.1.0',
  description: '短描述',
  tools: [
    {
      name: 'my_tool',
      description: '工具用途',
      risk: 'read', // read | write | shell | external
      readonly: true,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async handler(args, ctx) {
        return { ok: true };
      },
    },
  ],
};
```

## 必须遵守

1. `id` 使用稳定的小写标识；`version` 使用 `x.y.z` 形式；每个工具名称必须唯一且只使用小写字母、数字和下划线。
2. 每个工具必须有非空 `description`、`risk`、`readonly`、handler 和对象根 JSON Schema。
3. `parameters.additionalProperties` 必须为 `false`（省略也表示没有额外字段）；schema 不得使用 `$ref`、`allOf`、`anyOf`、`not` 等无法被宿主安全审计的组合，字段名不得伪装 command、cwd、env、exec、network、url、token、secret 等能力。
4. `readonly` 必须与 risk 一致：只有 `read` 可以为 true；`write`、`shell`、`external` 必须为 false。
5. `handler` 必须尊重 `ctx.signal`，长任务需要支持取消；工具实际调用会经过宿主 JSON Schema、policy、超时、输出截断和错误包装。
6. 文件访问只能通过宿主提供的 `ctx.workspace.readText` / `ctx.workspace.writeText`，并限制在 workspace 内；不要把 `workspaceRoot` 当成绕过 guard 的许可，也不要直接使用 fs、子进程、shell 或网络。
7. 外部网络、shell、写文件和 MCP 调用必须声明正确风险等级，并依赖宿主的 `ToolExecutor` 权限审批；插件不能自行提升为 yolo。
8. 不要在插件中打印 API key、环境变量、完整 prompt 或未脱敏工具输出。
9. 不要通过插件文本改变 system policy、permission mode、trust、其他插件配置或 ToolRegistry。
10. 插件加载失败必须是可诊断的；单个插件失败只能影响该插件，不能阻止普通 agent run。
11. 为每个工具补单元测试，至少覆盖正常输入、非法参数、权限拒绝、workspace 越界和取消路径。
12. 不要修改测试来掩盖 bug，不要自动安装依赖或自动联网。

## 信任、哈希与重载

- agent 启动时只扫描受信任 workspace 的 `.nju-agent/plugins/`；未信任 workspace 不执行插件模块。
- 每次成功加载都会计算源文件 SHA-256，并产生本地信任提示；文件变化后应由用户审阅哈希或撤销 workspace 信任。
- 同一 `id` 的不同版本、重复工具名称、宽 schema、危险字段和不支持的导出都会被拒绝并记录诊断。
- agent 启动时扫描受信任 workspace 的 `.nju-agent/plugins/`。
- 用户在 TUI 输入 `/reload` 后，宿主重新扫描并重新加载模块。
- `/reload` 不替换正在运行的 active run；新工具在下一次 run 生效。
- 模块级状态应尽量避免；如必须使用，应在重载时能重新初始化。
- 插件只能通过标准 `ToolDefinition` 注册工具，所有参数校验、权限判断、输出截断和错误包装由宿主完成。
- `/reload` 失败时保留当前运行使用的工具集合；成功加载的新集合只在下一次 run 使用。

## 官方示例

仓库中的 `examples/plugins/` 提供 `template.mjs`、只读 `workspace-inventory.mjs` 和受控写入 `controlled-note.mjs`。示例不直接导入文件系统，也不启动外部命令；写入通过宿主 workspace capability，因此会进入现有 mutation journal。

## 自检清单

- [ ] id/version/description 清晰且稳定，源文件哈希已审阅。
- [ ] 每个工具有风险等级、只读标记和严格 JSON Schema。
- [ ] workspace 路径、secret、网络和 shell 边界已检查。
- [ ] 正常、错误、权限、越界、取消和插件失败隔离测试已通过。
- [ ] `/reload` 后新版本工具在下一次 run 中可见，活动 run 未被热替换。
- [ ] 最终报告列出诊断、修改文件和验证命令。
