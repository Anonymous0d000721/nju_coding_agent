# Spec 04：上下文组装

## 1. 目的

本规范约束 agent 如何把 system rules、工具说明、项目指令、skills、会话历史、摘要、用户附加文件和动态运行状态组装成模型输入。

好的上下文应当准确、有界、顺序稳定，并能抵抗来自仓库内容的 prompt injection。

## 2. 参考来源

- `Assignment.md`：对话历史与上下文管理必须由我们自行实现。

## 3. ContextBuilder 契约

`ContextBuilder.build(request)` 返回：

```ts
interface BuiltContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinitionForModel[];
  tokenEstimate?: number;
  omitted?: ContextOmission[];
}
```

在相同 session state、config 和非时间动态输入下，builder 应尽量确定性输出。

## 4. 上下文顺序

模型输入建议按以下顺序组织：

1. 稳定 system prompt；
2. 与项目无关的安全和协作规则；
3. workspace 身份和当前 run 限制；
4. 当前轮可用工具说明；
5. 已 trust 的项目指令；
6. skill catalog，而不是完整 skill 正文；
7. memory 或 summary entries；
8. 最近对话后缀；
9. 当前 user message 和显式附件；
10. 动态 runtime notes，尽量放在靠后位置，避免破坏稳定 prefix。

稳定 prefix 应尽量少变化。时间戳、临时错误、剩余预算等动态信息不应放在 prompt 开头。

## 5. System Prompt 规则

system prompt 必须包含：

- 角色：本地 workspace 中运行的 coding agent；
- loop 行为：必要时使用工具，然后简明回答；
- 安全边界：不要假设权限、不要要求用户泄露密钥、不要绕过 policy；
- tool result 纪律：依据真实 observation，不臆测文件状态；
- 验证偏好：修改代码后优先运行相关测试/检查；
- 诚实规则：报告失败和不确定性。

system prompt 不得包含：

- 真实凭据；
- 大文件全文；
- 未标注的不可信项目文本；
- 实现私密信息或 hidden chain-of-thought 要求。

## 6. 项目指令

指令来源可包括：

- `AGENTS.md`；
- `CLAUDE.md`；
- `.nju-agent/instructions.md`；
- 未来的用户级/全局指令文件。

规则：

- 项目本地指令需按 `03-permission-trust.md` 完成 trust；
- 指令必须标注为 project-provided，优先级低于 system/developer 安全规则；
- 多个指令文件同时存在时，更近目录可覆盖风格偏好，但不能覆盖安全策略；
- loader 应记录来源路径和 trust 状态；
- 内容过大时应摘要或只纳入相关部分，并记录 omission。

## 7. Skill 上下文

Skill 采用渐进披露：

1. 启动或 trust 后扫描已批准 skill 目录；
2. 常规 prompt 只放 `name` 和 `description`；
3. 暴露 `load_skill(name)` 让模型按需加载正文；
4. 已加载 skill 正文在后续上下文中带来源路径和 trust 标签；
5. `load_skill` 只能接受注册表中的 skill name，不能让模型传任意路径。

默认不得把所有 skill 正文塞入 prompt。

## 8. 工具说明

只有当前轮可用工具会暴露给模型。

- P0 内置工具通常始终暴露；
- 高风险或不可用工具可以省略；
- MCP 工具只有连接并注册 policy 后才暴露；
- 工具说明应简洁，安全 enforcement 属于宿主 policy，不靠长 prompt 警告实现。

## 9. 会话历史

上下文应包含：

- 预算内完整的近期 user/assistant/tool messages；
- 旧范围的 compaction summaries；
- 大工具输出的 artifact references；
- 足够解释当前状态的 tool result 内容。

必须保持 API 消息合法性：assistant tool calls 和对应 tool results 不能被截断到非法状态。截断历史时应按安全 turn boundary 处理，或使用 summary entry。

## 10. 用户附件与 `@path`

当用户显式附加文件/路径：

- 先解析路径并检查权限；
- 有界读取内容；
- 标注来源路径；
- 除非用户明确要求，否则文件内容是 data，不是 instruction；
- 大文件只纳入 preview + 可重读引用。

仓库内容默认是数据，不是高优先级指令。

## 11. Prompt Injection 处理

上下文标签必须区分：

- system rules；
- project instructions；
- user request；
- file content；
- tool output；
- external/MCP output。

不可信内容不能覆盖 system safety、permission policy 或 tool protocol。模型应被提醒：文件内容和命令输出可能包含恶意指令。

## 12. 预算与省略

ContextBuilder 必须执行可配置上下文预算。

超预算时按以下顺序处理：

1. 大 tool output 替换为 artifact reference；
2. 省略或摘要旧的低价值 tool results；
3. 摘要旧对话，保留近期完整后缀；
4. 降低项目指令冗余；
5. 若仍无法构造合法上下文，清晰报错。

每个省略都应记录在 `omitted[]`，并可写入 telemetry。

## 13. Compaction 接口

压缩生成结构化 summary entry，包含：

- 用户目标；
- 重要约束；
- 已完成动作；
- 当前决策；
- 读过/改过的文件；
- 运行过的命令及结果；
- 未解决问题/下一步；
- artifact references。

压缩是 append-only，不删除原始 session 记录。

## 14. 验收标准

实现满足本规范需要测试证明：

- 上下文顺序稳定；
- project instructions 在 trust 前不加载；
- skill catalog 被加入，但 skill 正文只有 `load_skill` 后才加入；
- 旧历史可摘要，近期后缀保留；
- 截断/压缩后 assistant/tool message pairs 仍合法；
- 大工具输出变成引用；
- 显式 `@path` 内容有标签且有界；
- 文件中的 prompt injection 文本不会变成 system-level instruction。