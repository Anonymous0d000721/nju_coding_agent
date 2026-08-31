# 当前基线验证记录

> 本记录对应提交 `baseline: record current verified state`，用于区分当前可复现证据与历史报告数字。

## 验证环境

- 日期：2026-08-31
- Node.js：22+
- 工作树：`main`
- 网络：离线验收脚本报告 `networkRequests=0`

## 根项目

| 命令 | 结果 |
|---|---|
| `npm test -- --run` | 通过，33 个测试文件、146 个测试 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
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

## 已知限制

- `feature-development` 的 `reserveBatch` 尚未实现，后续里程碑负责完成该练习及其独立验收。
- 示例尚未统一提供 `baseline`、`typecheck` 等根入口；这属于后续示例工程化里程碑。
- 当前记录不把故意失败计入基础设施失败，也不把历史报告数字作为本次证据。
