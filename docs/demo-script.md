# 两分钟演示脚本

## 录制前

1. 使用干净工作区，创建本地 `.env`，确认不显示 `.env` 内容和密钥。
2. 运行 `npm install`、`npm run typecheck`、`npm test -- --run` 和 `npm run build`。
3. 使用 `examples/buggy-todo-cli/` 作为实际任务工作区，阅读其 README。先运行基线测试，确认故意保留的缺陷会使测试失败；不要修改测试。
4. 录制结束前清理 `runtime/`、`dist/` 等生成目录，不把凭据加入视频或仓库。

## 时间安排

- **0–10 秒**：展示仓库，说明这是 TypeScript/Node.js 本地编程智能体，核心循环和工具执行由项目自行实现。
- **10–20 秒**：展示 `.env.example`，启动终端界面；只展示变量名，不展示实际密钥。
- **20–55 秒**：让智能体阅读 `examples/buggy-todo-cli/README.md`，先调查并运行基线测试，再修复源码且不改测试。
- **55–75 秒**：展示失败测试、修复后的通过结果，以及 `npm run typecheck`。
- **75–92 秒**：展示 `/name` 或 `/rename`、`/resume`，说明 JSONL 会话恢复；可简短展示 `/compact`、`/memory` 或运行中排队/插话。
- **92–105 秒**：展示 `docs/architecture.md`，说明模型客户端、AgentRunner、工具执行器、会话和本地记录之间的关系。
- **105–120 秒**：展示 `--mode json` 或 `--mode rpc` 的 JSONL 输出，再展示最终测试结果和公开仓库地址。

## 命令备用方案

终端界面不可用时，可使用：

```powershell
npm run dev -- --print "阅读 examples/buggy-todo-cli/README.md，修复其中的实现但不要修改测试，并运行测试"
```

如果模型服务暂时不可用，只能使用已真实运行的录屏片段，并在视频中明确说明；不要伪造实时结果。MCP 示例为可选内容，不应挤占核心修复流程。
