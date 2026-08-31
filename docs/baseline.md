# 当前基线验证记录

> 本记录对应最终交付前门禁；它只记录本轮实际运行的可复现证据，不沿用早期报告数字。

## 验证环境

- 日期：2026-09-01
- Node.js：22+
- 工作树：`main`
- 网络：离线验收脚本报告 `networkRequests=0`

## 根项目

| 命令 | 结果 |
|---|---|
| `npm test -- --run` | 通过，35 个测试文件、168 个测试 |
| `npm run typecheck` | 通过（`npm ci --ignore-scripts` 后验证） |
| `npm run build` | 通过（`npm ci --ignore-scripts` 后验证） |
| `git diff --check` | 通过 |
| `npm run verify:offline`（第 1 轮） | 通过，2 个迭代完成，`networkRequests=0` |
| `npm run verify:offline`（第 2 轮） | 通过，2 个迭代完成，`networkRequests=0` |

离线 FakeModel 验收同时确认：故意缺陷的 baseline 测试按预期失败，修复后的测试、typecheck、build 均通过；测试文件和 fixture 未被修改；reset 能恢复 fixture。

## 示例项目

| 示例 | 测试结果 | 当前状态 |
|---|---|---|
| `examples/buggy-todo-cli` | 2 个测试文件、6 个测试通过 | baseline 已可测试，demo/reset 可执行 |
| `examples/feature-development` | 1 个测试文件、5 个测试中 2 个通过、3 个失败 | 3 个 `reserveBatch` 失败属于 TODO 明确保留的故意缺陷 |
| `examples/self-hosting-plugin` | 1 个测试文件、3 个测试通过 | manifest adaptor 专项测试已通过 |

三个示例均执行了 `npm run reset`。验证完成后已清理示例 `runtime`、`dist` 和 `node_modules`，以及根项目 `dist` 和本地运行日志/会话生成物；这些生成物不进入 Git。

## 交付说明与剩余限制

- `feature-development` 的 `reserveBatch` 仍是故意保留的练习缺陷；其 baseline/test/accept 输出均明确标注 `expected_failed` 或 `exercise_pending`，不计为基础设施失败。
- `npm run verify:examples` 本轮完成三个示例的 baseline、demo、重复 demo、test、typecheck、build、accept、lifecycle、重复 reset 和受保护文件哈希检查；验证后已清理 runtime、dist、node_modules 和本地日志。
- 当前 Git 仓库未配置 remote，因此 README 的公开仓库 URL 仍保留占位文字；发布前必须替换为真实公开 URL。
