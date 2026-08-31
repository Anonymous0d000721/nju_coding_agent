# Agent 练习场景

`examples/` 提供可重复、可恢复的真实编程任务。每个场景都有源码、固定 fixture、测试、阶段说明和 reset 脚本，不是一次性问答。每个场景统一提供 `baseline`、`demo`、`test`、`typecheck`、`build`、`accept`、`lifecycle` 和 `reset` 入口；入口输出面向验收的 JSON 结果，故意失败会标记为 `expected_failed`，未实现练习会标记为 `exercise_pending`，不伪装成基础设施成功。

建议从仓库根目录启动：

```powershell
npm run dev
```

再把对应目录作为工作区，按场景 README 的 Phase 1、Phase 2 执行。Phase 1 只调查和运行 baseline；中途退出后使用 `/resume` 恢复原 session，再继续实现。需要重新开一轮时，执行对应目录的 `scripts/reset.mjs`。根目录 `npm run verify:examples` 会顺序运行三个场景，检查 baseline 语义、两次 demo、生命周期契约、专项验收、重复 reset 和源码/测试/fixture 哈希不变，并输出单个 JSON 证据对象。

## 场景

- `buggy-todo-cli/`：修复带 JSON 持久化、分页、过滤、截止时间、统计、版本冲突和原子写回的订单任务服务。
- `feature-development/`：为库存服务增加批量预留、原子回滚、requestId 幂等和审计事件；baseline 保留未实现方法。
- `self-hosting-plugin/`：实现 `nju-mcp-adaptor`，校验本地 manifest 的工具名称、JSON Schema、风险字段、路径和外部执行字段。

## 恢复验收

1. `npm run baseline`，记录失败点和 session ID。
2. 退出并使用 `/resume` 恢复；`npm run lifecycle` 提供可重复的 `running → cancelled → resumed → completed` 状态契约，便于无模型回归检查取消与继续关系。
3. 完成实现，运行 `npm run test`、`npm run typecheck`、`npm run build` 和 `npm run accept`。
4. 再次恢复，要求 agent 解释改动、测试和剩余风险。
5. 执行 `npm run reset`，重复 demo/验收；根目录脚本还会验证 reset 幂等以及受保护文件哈希不变。

`lifecycle` 是离线状态契约，不冒充真实模型会话；真实 `/resume`、取消和 RPC/TUI 集成仍由主项目测试与手工演示验证。禁止修改测试来绕过失败，也不要删除状态文件伪造恢复成功。
