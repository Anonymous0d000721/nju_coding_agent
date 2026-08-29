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

插件模块必须导出 `default` 或 `plugin`。导出的对象格式：

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

1. 工具名称必须稳定、唯一、使用小写字母/数字/下划线。
2. `parameters` 必须是严格 JSON Schema；拒绝未知参数并声明 required 字段。
3. `handler` 必须尊重 `ctx.signal`，长任务需要支持取消。
4. 文件访问必须限制在 `ctx.workspaceRoot` 内；不要把 workspace 外路径当作安全路径。
5. 外部网络、shell、写文件和 MCP 调用必须声明正确风险等级，并依赖宿主的 `ToolExecutor` 权限审批。
6. 不要在插件中打印 API key、环境变量、完整 prompt 或未脱敏工具输出。
7. 不要通过插件文本改变 system policy、permission mode、trust 或其他插件配置。
8. 插件加载失败必须是可诊断的；不能阻止没有使用该插件的普通 agent run。
9. 为每个工具补单元测试，至少覆盖正常输入、非法参数、权限拒绝和取消路径。
10. 不要修改测试来掩盖 bug，不要自动安装依赖或自动联网。

## 重载与生命周期

- agent 启动时扫描受信任 workspace 的 `.nju-agent/plugins/`。
- 用户在 TUI 输入 `/reload` 后，宿主重新扫描并重新加载模块。
- `/reload` 不替换正在运行的 active run；新工具在下一次 run 生效。
- 模块级状态应尽量避免；如必须使用，应在重载时能重新初始化。
- 插件只能通过标准 `ToolDefinition` 注册工具，所有参数校验、权限判断、输出截断和错误包装由宿主完成。

## 自检清单

- [ ] id/version/description 清晰且稳定。
- [ ] 每个工具有风险等级、只读标记和 JSON Schema。
- [ ] workspace 路径、secret、网络和 shell 边界已检查。
- [ ] 正常、错误、权限、取消测试已通过。
- [ ] `/reload` 后新版本工具在下一次 run 中可见。
- [ ] 最终报告列出修改文件和验证命令。
