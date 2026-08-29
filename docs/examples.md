# 示例使用指南

## 订单任务修复

目录：`examples/buggy-todo-cli/`

这是一个带持久化的修复任务。故意缺陷包括精确截止时间边界和失败任务金额统计。运行：

```powershell
Set-Location examples\buggy-todo-cli
npm install
npm test -- --run
npm run typecheck
npm run reset
npm run demo
```

baseline 应保留失败测试；修复源码后再运行全部测试。连续执行两次 `demo` 可以观察 JSONL/JSON 状态中的版本变化。

## 库存功能开发

目录：`examples/feature-development/`

实现 `reserveBatch(lines, requestId)`，要求多 SKU 原子提交、失败回滚、requestId 幂等、审计事件和旧 API 兼容。`reserveBatch` 初始故意抛出未实现错误，适合先调查、退出、恢复后继续实现。

```powershell
Set-Location examples\feature-development
npm install
npm test -- --run
npm run reset
```

## 自托管插件

目录：`examples/self-hosting-plugin/`

`nju-mcp-adaptor.mjs` 读取工作区内的 MCP 风格 manifest，并检查版本、工具名、风险字段、只读标记、对象类型 schema 和外部执行字段。专项测试覆盖合法清单、越界路径、网络字段和重复名称：

```powershell
Set-Location examples\self-hosting-plugin
npm install
npm test -- --run
npm run reset
```

集成到主项目时，应在受信任工作区中将插件放入 `.nju-agent/plugins/`，使用 `/reload` 后在下一次运行验证工具；活动运行不会被热替换。
