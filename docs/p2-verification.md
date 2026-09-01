# P2 平台能力验收记录

> 本记录对应 P2（从可靠内核发展为可扩展平台）四个小节，数据来自 2026-09-01 当前工作树的最后一轮验证；不沿用旧报告中的测试数字。

## 功能提交

- 用户插件体系：`2d90c02`
- MCP 与外部工具生态：`5ddaa17`
- 可观测性与性能基准：`ae9e987`
- 只读探索子 Agent：`9cad3a7`

每个逻辑功能均有独立提交。插件、MCP、telemetry/benchmark 和 explorer 的源码、测试及文档分别包含在对应提交中。

## 自动化门禁

| 命令 | 结果 |
|---|---|
| `npm ci` | 通过，重新安装 91 个依赖包 |
| `npm test -- --run` | 通过，37 个测试文件、187 个测试 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `git diff --check` | 通过 |
| `npm run verify:offline`（第 1 轮） | 通过，2 个迭代，`networkRequests=0` |
| `npm run verify:offline`（第 2 轮） | 通过，2 个迭代，`networkRequests=0` |
| `npm run verify:examples` | 通过，三个示例均完成统一生命周期、reset、保护文件检查；故意缺陷明确标为 `expected_failed`/`exercise_pending` |
| `npm run benchmark` | 通过，所有 benchmark checks 为 `true` |

## 基准摘要

基准使用 FakeModel、内存 MCP transport 和临时工作区，不访问网络或真实凭据：

- 首 token：`0.010 ms`
- 8 个工具、并发上限 4：`42.223 ms`
- 工具平均耗时：`21.125 ms`
- 300 条历史 deterministic compaction：`2.184 ms`
- 重试等待：`9.067 ms`
- 12 个插件加载：`24.820 ms`
- 10 个 MCP server 连接：`1.286 ms`
- 超大工具输出：`12039 chars`，有界检查通过
- telemetry 查询和插件/MCP 隔离检查均通过

这些数字用于同一代码库的回归比较，不是生产 SLA。

## 安全与交付检查

- 已检查受跟踪文件中的密钥、私钥、疑似真实 token、cookie、密码和私密路径模式；未发现凭据。README 的公开仓库地址仍是用户要求保留的占位文字，不能伪造真实 URL。
- `.env` 未跟踪；`.env.example` 只包含空 API key 和示例配置。
- `git ls-files` 未发现 `node_modules`、`dist`、runtime、日志、视频或压缩包。
- 构建、示例和 offline 验收产生的根 `dist`、示例 `runtime`、本地日志及依赖目录均为忽略生成物，不进入提交。
- README 已补充 `NJU_AGENT_MAX_DURATION_MS`（默认 600000，范围 1–1800000）和 `NJU_AGENT_MAX_TOOL_CONCURRENCY`（默认 4，范围 1–8）；CLI help 同步展示两项配置。
- P2 `4.1`、`4.2`、`4.3`、`4.4` 的全部 checkbox 已与源码、测试、文档和独立提交对应。

## 已知限制

- `examples/feature-development` 保留 `reserveBatch_not_implemented` 作为题目要求的练习缺陷；其失败是有意且由验收脚本明确分类，不是基础设施失败。
- `yolo`、Trust、shell:false 和路径检查都不是操作系统沙箱；PowerShell、插件和外部 MCP 仍继承当前用户权限。
- 用户尚未提供公开仓库 URL，因此 README URL 未填入虚构地址；视频与姓名命名压缩包属于发布环节，不在本次 P2 源码能力提交中生成。

## 最终工作树

本报告和 README/TODO/help 文档修改验证后提交；提交前再次确认 `git status --short` 为空。
