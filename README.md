# nju-agent

一个独立实现的 TypeScript/Node.js 本地编程智能体，目标是让模型真正完成“读代码—执行命令—修改文件—运行测试—继续修复”的闭环，而不是只生成代码片段。

## 特色

- **自研 AgentRunner**：自行实现多轮工具调用、上下文组装、工具结果回填、取消、错误处理和流式事件，不依赖 LangChain、LlamaIndex、Agents SDK 等智能体框架。
- **Hashline 安全编辑**：读取文件时生成行号哈希锚点，编辑前校验文件是否发生变化，拒绝过期锚点和重叠修改，减少误改代码的风险。
- **可恢复工程会话**：使用追加式 JSONL 保存消息，支持 `/resume`、会话命名、分页、分支和中断后继续工作。
- **本地上下文架构**：支持项目指令、技能按需加载、Markdown 长期记忆，以及零模型、零网络的确定性上下文压缩；原始会话不会被删除。
- **本地工具链**：文件读写、PowerShell、Git、后台任务、待办和 MCP stdio 工具均由本地 ToolExecutor 统一校验、执行、超时和脱敏。
- **可集成、可扩展**：提供 JSONL 事件模式和长期运行的 JSON-RPC 模式；支持工作区用户插件、工具重载、权限模式，以及运行中的排队消息和 steer 插话。
- **面向真实任务验证**：`examples/` 包含可 reset、可恢复的订单缺陷修复、库存功能开发和 MCP 插件自托管场景。

## 快速开始

需要 Node.js 22+：

```powershell
npm install
Copy-Item .env.example .env
# 填写 NJU_AGENT_API_KEY、NJU_AGENT_BASE_URL、NJU_AGENT_MODEL
npm run dev
npm run dev -- --print "检查项目并运行测试"
```

`--mode json` 输出 JSONL 事件，`--mode rpc` 启动 JSON-RPC JSONL 服务。凭据只从环境变量或未入库的 `.env` 读取。

## 仓库与检查

公开仓库地址：待发布后补充。

```powershell
npm run typecheck
npm test -- --run
npm run build
```

工具继承当前操作系统用户权限，nju-agent 不是安全沙箱；高风险任务请使用容器、虚拟机或最小权限账户。请勿提交 API 密钥。
