# 用户插件开发规范

本文是 `nju-agent` 用户工具插件的权威开发规范。它适用于受信任 workspace 下的 `.nju-agent/plugins/*.mjs`，不适用于 `specs/plugins/` 中的 Context Harness 插件设计。

## 1. 适用范围与安全边界

用户插件用于向主 Agent 注册少量、边界清晰的工具。插件不是独立 Agent，也不是操作系统沙箱：Trust、Node permission、`shell:false` 和路径检查会降低未授权访问风险，但插件、PowerShell、MCP 和主进程仍受当前用户权限影响。高风险任务应使用容器、虚拟机或最小权限账户。

插件必须：

- 放在受信任 workspace 的 `.nju-agent/plugins/`；未信任 workspace 不执行插件模块。
- 只通过导出的标准 `UserPlugin` 注册工具；不得修改 `AgentRunner`、`ToolRegistry`、policy、Trust 或其他插件状态。
- 让所有实际调用经过宿主 `ToolExecutor`，由宿主统一完成 schema 校验、policy/审批、超时、取消、输出截断、telemetry 和错误包装。
- 使用宿主提供的 workspace capability 访问文件，不直接使用 `fs`、子进程、shell、网络或 MCP API。
- 不打印 API key、token、cookie、环境变量、完整 prompt 或未脱敏工具输出。

插件在独立 Node permission 子进程中加载和调用；workspace 读写经宿主 capability RPC 完成。该机制是纵深防御，不是对抗恶意代码的完整 OS 隔离。

## 2. 模块与工具契约

模块必须导出 `default` 或 `plugin`，值可以是 manifest，也可以是返回 manifest 的函数：

```js
export default {
  id: 'workspace-inventory',
  version: '1.0.0',
  description: 'Read one bounded inventory file.',
  tools: [
    {
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
    },
  ],
};
```

### Manifest 字段

- `id`：稳定的小写标识，匹配 `[a-z0-9][a-z0-9._-]{0,63}`。
- `version`：可选的 `x.y.z` 版本字符串；同一 `id` 的多个版本产生 `version_conflict`。
- `description`：可选且有界的文字描述，最长 2000 字符。
- `tools`：工具数组；同一插件内以及所有已加载插件之间的工具名都必须唯一。

### 工具字段

- `name`：小写 `snake_case` 名称，必须稳定且唯一。
- `description`：非空、最长 2000 字符，说明实际边界和副作用。
- `risk`：只能是 `read`、`write`、`shell` 或 `external`。
- `readonly`：只有 `risk: 'read'` 可以为 `true`；写入、shell 和外部副作用必须为 `false`。
- `parameters`：根 `type` 必须为 `object`；`additionalProperties` 只能为 `false`（省略也按无额外字段处理）。禁止 `$ref`、`allOf`、`anyOf`、`not` 等难以审计的组合，也禁止 `command`、`cwd`、`env`、`exec`、`network`、`url`、`token`、`secret` 等伪装能力字段。
- `handler(args, ctx)`：异步或同步均可；必须检查并尊重 `ctx.signal`，并通过 `ctx.workspace` 使用受限文件能力。
- `timeoutMs`：可选，范围为 1–300000 毫秒；长任务应设置合理上限。

风险声明不会授予能力。`write`、`shell` 和 `external` 工具仍需经过宿主 policy；在 strict/confirm 模式下可能被拒绝或要求审批，yolo 也不会无条件放行外部副作用。

## 3. workspace、取消与数据边界

可用能力取决于工具风险：

- 只读工具只获得 `ctx.workspace.readText`。
- 写入工具可获得 `ctx.workspace.writeText`；写入仍经过 workspace guard、敏感路径检查、原子写入、Change Journal 和 mutation telemetry。
- 路径必须是 workspace 内的相对路径。宿主拒绝绝对路径、相对越界、盘符切换、UNC 越界、NUL、symlink/junction/reparse-point 越界以及受保护目标。
- `.git`、`.nju-agent`、`node_modules`、`.env`、SSH、证书、token、secret 和 credential 目标不得读写。
- handler 发现 `ctx.signal.aborted` 后应尽快停止；取消结果使用 `user_cancelled`。宿主超时使用结构化 `tool_timeout`，插件异常会被包装为工具失败，不应泄漏 secrets。

不得把 `workspaceRoot` 当作绕过 guard 的许可，不得从环境变量推导凭据，不得把用户参数拼接成 shell 命令或动态模块名。

## 4. 加载、reload 与失败语义

宿主按文件名扫描插件，并为成功加载的源文件计算 SHA-256，生成本地信任提示。模块、导出函数或 manifest 校验失败时：

- 单个插件只产生 `recoverable: true` 的诊断，其他插件和主 Agent 继续运行。
- 诊断使用 `load_failed`、`invalid_manifest`、`forbidden_capability`、`version_conflict` 或 `tool_name_conflict` 等稳定代码。
- 宿主不把失败插件的工具注册到 registry，也不执行其 handler。
- 子进程加载超时、退出、调用失败或 capability RPC 失败会转换为可追踪的诊断/工具错误，并清理子进程和待处理请求。
- `/reload` 只影响下一次 Agent run；活动 run 不热替换。reload 失败时保留当前 run 可用的旧工具集合，不能留下半初始化集合。

插件应尽量无状态。若必须维护模块状态，必须能在 reload 后重新初始化，并且不能依赖 reload 顺序或其他插件的内部对象。

## 5. 测试规范

每个工具至少应有确定性测试覆盖：

1. 正常输入和稳定输出；
2. 缺少字段、错误类型、额外字段等非法参数；
3. policy/审批拒绝，且确认 handler 未被调用；
4. workspace 越界、敏感路径和 symlink/junction 越界；
5. `AbortSignal` 取消、工具超时和子进程退出；
6. 失败插件与健康插件并存时的 fail-soft 隔离；
7. 重复插件 id、版本冲突、工具名冲突、宽 schema、危险字段和非法导出；
8. SHA-256 信任提示、reload 后新版本生效以及活动 run 不被热替换；
9. 只读工具没有 `writeText`，受控写入进入 mutation journal；
10. 错误结果经过脱敏，不包含 secret、完整环境变量或敏感文件内容。

测试必须使用 FakeModel、临时 workspace 和本地确定性 fixture，不使用真实 API key、真实用户数据或网络；不得修改测试来掩盖插件缺陷，不得自动安装依赖或联网。

已有回归入口：

- `tests/unit/plugin-loader.test.ts`：Trust、hash、reload、sandbox、动态导入、敏感路径、取消、fail-soft、schema 和冲突。
- `tests/unit/plugin-workspace.test.ts`：ToolExecutor、workspace guard、policy、mutation journal、只读能力和取消。
- `examples/plugins/`：`template.mjs`、只读 `workspace-inventory.mjs` 和受控写入 `controlled-note.mjs`。

## 6. 可复现验收命令

在仓库根目录执行以下命令；Windows PowerShell 与 CI 使用同一入口：

```powershell
npm ci --ignore-scripts
npm test -- --run tests/unit/plugin-loader.test.ts tests/unit/plugin-workspace.test.ts
npm run typecheck
npm run build
npm run verify:offline
npm run verify:examples
npm run benchmark
npm run typecheck
npm run build
git diff --check
```

插件专项通过标准：

- loader 与 workspace 专项测试全部通过；
- 全项目 typecheck/build 通过；
- offline 验收报告 `networkRequests=0`；
- examples 验收将故意缺陷标为 `expected_failed` 或 `exercise_pending`，不混同为基础设施失败；
- benchmark 的 `pluginIsolation`、`largeOutputBounded` 和 telemetry 检查为 `true`；
- `git diff --check` 无真实错误，生成的 `dist`、runtime、日志和依赖目录清理后不进入提交。

提交前还应记录：插件源文件相对路径、审阅过的 SHA-256、诊断代码、测试命令及已知限制。最终报告不得把 Trust、yolo 或 Node permission 描述成 OS 沙箱。

## 7. 官方示例

- [`examples/plugins/template.mjs`](../examples/plugins/template.mjs)：最小 manifest 模板。
- [`examples/plugins/workspace-inventory.mjs`](../examples/plugins/workspace-inventory.mjs)：只读 workspace capability 示例。
- [`examples/plugins/controlled-note.mjs`](../examples/plugins/controlled-note.mjs)：受控写入、policy 和 mutation journal 示例。
- [插件运行时 skill](../.nju-agent/skills/plugin-development/SKILL.md)：供 Agent 按需加载的简明操作指引。
