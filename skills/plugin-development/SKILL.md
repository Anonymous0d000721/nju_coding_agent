---
name: plugin-development
description: 为 nju-agent 编写安全、可测试、可重载的用户工具插件
---

# 用户插件开发 Skill

本 skill 适用于 `nju-agent` 的用户工具插件：受信任 workspace 下的 `.nju-agent/plugins/*.mjs`。它不是 Context Harness 插件规范；后者位于 `specs/plugins/`。

## 目标与边界

用户插件只能注册边界清晰的标准工具。所有调用仍经过宿主 `ToolExecutor`、workspace guard、policy/审批、超时、取消、输出脱敏、telemetry 和必要的 Change Journal。Trust、Node permission、`shell:false` 和路径检查是纵深防御，不是完整 OS 沙箱；插件、PowerShell、MCP 和主进程仍继承当前用户权限。

插件不得修改 `AgentRunner`、`ToolRegistry`、policy、Trust 或其他插件状态，不得直接使用 `fs`、子进程、shell、网络或 MCP API，不得打印 API key、token、cookie、环境变量、完整 prompt 或未脱敏工具结果。

## 模块契约

插件文件必须导出 `default` 或 `plugin`，值可以是 manifest，也可以是返回 manifest 的函数：

```js
export default {
  id: 'workspace-inventory',
  version: '1.0.0',
  description: 'Read one bounded inventory file.',
  tools: [{
    name: 'inventory_lookup',
    description: 'Read the workspace inventory summary.',
    risk: 'read',
    readonly: true,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler(_args, ctx) {
      if (ctx.signal?.aborted) {
        throw Object.assign(new Error('Plugin execution was cancelled'), { code: 'user_cancelled' });
      }
      return ctx.workspace.readText('fixtures/inventory.json');
    },
  }],
};
```

Manifest 要求：

- `id` 是稳定的小写标识，匹配 `[a-z0-9][a-z0-9._-]{0,63}`；`version` 可选但必须是 `x.y.z`。
- `description` 可选且最长 2000 字符；`tools` 必须是数组。
- 工具名必须是唯一的小写 `snake_case`，描述非空且最长 2000 字符。
- `risk` 只能是 `read`、`write`、`shell`、`external`；只有 `read` 可设置 `readonly: true`。
- `parameters` 根类型必须为 `object`，`additionalProperties` 只能为 `false`（省略也表示无额外字段）。禁止 `$ref`、`allOf`、`anyOf`、`not` 及 `command`、`cwd`、`env`、`exec`、`network`、`url`、`token`、`secret` 等危险字段。
- `handler(args, ctx)` 可同步或异步，但必须尊重 `ctx.signal`；长任务应设置 1–300000 毫秒的 `timeoutMs`。

风险字段只是声明，不是授权。写入、shell 和外部副作用仍由宿主 policy 决定；strict/confirm 可能拒绝或要求审批，yolo 也不会无条件放行外部副作用。

## workspace 与取消

- 插件文件必须位于受信任 workspace 的 `.nju-agent/plugins/`；未信任 workspace 不执行模块。
- 只读工具只能获得 `ctx.workspace.readText`；写入工具才获得 `writeText`。
- 文件访问只使用 workspace capability 的相对路径。宿主拒绝绝对路径、相对越界、盘符切换、UNC 越界、NUL、越界 symlink/junction/reparse point 和敏感目标。
- `.git`、`.nju-agent`、`node_modules`、`.env`、SSH、证书、token、secret、credential 等路径不得读写。
- 取消使用 `AbortSignal`；插件尽快停止并抛出 `code: 'user_cancelled'`。宿主超时使用 `tool_timeout`，插件异常会包装为工具失败且不得泄漏敏感内容。
- 不得把 `workspaceRoot` 当作绕过 guard 的许可，不得拼接 shell 命令或动态模块名来获得额外能力。

模块和 handler 在独立 Node permission 子进程中运行，workspace 读写经宿主 capability RPC；这降低风险但不替代容器、虚拟机或最小权限账户。

## 加载、诊断与 reload

宿主按文件名加载并为成功源文件计算 SHA-256，产生本地信任提示。以下错误必须 fail-soft：

- 模块导入、导出函数、manifest/schema、风险一致性或能力审计失败；
- 加载超时、子进程退出、调用失败或 capability RPC 失败；
- 重复插件 id/版本、工具名冲突、宽 schema 和危险字段。

单个插件失败只产生 `recoverable: true` 诊断，不能阻止其他插件或主 Agent。诊断代码包括 `load_failed`、`invalid_manifest`、`forbidden_capability`、`version_conflict` 和 `tool_name_conflict`。失败插件的工具不得注册或执行；待处理请求、子进程和监听器必须清理。

`/reload` 只影响下一次 run，活动 run 不热替换。reload 失败时保留当前 run 的旧工具集合，不得留下半初始化集合。模块状态应可重新初始化；每次成功 reload 都应重新审阅源文件 hash。

## 测试规范

每个工具必须使用 FakeModel、临时 workspace 和本地确定性 fixture 测试，至少覆盖：

1. 正常输入和稳定输出；
2. 缺失字段、错误类型和额外字段等非法参数；
3. policy/审批拒绝，并确认 handler 未执行；
4. workspace 越界、敏感路径和 symlink/junction 越界；
5. `AbortSignal` 取消、工具超时和子进程退出；
6. 一个坏插件与健康插件并存时的 fail-soft 隔离；
7. 重复 id、版本冲突、工具名冲突、宽 schema、危险字段和非法导出；
8. SHA-256 信任提示、reload 后版本生效和活动 run 不热替换；
9. 只读工具没有 `writeText`，受控写入进入 mutation journal；
10. 错误、日志和诊断已脱敏，不包含 secret、环境变量或敏感文件内容。

测试不得使用真实 API key、真实用户数据或网络，不得修改测试掩盖问题，不得自动安装依赖或联网。

## 可复现验收

在仓库根目录运行：

```powershell
npm ci --ignore-scripts
npm test -- --run tests/unit/plugin-loader.test.ts tests/unit/plugin-workspace.test.ts
npm run typecheck
npm run build
npm run verify:offline
npm run verify:examples
npm run benchmark
git diff --check
```

通过标准：插件 loader/workspace 专项、typecheck 和 build 全部通过；offline JSON 的 `networkRequests=0`；examples 将故意缺陷标为 `expected_failed` 或 `exercise_pending`；benchmark 的 `pluginIsolation`、`largeOutputBounded` 和 telemetry 检查均为 `true`；生成的 `dist`、runtime、日志和依赖目录清理后不进入 Git。验收记录还应列出源文件相对路径、SHA-256、诊断代码、命令输出和已知限制。

## 官方示例与详细参考

- [`examples/plugins/template.mjs`](../../examples/plugins/template.mjs)：最小 manifest。
- [`examples/plugins/workspace-inventory.mjs`](../../examples/plugins/workspace-inventory.mjs)：只读 capability。
- [`examples/plugins/controlled-note.mjs`](../../examples/plugins/controlled-note.mjs)：受控写入和 mutation journal。
- [`docs/plugin-development.md`](../../docs/plugin-development.md)：完整开发规范与验收说明。
- [`examples/plugins/README.md`](../../examples/plugins/README.md)：示例索引。
