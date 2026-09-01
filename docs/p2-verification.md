# P2 平台能力验收记录

> 本记录对应 P2（从可靠内核发展为可扩展平台）四个小节，数据来自 2026-09-01 当前工作树的最后一轮验证；不沿用旧报告中的测试数字。

## 功能提交

- 用户插件体系：`2d90c02`；插件隔离修复：`808546e`、`5e02505`
- 用户插件开发规范与可发现 skill：`docs/plugin-development.md`、`skills/plugin-development/SKILL.md`（`b7d6b0d`）
- MCP 与外部工具生态基础能力：`5ddaa17`
- MCP runtime reload / 控制面资源清理 follow-up：`f418c54`
- 只读插件 workspace capability 收窄：`e9aa178`
- 插件 workspace 读取敏感路径保护：`a663168`
- 可观测性与性能基准：`ae9e987`
- 只读探索子 Agent：`9cad3a7`

每个逻辑功能均有独立提交。插件、MCP、telemetry/benchmark 和 explorer 的源码、测试及文档分别包含在对应提交中。用户插件规范明确模块格式、版本、schema、risk、readonly、workspace、signal、错误语义、测试规范和可复现验收命令；公开 skill 位于 `skills/plugin-development/SKILL.md`，不依赖被忽略的运行时目录。

## 自动化门禁

| 命令 | 结果 |
|---|---|
| `npm ci` | 通过，重新安装 91 个依赖包 |
| `npm test -- --run` | 通过，38 个测试文件、202 个测试 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |
| `npm run verify:offline`（第 1 轮） | 通过，2 个迭代，`networkRequests=0` |
| `npm run verify:offline`（第 2 轮） | 通过，2 个迭代，`networkRequests=0` |
| `npm run verify:examples` | 通过，三个示例均完成统一生命周期、reset、保护文件检查；故意缺陷明确标为 `expected_failed`/`exercise_pending` |
| `npm run benchmark` | 通过，所有 benchmark checks 为 `true`；任一 check 失败时脚本返回非零退出码；插件隔离检查注入 1 个坏插件并确认 12 个健康插件仍可调用，MCP 隔离检查注入 1 个坏 server 并确认 10 个健康 server 仍连接 |

## 基准摘要

基准使用 FakeModel、内存 MCP transport 和临时工作区，不访问网络或真实凭据：

- 启动初始化：`0.099 ms`
- 首 token：`0.023 ms`
- 8 个工具、并发上限 4：`31.197 ms`
- 工具平均耗时：`15.5 ms`
- 300 条历史 deterministic compaction：`2.484 ms`；摘要输出 `47503 chars`
- 重试等待：`28.321 ms`
- 12 个插件加载（另含 1 个故障插件）：`2208.293 ms`
- 10 个健康 MCP server（另含 1 个故障 server）连接：`2.125 ms`
- 进程堆内存变化：`1351344 bytes`（含 benchmark harness）
- 超大工具输出：`12039 chars`，有界检查通过
- telemetry 查询和插件/MCP 隔离检查均通过；插件 sandbox 已在临时目录清理前显式关闭，Windows `EBUSY` 清理回归通过

这些数字用于同一代码库的回归比较，不是生产 SLA。

## 安全与交付检查

- 已检查受跟踪文件中的密钥、私钥、疑似真实 token、cookie、密码和私密路径模式；未发现凭据。README 的公开仓库地址仍是用户要求保留的占位文字，不能伪造真实 URL。
- `.env` 未跟踪；`.env.example` 只包含空 API key 和示例配置。
- `git ls-files` 未发现 `node_modules`、`dist`、runtime、日志、视频或压缩包。
- 构建、示例和 offline 验收产生的根 `dist`、示例 `runtime`、本地日志及依赖目录均为忽略生成物，不进入提交。
- README 已补充 `NJU_AGENT_MAX_DURATION_MS`（默认 600000，范围 1–1800000）和 `NJU_AGENT_MAX_TOOL_CONCURRENCY`（默认 4，范围 1–8）；CLI help 同步展示两项配置。
- 用户插件在独立 Node permission 子进程中加载和调用，并在 worker 内通过无宿主引用的 `vm.SourceTextModule` context 执行；静态与动态 import 统一拒绝，计算得到的网络/子进程模块名也有回归覆盖。workspace capability 经 request/response RPC 保留，取消、子进程退出、加载超时和 fail-soft 诊断有回归覆盖；对应提交 `808546e`、`5e02505`。只读或 `read` 工具只获得 `readText`，写入工具才获得 `writeText`；宿主执行层和 sandbox worker 均有对抗性回归测试，防止只读插件绕过 policy 直接修改工作区。插件的 `readText` 和 `writeText` 都在 capability 层拒绝 `.git`、`.nju-agent`、`node_modules`、`.env`、SSH、证书、token、secret、credential 等敏感路径，硬编码敏感读取也有回归覆盖。
- MCP 的进程级 `McpRuntime` 在 RPC/TUI 生命周期内复用 `McpManager`；下一次运行通过真实 `McpManager.reload()` 比较工具目录，失败保留旧实例，配置移除会断开旧 server；活动运行不热替换。
- RPC/TUI `/reload` 的临时插件 sandbox 均在 `finally` 中释放，避免只为计数而遗留 worker。
- P2 `4.1`、`4.2`、`4.3`、`4.4` 的全部 checkbox 已与源码、测试、文档和独立提交对应；用户插件开发规范与公开 skill 还明确列出正常、非法参数、权限拒绝、越界、取消、超时、fail-soft、冲突、reload 和脱敏测试要求。插件 VM 隔离与动态导入回归后全量测试为 38 个测试文件、202 个测试。

## 已知限制

- `examples/feature-development` 保留 `reserveBatch_not_implemented` 作为题目要求的练习缺陷；其失败是有意且由验收脚本明确分类，不是基础设施失败。
- `yolo`、Trust、shell:false 和路径检查都不是操作系统沙箱；PowerShell、插件和外部 MCP 仍继承当前用户权限。
- 用户尚未提供公开仓库 URL，因此 README URL 未填入虚构地址；视频与姓名命名压缩包属于发布环节，不在本次 P2 源码能力提交中生成。
- 独立审计环境若无法启动 Node/npm（例如 WSL1 安装错误），无法替代本机 Windows 验证；当前报告保留命令输出与平台信息，不能声称在该故障环境中复跑成功。

## 最终工作树

本报告及相关文档已随对应提交更新。隔离修复后的最后一轮确认：`git status --short` 为空、`git diff --check` 退出码为 0，`git diff --name-only` 和 `git diff --cached --name-only` 均为空。
