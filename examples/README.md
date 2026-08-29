# Agent 练习场景

`examples/` 提供可重复、可恢复的真实编程任务。每个场景都有源码、固定 fixture、测试、阶段说明和 reset 脚本，不是一次性问答。

建议从仓库根目录启动：

```powershell
npm run dev
```

再把对应目录作为工作区，按场景 README 的 Phase 1、Phase 2 执行。Phase 1 只调查和运行 baseline；中途退出后使用 `/resume` 恢复原 session，再继续实现。需要重新开一轮时，执行对应目录的 `scripts/reset.mjs`。

## 场景

- `buggy-todo-cli/`：修复带 JSON 持久化、分页、过滤、截止时间、统计、版本冲突和原子写回的订单任务服务。
- `feature-development/`：为库存服务增加批量预留、原子回滚、requestId 幂等和审计事件；baseline 保留未实现方法。
- `self-hosting-plugin/`：实现 `nju-mcp-adaptor`，校验本地 manifest 的工具名称、JSON Schema、风险字段、路径和外部执行字段。

## 恢复验收

1. 运行 baseline，记录失败点和 session ID。
2. 退出并使用 `/resume` 恢复。
3. 完成实现，运行测试和类型检查。
4. 再次恢复，要求 agent 解释改动、测试和剩余风险。
5. 执行 reset，再创建新 session 重复测试。

禁止修改测试来绕过失败，也不要删除状态文件伪造恢复成功。
