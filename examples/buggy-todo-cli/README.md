# Bug Fix：订单任务服务

这是一个可恢复的多阶段 bug 修复任务。项目故意包含多个相互关联的实现缺陷；测试不可修改。

## 功能范围

服务从 JSON 文件加载订单任务，支持状态过滤、截止时间查询、分页、金额/逾期统计、版本冲突检测，以及临时文件 + rename 原子写回。

## 阶段任务

### Phase 1：调查

阅读 `src/order-service.ts`、`tests/`、`fixtures/orders.json` 和脚本。运行：

```powershell
npm test
npm run typecheck
```

记录每个失败测试对应的数据边界；不要修改源码和测试。

### Phase 2：修复

修复实现中的所有问题，重点检查：过滤后分页、截止时间是否包含边界、哪些状态属于 actionable、金额统计、版本递增、完成任务不可重开，以及 Windows 路径下的原子写回。只能改 `src/` 和必要文档。

### Phase 3：恢复与回归

在 Phase 1 后退出 agent，再用 `/resume` 恢复同一 session，要求继续 Phase 2。完成后运行完整测试。然后执行：

```powershell
npm run reset
npm run demo
npm run demo
```

两次 demo 都应能正常运行；第二次会基于已更新的持久化状态继续测试。需要新一轮时再次 `npm run reset`。运行 `npm run reset` 后，fixture 始终恢复到同一个版本 7 的起点。

验收：测试全部通过；能说明每个 bug 的根因、修复和回归覆盖；恢复 session 后不会重复调查。
