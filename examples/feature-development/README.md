# Feature Development：库存预留与审计

这是一个可恢复的两阶段功能开发任务，项目自带旧 API、固定 fixture 和故意未实现的新 API。

## Phase 1：理解现有系统

阅读 `src/inventory.ts`、`tests/`、`fixtures/inventory.json` 和脚本，运行：

```powershell
npm test
npm run typecheck
```

旧 API 应通过，新功能测试会失败。先整理状态变化、事务边界、幂等键和审计模型；不要修改测试。

## Phase 2：实现功能

实现 `reserveBatch(lines, requestId)`：

- 多 SKU 必须全有库存才提交，任一失败则整体回滚；
- 同一 `requestId` 重试返回第一次结果，不重复扣库存或写审计；
- 拒绝非正整数、未知 SKU、库存不足，并保持状态不变；
- 每条成功预留写一条 append-only 审计事件；
- 保持 `getStock` 与 `release` 的旧行为；
- revision、audit ID 和返回值必须稳定可序列化。

## 恢复与重复测试

在完成 Phase 1 后退出 agent，用 `/resume` 恢复同一 session 继续实现。完成后运行：

```powershell
npm test
npm run demo
npm run reset
npm run demo
```

`reset` 恢复固定库存和空审计日志；可反复创建新 session 测试。恢复旧 session 时要求 agent 说明已完成的调查，避免从头重复。

验收：完整测试和 typecheck 通过；能解释幂等、事务回滚和审计事件设计。
