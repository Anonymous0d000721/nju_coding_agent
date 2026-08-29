# NJU Coding Agent 实现总计划

> **本文件是后续 session 的唯一实施路线图。** 当前 session 仅完成调研与规划，不在项目中实现 agent。
>
> 最后更新：2026-08-27

---

## 0. 项目定位与边界

### 0.1 最终目标

实现一个以 **TypeScript / Node.js + OpenAI-compatible API** 为基础的本地终端编程智能体。它应当在交互体验和扩展思路上接近 `pi-coding-agent`：

- 在终端中接受多轮自然语言任务；
- 让模型自主读写项目文件、搜索内容、执行命令、根据结果继续工作；
- 保存可恢复、可分叉的会话；
- 支持项目指令、Skills、Hooks、MCP 外部工具；
- 具备清晰的权限策略、上下文压缩、任务规划与可观测性；
- 可用一个稳定的真实编程任务进行视频演示，并能在面试中解释每项设计。

### 0.2 题目合规红线

必须由本项目自行实现以下核心部分：

1. `messages[]` 对话历史与上下文构造、会话持久化、压缩策略；
2. 工具 JSON Schema 定义、参数校验、注册、分派、本地执行与结果写回；
3. OpenAI-compatible 响应和 `tool_calls` 的解析；
4. agent loop、重试、取消、预算和终止条件；
5. 失败、超时、权限拒绝与模型 API 错误的处理。

不得使用或包装：

- `pi-coding-agent`、Claude Code、Codex、OpenCode 等现成 agent 产品；
- LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 agent 框架/SDK；
- CodeInterpreter、Files API 等由服务端托管的代码执行/文件工具。

允许使用：Node 标准库、`openai` API 客户端（或等价 HTTP 客户端）、OpenAI-compatible 网关、原生 tool calling、纯终端 UI/解析/Schema 等通用库。每一个依赖都需在 README/答辩中能说明其**不是 agent 框架**。

> **关键判断**：可以借鉴 Pi 的产品结构与交互，但绝不可依赖 Pi 的包、SDK、扩展机制或源码实现作为运行时核心。我们实现自己的最小同构机制。

### 0.3 推荐范围：Pi-like，而非 Pi clone

“类似 Pi”是可行的；“在作业中完整复刻 Pi”不现实且没有必要。参考 Pi 源码本身就包含完整 TUI、20+ provider、复杂会话树、资源加载、插件、包管理、RPC、图像、遥测等多个大型子系统。

建议采用 **核心完整、外层渐进** 的策略：

| 层级 | 目标 | 是否作为作业核心 |
|---|---|---|
| Core | 自建 loop、工具、会话、安全、错误处理、CLI | **必须完成** |
| Power | Skills、Hooks、上下文压缩、计划、MCP、会话分叉、测试/遥测 | **重点完成** |
| Advanced | 子 agent、后台任务、工作流、worktree、目标闸门 | 有充分时间后加入 |
| Polish | 全屏 TUI、主题、包管理、远程会话、复杂 provider 生态 | 可选，不阻塞交付 |

核心能力必须真实可靠；每项进阶能力必须能独立演示、测试和解释。宁可不实现一个半成品多智能体系统，也不要削弱工具执行和安全边界。

---

## 1. 参考资料调研结论

### 1.1 已浏览的参考资料范围

`refs/` 是大型资料库，包含约：

- `pi/`：1,410 个文件、约 17.5 MiB；Pi 的 coding-agent、agent runtime、TUI 与文档；
- `learn-claude-code/`：416 个文件、约 4.3 MiB；17 个从 agent loop 到 goal loop 的渐进式实现课程；
- `hello-agents/`：1,856 个文件、约 176.9 MiB；大量教程、示例和协作项目；
- `sjtu-agent/`：338 个文件、约 8.5 MiB；完整 agent 工程的架构与实践；
- `pi-minimal-doc/`：新增的 Pi v0.80.10 源码研读报告，按“最小 Agent → CLI/TUI → input-to-LLM → 架构 → 模型运行时 → 信任/认证 → 压缩/分支”组织，是本项目拆解 Pi-like 架构的高信号资料；
- `Agent-make-post.md`：从 Loop、ReAct、Memory、Plan 延伸至 Skills/MCP、多 agent、压缩与安全的中文整理。

已重点阅读或扫描了下列与本作业直接相关的资料：

- `refs/Agent-make-post.md` 的完整目录和核心章节；
- `refs/pi/README.md`、`refs/pi/packages/coding-agent/README.md`；
- `refs/pi/packages/coding-agent/docs/extensions.md`、`skills.md`、`compaction.md`；
- `refs/pi/packages/agent/docs/harness.md` 的会话/持久化/恢复设计；
- `refs/pi-minimal-doc/source/*.md`：重点阅读 `minimal-agent.md`、`input-to-llm.md`、`architecture.md`、`models-runtime.md`、`trust-and-auth.md`、`compaction-and-branches.md`，并浏览 `cli-to-tui.md`、`setup-and-debug.md`、`prerequisites.md`；
- `refs/learn-claude-code/README-zh.md`，以及 s01、s03、s07、s08、s14、s15、s16、s17；
- `refs/sjtu-agent/docs/AGENT_ARCHITECTURE.md`。

后续实施时应按功能点定向回读相应资料和参考源码，而非复制其实现。

### 1.2 可迁移的关键原则

1. **Agent = Model + Harness**：模型决定下一步；宿主提供工具、观察、上下文、权限和持久化。不要用固定规则树代替模型决策。
2. **主循环保持小**：每轮只做“组装上下文 → 请求模型 → 解析回应 → 执行一批工具 → 写回结果 → 决定是否继续”。新能力通过 registries、hooks 和 services 接入。
3. **工具是最重要的产品接口**：原子、可组合、有 schema、有清晰错误、输出有限且可重新读取。
4. **确定性边界优先于提示词约束**：路径越界、敏感文件、危险命令、超时、输出截断由程序阻止，不能只要求模型“不要做”。
5. **渐进披露**：system prompt 只放稳定的核心规则、工具说明和 skill catalog；完整 Skill/MCP 工具按需加载或动态加入。
6. **上下文首先追求质量，不只是节省 token**：稳定前缀、旧大输出落盘并替换为引用、保留近期工作、必要时摘要；防止 context rot。
7. **验证是自动化上限**：编译、测试、lint、git diff 和明确验收条件应进入 loop；模型“不再调用工具”不是“任务完成”的证据。
8. **持久化状态要显式**：至少持久化消息、会话元数据、活动计划、工具日志与摘要；不要只依赖内存。
9. **扩展优先组合而非侵入**：注册工具、hook 生命周期、resource loader、workflow registry 都比在 loop 中堆 if/else 更可维护。
10. **Runtime 工厂很重要**：Pi 在 `/new`、`/resume`、`/fork` 时复用同一个 runtime factory 重新装配服务。我们也应把 `createRuntime()` 作为会话切换和测试注入的统一入口，而不是在 CLI 主流程里散落 new 服务。
11. **模型运行时要和 loop 分离**：Agent loop 只依赖 `streamFn` / `ModelClient`，不直接知道 API key、base URL、模型目录或认证优先级；这些由轻量 `ModelRuntime` 处理。
12. **先单 agent，再并发**：Subagent、后台任务和 worktree 只有在单 agent 可靠、权限边界稳定、测试充分后才值得加入。

---

## 2. 总体架构

### 2.1 模块图

```text
┌──────────────────────────── User / Terminal ────────────────────────────┐
│ CLI input, slash commands, queued follow-up, approval prompt, renderer │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
┌──────────────────────────────────▼──────────────────────────────────────┐
│ App / SessionController                                                 │
│  command routing · session open/save · config · cancellation · display │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ user prompt / events
┌──────────────────────────────────▼──────────────────────────────────────┐
│ AgentRunner (the only agent loop owner)                                 │
│ pre-run hooks → context builder → LLM → parser → tool batch → results  │
│ retry / stop / compaction / goal check / event emission                 │
└───────┬──────────────────┬─────────────────────┬────────────────────────┘
        │                  │                     │
┌───────▼────────┐ ┌───────▼────────┐  ┌────────▼────────────────────────┐
│ ModelClient    │ │ ToolRuntime     │  │ Context & Resource Services      │
│ OpenAI adapter │ │ registry/schema │  │ system prompt / AGENTS / Skills  │
│ stream/retry   │ │ policy/handlers │  │ summaries / memory / token budget│
└────────────────┘ └───────┬────────┘  └──────────────────────────────────┘
                            │
            ┌───────────────▼────────────────┐
            │ Local tools / MCP adapters      │
            │ fs · search · edit · shell · git│
            └───────────────┬────────────────┘
                            │
                    ┌───────▼────────┐
                    │ Persistence     │
                    │ JSONL + files   │
                    │ sessions/logs   │
                    └─────────────────┘
```

### 2.2 Pi-minimal-doc 带来的结构修正

新增 `pi-minimal-doc/` 让实现路线更清楚：不要直接从 TUI 或 MCP 开始，而应先复刻 Pi 的关键边界。

| Pi 边界 | 本项目对应实现 | 说明 |
|---|---|---|
| `cli.ts → main() → mode` | `src/index.ts → createApp() → interactive/print` | CLI 入口只解析参数和装配服务，不混入 agent loop。 |
| `AgentSession.prompt()` | `SessionController.prompt()` | 负责 slash command、input hook、skill/template 展开、队列、压缩检查、模型/认证准备。 |
| `runAgentLoop()` | `AgentRunner.run()` | 只处理“LLM → tool calls → tool results → repeat”，不直接管 API key、TUI 或配置文件。 |
| `streamFn / ModelRuntime` | `ModelClient / ModelRuntime` | loop 通过接口调用模型；认证、base URL、模型选择在 runtime 层完成。 |
| `executeToolCalls()` | `ToolExecutor.executeBatch()` | 查 registry、schema 校验、permission、handler、事件和 tool result 配对。 |
| `ProjectTrust` | `TrustManager` | 项目本地 instructions/skills/MCP 配置加载前先确认信任。 |
| `JSONL Session + compaction entry` | `SessionStore + SummaryEntry` | 历史 append-only；压缩生成新摘要条目，不修改原历史。 |
| `TUI differential renderer` | 后置的 `Renderer` / 简易 TUI | 第一阶段先行式 CLI；若核心稳定，再做 raw mode、状态栏、可折叠工具输出。 |

这意味着第一版代码应优先建立四个“窄腰”：`ModelClient`、`AgentRunner`、`ToolRegistry`、`SessionStore`。只要这四个接口稳定，后续 TUI、Skills、MCP、Subagent 都是挂载能力，而不是重写核心。

### 2.3 关键数据流：一次普通任务

```text
1. 用户输入任务
2. CommandRouter 判断普通 prompt / slash command
3. SessionStore 追加 user message（先落盘）
4. AgentRunner 创建 run，触发 beforeRun hooks
5. ContextBuilder 组装：稳定 system prompt + 项目 instructions + catalog + summary + 近期消息
6. ModelClient 调用 OpenAI-compatible chat/completions（可流式）
7. 响应落盘为 assistant message；解析 text 和 tool_calls
8. 没有 tool_call：交给 StopController / GoalGate 判断是否真的结束
9. 有 tool_call：逐个执行
   a. JSON 参数与 schema 校验
   b. PermissionEngine 决定 allow / ask / deny
   c. ToolRegistry 分发 handler，处理 timeout、abort、异常和输出截断
   d. 追加每个 tool result 并落盘
10. 触发 postTool hooks，必要时压缩/归档；回到步骤 5
11. 正常结束、用户取消、预算耗尽或不可恢复错误时记录 RunResult
```

### 2.3 必须保持的核心不变量

- 每一个 assistant tool call 都必须产生一个同 ID 的 tool result（成功、拒绝、取消或失败都一样），避免 API 消息序列非法。
- 所有写入类工具先经过路径解析和权限策略；模型提供的路径永远不直接信任。
- 所有 shell 执行都有工作目录、超时、取消信号、输出上限与退出码。
- 工具失败是返回给模型的结构化 observation，不是让进程崩溃。
- Agent loop 不设置固定轮数或工具调用数量上限；取消、最大持续时间和可选 token/cost 预算由运行时负责。
- 每个 session 的历史是 append-only；摘要是新条目，不修改旧对话。
- 动态数据（时间、临时状态）不破坏稳定 system prefix；避免缓存失效。
- 未经用户确认的高风险操作不执行；后台/子 agent 不得争抢前台审批输入。
- 凭据只从环境变量加载，日志、session、工具输出与 UI 均需做敏感值脱敏。

---

## 3. 技术选型

### 3.1 已确认选择

| 项目 | 选择 | 原因 |
|---|---|---|
| 语言 | TypeScript（Node.js） | 与目标 Pi-like CLI 的生态相符；类型可约束消息、工具和事件协议。 |
| 模型接口 | OpenAI-compatible API | 已有环境变量；原生 `tool_calls` 能直接满足作业工具循环。 |
| 主入口 | Node CLI | 最适合作业演示、权限审批、文件/命令执行和面试讲解。 |
| 持久化起点 | JSONL session + JSON 配置/状态文件 | 人可读、易检查、可追加、无需数据库；后续可抽象 storage interface。 |
| 包管理 | npm | 常规、可解释；锁定依赖版本并保存 lockfile。 |
| 测试 | Vitest | TypeScript 友好；可 mock ModelClient 和 filesystem/process 边界。 |

### 3.2 建议依赖纪律

优先 Node 内置模块：`fs/promises`、`path`、`child_process` / `spawn`、`readline`、`crypto`、`events`、`os`。

可以引入的少量通用库（最终按必要性决定）：

- `openai`：仅 API transport 与类型；或直接使用 `fetch` 自己实现一个薄适配器；
- `zod` 或 `typebox`：工具参数和 config 的运行时 schema；
- `yaml`：读取 YAML frontmatter / 配置；
- `fast-glob`：高质量文件匹配（也可先自行递归实现）；
- `diff`：用于安全、可读的 replace/diff；
- `chalk`、`cli-spinner`/`ora`：CLI 呈现（可选）；
- `@modelcontextprotocol/sdk`：**仅在 MCP 阶段**作为协议客户端，不是 agent 框架。

不要引入：任何带 agent executor/chain/graph/assistant runtime 的包，也不要为了“看起来像 Pi”引入 Pi 自身的 packages。

### 3.3 建议目录结构

```text
nju-coding-agent/
├─ src/
│  ├─ index.ts                    # CLI 入口
│  ├─ app/
│  │  ├─ app.ts                   # 装配依赖
│  │  ├─ command-router.ts        # /commands 与普通输入
│  │  └─ renderer.ts              # 初期的行式终端渲染
│  ├─ agent/
│  │  ├─ runner.ts                # agent loop
│  │  ├─ types.ts                 # Message、Run、Event、Result
│  │  ├─ stop-controller.ts       # loop 的停止与预算
│  │  ├─ goal-gate.ts             # 可选：目标完成闸门
│  │  └─ hooks.ts                 # 生命周期 hook registry
│  ├─ model/
│  │  ├─ model-client.ts          # 厂商无关接口
│  │  ├─ openai-compatible.ts     # Chat Completions adapter
│  │  └─ retry.ts
│  ├─ tools/
│  │  ├─ registry.ts
│  │  ├─ schema.ts
│  │  ├─ executor.ts
│  │  ├─ policy.ts
│  │  ├─ path-guard.ts
│  │  ├─ file-tools.ts
│  │  ├─ search-tools.ts
│  │  ├─ shell-tool.ts
│  │  ├─ git-tools.ts
│  │  └─ mcp/                    # 后续阶段
│  ├─ context/
│  │  ├─ system-prompt.ts
│  │  ├─ instructions.ts          # AGENTS.md / PROJECT.md
│  │  ├─ skills.ts
│  │  ├─ compactor.ts
│  │  ├─ transcript-store.ts
│  │  └─ memory.ts                # 后续阶段
│  ├─ session/
│  │  ├─ session-store.ts
│  │  ├─ jsonl-store.ts
│  │  ├─ session-types.ts
│  │  └─ branch.ts                # 后续阶段
│  ├─ planning/
│  │  ├─ todo-store.ts
│  │  └─ plan-mode.ts
│  ├─ workflows/                  # 后续阶段：可信固定工作流
│  └─ shared/
│     ├─ errors.ts
│     ├─ config.ts
│     ├─ logger.ts
│     └─ redact.ts
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ e2e/
├─ skills/                        # 本项目内置可审计 Skills
├─ examples/                      # 演示任务与录制脚本
├─ docs/                          # 架构、威胁模型、设计决策、演示指南
├─ .env.example
├─ .gitignore
├─ package.json
├─ tsconfig.json
└─ README.md
```

不要在第一天把所有目录都创建为空壳；按阶段建立并保持每次提交可运行。

---

## 4. 功能分层与验收标准

### P0：可交付的独立 coding agent（必须）

| 功能 | 具体要求 | 验收方式 |
|---|---|---|
| CLI 输入与输出 | 交互模式；可执行单条 prompt；显示助手文本、工具调用、错误和状态 | 手工会话 + snapshot test |
| OpenAI-compatible 接入 | `.env` 中读取 base URL、key、model；支持 text 与 tool calls | mock 响应 + 真实连通性 smoke test |
| Agent loop | 连续工具轮；无 tool calls 时结束；可 Ctrl+C 取消 | 固定模型 stub 的单元测试 |
| 文件工具 | `list_files`、`read_file`、`write_file`、`edit_file` | 临时工作区 integration test |
| 检索工具 | `glob_files`、`grep_files`，限制输出 | fixture repo test |
| 命令工具 | `run_command`，cwd/timeout/output/exit code/cancel 都正确 | 运行成功、失败、超时命令 |
| 安全 | workspace 路径保护、敏感文件保护、危险 shell 审批/拒绝 | policy tests |
| 错误处理 | schema 错误、未知工具、工具异常、API 错误都以结构化结果回传 | unit + integration tests |
| 会话持久化 | 新建/恢复 JSONL session；消息和工具结果可检查 | 重启进程后继续 |
| 基础上下文控制 | 工具输出截断/归档、最大轮数和 token/消息预算 | 大输出与超限测试 |
| 项目说明 | README 能独立运行；配置无密钥 | fresh checkout 验证 |

### P1：体现 Pi-like 设计的重点功能（强烈建议）

| 功能 | 设计方向 | 价值 |
|---|---|---|
| Slash commands | `/help`、`/new`、`/resume`、`/session`、`/model`、`/compact`、`/quit` | 接近真实终端 agent 的操作体验 |
| 项目 instructions | 读取 cwd 与祖先目录中的 `AGENTS.md` / `CLAUDE.md`，明确可信边界 | 让 agent 遵守项目约定 |
| Skills | 扫描 `skills/*/SKILL.md` frontmatter，prompt 放 catalog，`load_skill` 按需读取完整内容 | 低成本专业知识和渐进披露 |
| Hooks | `beforeRun`、`beforeTool`、`afterTool`、`beforeModel`、`onStop` | 权限、日志、注入、审计可组合 |
| 多级压缩 | 大输出落盘 → 替换旧结果为引用 → 历史摘要；保留近期消息与当前任务 | 长任务可靠性、答辩亮点 |
| Todo/Plan | `todo_write` 持久化任务项；复杂任务先拆解再行动 | 减少长任务漂移 |
| 用量与日志 | 每轮 token、成本（若 API 返回）、耗时、工具统计、脱敏日志 | 可观测、易调试 |
| 安全 diff | edit/write 前展示 diff，默认对覆盖/删除操作确认 | 演示安全性与可解释性 |
| Git 辅助 | `git_status`、`git_diff`、`git_log` 只读工具 | coding agent 高价值观察能力 |

### P2：时间充裕时实现的高级能力（按依赖顺序）

| 功能 | 前置条件 | 推荐实现边界 |
|---|---|---|
| MCP client | 工具 registry、schema、policy 已稳定 | 支持 stdio JSON-RPC server 的 connect/list/call；名称规范化为 `mcp__server__tool`；宿主策略默认审批未知外部工具。 |
| Session tree/fork | JSONL store 已稳定 | 记录 `id`/`parentId`；先实现 `/fork`，后实现交互树浏览；不必复制 Pi 的多 lane runtime。 |
| Persistent memory | 压缩、Skills 已完成 | 只保存明确可复用的用户偏好/项目事实；检索后注入；避免“每轮全量记忆”。 |
| Subagent | prompt/session/工具隔离稳定 | 将它实现成 `spawn_subagent` 工具：独立消息历史、受限工具、最终摘要回主 agent；初期不允许递归 spawn。 |
| Background commands | abort/process 管理稳定 | 仅显式选择的长命令后台运行；完成通知作为新事件进入会话。 |
| Trusted workflows | subagent/validation 已稳定 | 仅允许 host 注册的工作流名，模型只能传参数；journal 支持 resume；不允许模型提交任意可执行脚本。 |
| Goal gate | 工具验证和 session log 已稳定 | 模型想结束时以明确的测试/lint/diff 证据检查目标；先用确定性规则，必要时再加独立 evaluator。 |
| Worktree isolation | Git/workflow/subagent 都稳定 | 子任务独立 worktree；明确这是隔离 working copy，不是安全 sandbox。 |
| Rich TUI | 核心 CLI 充分稳定 | 最后再做；先行式 renderer，再选择 `@earendil-works/pi-tui` 以外的普通 TUI 库或自建轻量组件。 |

### 明确后置或不做

- 多 provider、OAuth、订阅登录、远程服务、包市场、主题系统；
- 多 agent 团队自治、cron、常驻机器人；
- 真正安全的 OS sandbox / container runtime（可写文档说明其必要性，但不要假称已实现）；
- 自建 IDE、Web UI、浏览器自动化。

这些不能比核心功能更早做；否则会把项目从“可解释的 coding agent”变成“未完成的平台”。

---

## 5. 分阶段实施路线

> 每一个 Phase 都要求：代码可运行、自动测试可运行、README/设计文档同步、一次或多次自然 Git commit。只有验证通过才进入下一阶段。

### Phase A：工程地基与合规（预计 0.5–1 天）

**目标**：创建一个可复现、无凭据、可提交的 TypeScript CLI 工程。

1. 在 GitHub/Gitee 新建题目发布后创建的公开仓库；保留完整提交历史，不 force push、不重写已推送历史。
2. 初始化 TypeScript、Node 版本约束、eslint/format（如需要）、Vitest。
3. 写 `.gitignore`：`.env`、session/log/cache/output、`node_modules`、临时演示目录等。
4. 写 `.env.example`，只给变量名：
   - `NJU_AGENT_API_KEY`
   - `NJU_AGENT_BASE_URL`
   - `NJU_AGENT_MODEL`
5. 设计 `AgentConfig`，从环境变量 + 可选未入库配置读取。
6. 建立 error hierarchy、logger、redaction util、基本 CLI 参数解析。
7. 增加 CI（至少 typecheck + test），并做初始 commit。

**验收**：`npm run typecheck`、`npm test`、`npm run dev -- --help` 成功；`git grep` 不含真实 key；全新 clone 可依 README 完成配置。

**建议 commits**：
- `chore: initialize TypeScript CLI project`
- `chore: add safe environment configuration`

### Phase B：最小闭环（预计 1–2 天）

**目标**：在不接真实文件工具之前，用 mock 模型完成完整 loop 的可测试实现。

1. 定义内部统一消息模型（user / assistant / tool）和 `ToolCall`、`ToolResult` 类型。
2. 定义 `ModelClient` 接口：`complete(request, signal) -> AssistantTurn`。
3. 实现 `OpenAICompatibleClient`，将内部 messages/tools 转为 API 格式，解析 text、usage 和 tool calls。
4. 用 fake client 写 loop tests：
   - 纯文本回复结束；
   - 一轮 tool call 后再回复；
   - 多个 tool calls；
   - 未知工具、非法参数与 handler exception；
   - max turns；
   - AbortSignal。
5. 实现 `ToolRegistry`：注册 definition、handler、风险元数据；按 schema 验证并返回统一结果。
6. 建立行式 renderer，能清晰展示每一轮和工具状态。

**验收**：所有 loop 分支由固定 fake model 覆盖；真实 API smoke prompt 能得到普通文本回复；此时尚不需要能修改文件。

**建议 commits**：
- `feat: add model abstraction and agent loop`
- `test: cover tool calling loop transitions`

### Phase C：本地 coding 工具与权限系统（预计 2–3 天）

**目标**：完成真实 coding agent 的基本行动能力，并把安全写进程序而不是 prompt。

1. 实现 `WorkspaceGuard`：用 canonical / resolved path 判断边界，处理相对路径、`..`、symlink；将 workspace root 写进 tool context。
2. 实现工具（每个都有 description、JSON Schema、handler、测试）：
   - `list_files(path?, depth?, includeHidden?)`；
   - `read_file(path, offset?, limit?)`；
   - `write_file(path, content, createDirectories?)`；
   - `edit_file(path, oldText, newText)`，要求唯一匹配；
   - `glob_files(pattern, path?)`；
   - `grep_files(pattern, path?, glob?)`；
   - `run_command(command, cwd?, timeoutMs?)`。
3. 统一工具结果格式：`ok`、摘要、结构化 `details`、`isError`、`truncated`、`elapsedMs`。
4. 对 read/shell/search 输出做字节/行数截断；完整大输出写到 agent 的内部 output 目录并回传引用路径。
5. 实现 `PermissionEngine`：
   - `deny`：绝对禁止（例如系统关机、格式化磁盘、工作区外敏感文件写入）；
   - `ask`：覆盖写、删除、git reset、包安装、危险命令、工作区外访问；
   - `allow`：受限工作区中的正常读取和安全操作；
   - `deny-on-noninteractive`：没有前台 UI 时不能默认放行 ask 操作。
6. 使用 `spawn`（非 `exec`）执行命令，保证 timeout、kill、输出上限与取消可控；Windows 以 PowerShell / `cmd.exe` 的明确策略执行。
7. 至少实现保护文件模式：`.env`、`.git/`（谨慎）、agent session storage、`node_modules/` 等写入需额外确认或拒绝。

**验收**：在 fixture workspace 内，agent 能创建项目、读回文件、修改文件、运行测试并基于失败继续；所有越界/危险路径在测试中明确拒绝。

**建议 commits**：
- `feat: add guarded filesystem tools`
- `feat: add command execution and permission policy`
- `test: cover workspace boundaries and command failures`

### Phase D：可用 CLI 与会话（预计 1–2 天）

**目标**：从“单次脚本”变成可持续使用的本地 agent。

1. 设计 JSONL session 格式：header、message、tool event、summary、metadata；每条记录具有 id、parentId、timestamp、schema version。
2. 每次 user/assistant/tool result 结束后 append，不能只在正常退出时保存。
3. 实现：
   - `/new`、`/resume [id]`、`/sessions`、`/session`、`/name`；
   - `/model`（修改当前 session config）；
   - `/quit`、Ctrl+C（本轮 abort；连续 Ctrl+C 才退出）；
   - `--print` 单任务模式、`--no-session` 临时模式；
   - `@path` 作为用户明确附加的文件上下文（初期仅文本）。
4. 确保恢复时从 JSONL 还原可发送的消息序列；处理末行损坏或不完整写入。
5. 为 session 加 usage 统计、错误摘要和当前 workspace/model 信息。

**验收**：中断/退出后可恢复同一会话并继续；session JSONL 人工可读；一个损坏尾行不会让整个 session 无法打开。

**建议 commits**：
- `feat: persist and resume chat sessions`
- `feat: add interactive slash commands`

### Phase E：Context、项目指令、Skills 与 Hooks（预计 2–4 天）

**目标**：完成最有价值的 Pi-like harness 能力。

1. `SystemPromptBuilder` 分层构造：
   - 静态安全与协作规则；
   - 当前 workspace；
   - 内置工具的稳定描述；
   - 项目 instructions 摘要/内容；
   - Skill catalog；
   - 动态状态放末尾或 user-side context。
2. `InstructionLoader`：从 cwd 向上读取 `AGENTS.md` / `CLAUDE.md`（支持 override 规则）；项目本地资源仅在用户确认信任后加载。
3. `SkillLoader`：扫描 `.agents/skills/**/SKILL.md`、`.nju-agent/skills/**/SKILL.md` 及用户级 skills；只将 name/description 放入 catalog；`load_skill(name)` 从注册表读取，而非将模型输入拼为路径。
4. `HookRegistry`：定义并测试 `beforeRun`、`beforeModelRequest`、`beforeTool`、`afterTool`、`afterTurn`、`onStop`。权限只是 `beforeTool` 的一个 hook/strategy，但核心 path guard 仍不可被 hook 绕过。
5. `ContextCompactor` 分四层：
   - 大 tool result 先落盘，保留 preview + path；
   - 旧工具结果替换成恢复引用；
   - 超预算时存完整 transcript、保留近期完整回合；
   - 最后调用模型生成结构化摘要（Goal、约束、完成项、决定、下一步、关键文件/命令）。
6. API 返回 context-too-long 时只允许一次 reactive compact + retry；之后报错，防止无限循环。
7. 稳定 prefix 和 append-only history，记录 token/字符估计及 compaction 事件。

**验收**：长输出不会淹没会话；压缩后 agent 能依据摘要继续；skill 不会全量塞进 prompt；hook 能记录并阻止工具调用。

**建议 commits**：
- `feat: load project instructions and skills on demand`
- `feat: add lifecycle hooks and context compaction`

### Phase F：计划、验证与可观测（预计 1–2 天）

**目标**：让复杂编码任务更少漂移，且对“完成”有真实证据。

1. 实现 `todo_write` / `todo_list`：任务项结构化持久化，支持 pending/in_progress/completed/blocked；Agent 修改完整清单前做 schema 和状态迁移校验。
2. 引入轻量 Plan Mode：复杂任务（或用户 `/plan`）先产出计划，再请求用户批准/进入实施；简单任务不强制。
3. 自动收集 coding evidence：修改过的文件、最近命令及 exit code、git diff、测试/lint 结果。
4. 设定运行时安全边界：取消信号、max wall time、max failures per tool、最大输出和可选 token/cost budget；不设置固定 turn 或 tool-call 数量上限。
5. 实现停止原因：`completed`、`model_finished`、`user_cancelled`、`budget_exhausted`、`fatal_error`。
6. 可选 `GoalGate`：对于明确目标（如 `npm test` exit 0），模型停止后根据最近可验证 evidence 判断是否缺少验证；缺失时反馈给主 loop 继续。第一版尽可能以**确定性验证命令**为依据，避免完全依赖第二个 LLM evaluator。
7. 生成脱敏 JSONL telemetry / run report。

**验收**：演示任务中，agent 能先维护清单、修改、运行测试；若没有测试证据，不能轻率把任务标为已完成；报告能展示实际工具轨迹。

### Phase G：MCP 与受控扩展（预计 2–4 天）

**目标**：实现外部工具发现和调用，但不把 MCP 当成安全边界。

1. 配置格式只允许用户配置的 stdio MCP server；启动命令和 env 必须脱敏。
2. 实现 `McpManager.connect(serverName)` → initialize → `tools/list` → 缓存工具 schema。
3. 动态将工具加入 ToolRegistry，统一命名 `mcp__<safeServer>__<safeTool>`，检测规范化碰撞和名称长度。
4. MCP call 的参数仍经 JSON Schema、host policy、timeout、错误转换和日志。
5. 宿主维护独立策略；server description/annotation 不能决定“安全”。未知 MCP tool 默认 `ask`，后台/非交互运行默认拒绝。
6. 断开、重连、server error 都变成普通工具错误返回模型。
7. 附带一个**本地 mock / demo MCP server**，保证视频和测试无需第三方服务即可演示动态工具发现。

**验收**：连接 demo MCP 后，下一次模型调用能看见新工具；同名工具不碰撞；高风险 MCP 工具不会因 server 自称 read-only 而绕过 policy。

### Phase H：高级并发与任务隔离（可选，预计 4–7 天）

**目标**：在保持系统可解释的前提下增加高阶能力。

按此顺序实现，每完成一项就评审是否值得继续：

1. `spawn_subagent`：独立 conversation、只允许受限工具集、最终摘要作为 tool result 回主 agent；不递归。
2. Background command：显式 `background=true` 才允许；完成/失败通知排队送回 session。
3. 固定 Workflow：host 注册 `review-changes`、`implement-with-tests` 等可信工作流；模型不能执行任意脚本；每个子调用返回受 schema 约束的结果；journal 支持 resume。
4. Worktree：将某个 workflow/subagent 绑定到 Git worktree，工作目录隔离；不宣传为安全沙箱。
5. Session fork/tree：利用 append-only JSONL 中的 parent links，实现从某个 user message 分叉和恢复。

**验收**：并发不会争用前台输入；子 agent 输出不会无界污染主 context；worktree 的创建失败能清理/报告；workflow 中断可恢复且不会重复已记录结果。

### Phase I：体验、文档、评估与最终演示（预计 2–3 天）

1. 评估是否值得把行式 CLI 升级为简易 TUI：流式文本、可折叠 tool output、状态栏、`@` 文件补全。只有不影响核心稳定性时才做。
2. 写 `docs/architecture.md`：模块、消息格式、工具调用顺序、持久化、压缩、权限边界。
3. 写 `docs/decisions.md`：为什么 TypeScript、JSONL、原生 tool calling、为何不用 agent framework、为何 MCP 后置等。
4. 写 `docs/threat-model.md`：真实权限、限制、非目标（特别是“不是 sandbox”）。
5. 构建 benchmark/demo fixture：一次端到端任务应同时包含阅读、修改、测试失败、调试修复和最终验证。
6. 录制前做 clean-room 演练至少三次；记录耗时、API 稳定性和失败备选方案。
7. 写 README（最终 ≤1000 汉字）并录制 2 分钟视频。

---

## 6. 关键接口草案

这些是实现时应保持清晰的边界，不代表需要第一天一次性写完。

```ts
// model/model-client.ts
export interface ModelClient {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<AssistantTurn>;
}

// tools/registry.ts
export interface AgentTool<TInput = unknown, TDetails = unknown> {
  definition: ToolDefinition;       // name, description, JSON schema, risk metadata
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TDetails>>;
}

// agent/runner.ts
export interface AgentRunner {
  run(session: AgentSession, initialEvent: UserEvent, signal?: AbortSignal): AsyncIterable<AgentEvent>;
}

// tools/policy.ts
export interface PermissionEngine {
  decide(call: PreparedToolCall, ctx: ToolContext): Promise<PermissionDecision>;
}

// session/session-store.ts
export interface SessionStore {
  create(config: SessionConfig): Promise<AgentSession>;
  open(idOrPath: string): Promise<AgentSession>;
  append(sessionId: string, entry: SessionEntry): Promise<void>;
  list(workspace?: string): Promise<SessionSummary[]>;
}
```

建议内部消息在一开始就自定义为 provider-neutral shape，再由 `OpenAICompatibleClient` 映射到 OpenAI chat format。这样将来若要支持别的厂商，只需新增 adapter，不需要重写 session/tool/loop。

---

## 7. 安全设计与答辩口径

### 7.1 威胁模型

模型输出、项目文件、Skill 内容、MCP server 描述和 tool output 都是**不可信输入**。其中可能包含 prompt injection，诱导 agent 泄露环境变量、越界写文件或执行危险命令。

### 7.2 防线

1. **数据层**：API key 只在环境变量；redact 常见 key pattern；`.env` 和 session/logs 均被 gitignore；禁止工具读取/回显敏感路径或变量（策略可配置）。
2. **文件层**：canonical path 必须位于 workspace；写/编辑前做保护路径检查；symlink 需要真实路径再判断。
3. **命令层**：显式 cwd、timeout、进程取消、输出截断；硬拒绝极高风险命令；风险命令要求前台审批。
4. **扩展层**：project-local Skill/MCP/config 首次加载前要求 trust；MCP annotations 不可作为授权依据；未知外部工具默认 ask。
5. **运行层**：最大轮数/工具次数/失败次数/预算；用户可 cancel；后台执行无交互审批能力时直接拒绝 ask 操作。
6. **审计层**：记录脱敏的 tool request/decision/result、exit code、耗时、修改摘要、session id。

### 7.3 需要诚实声明的限制

- 本地 agent 以启动它的用户权限运行；路径规则与审批不是操作系统级 sandbox。
- shell 黑名单不可能穷举所有危险 shell 组合；真正高风险环境应在容器/VM/最小权限账户中运行。
- 上下文摘要是有损的；完整 transcript 保留在本地，必要时让 agent 重新读取源文件/输出。
- Goal gate 只能基于已经收集的证据做判断，不能代替测试、编译器或人工 code review。

这比声称“绝对安全”更适合面试答辩。

---

## 8. 测试策略

### 8.1 单元测试

- Model response parsing：content、多个 tool calls、缺字段、provider error、usage；
- Tool schema：必填字段、类型、unknown key、invalid JSON；
- Path guard：相对路径、`..`、绝对路径、symlink、Windows 路径；
- File edit：oldText 缺失、多次匹配、原子写入失败；
- Shell：退出码、超时、abort、stdout/stderr 截断；
- Permission：allow / ask / deny，非交互行为；
- Compaction：tool-call/result 配对不被切断、当前请求保留、archive reference 合法；
- Session JSONL：append、restore、损坏尾行；
- Skill/MCP 名称规范化和冲突检测；
- Hook 的执行顺序、阻断和错误隔离。

### 8.2 集成测试

用临时 fixture workspace + fake model 写完整轨迹：

1. 模型先读文件，再 edit，再 run test，根据失败再修复；
2. 模型请求工作区外写入，被拒绝后能换成安全路径；
3. 工具超时/命令失败被写回后模型继续；
4. session 中断后恢复；
5. 大日志被归档，模型通过 `read_file` 重新定位信息；
6. Skill 和 MCP 动态加入后可调用；
7. Goal 条件没有验证证据时继续、有明确 exit 0 才结束。

### 8.3 真实 API smoke tests

真实模型调用昂贵且不稳定，不应成为 CI 必需条件。通过显式环境变量如 `RUN_LLM_E2E=1` 运行，至少覆盖：普通回复、工具调用、一个端到端 demo。视频录制前必须手工运行。

### 8.4 回归规则

新增 feature 时必须新增至少一个：

- 正常路径 test；
- 失败/拒绝路径 test；
- 对应的 README/architecture 说明；
- 一条可用于演示或 debug 的事件记录。

---

## 9. Git 与提交历史计划

题目要求公开新仓库且保留真实完整历史。建议从初始化开始提交，不要最后集中上传。

建议提交节奏：

```text
chore: initialize TypeScript CLI project
chore: add safe environment configuration
feat: add OpenAI-compatible model client
feat: implement tool-calling agent loop
test: cover loop and tool result invariants
feat: add guarded file and search tools
feat: add command runner with permission checks
feat: persist sessions in JSONL
feat: add slash commands and session resume
feat: load project instructions and skills
feat: add hooks and context compaction
feat: add todo planning and run telemetry
feat: add MCP dynamic tool integration
test: add end-to-end coding task fixtures
docs: document architecture and security boundaries
docs: finalize usage guide and demo scenario
```

规则：

- 每一提交应是可解释、尽量可运行的原子变化；
- 不提交 `.env`、真实 session、工具输出、视频原始录制缓存或 API response dump；
- 避免 rebase/force push 已推送历史；
- 最后一次提交后，预留足够时间检查并在截止后禁止再推送。

---

## 10. README、视频与面试准备

### 10.1 README（最终不超过 1000 汉字）建议结构

1. 项目名 + Git 仓库地址；
2. 一句话说明：独立实现的 TypeScript coding agent；
3. 安装与配置（Node 版本、`npm install`、复制 `.env.example`、设置环境变量）；
4. 运行命令与一条 demo prompt；
5. 核心功能（loop、本地工具、安全、会话、Skills/MCP/压缩等已实现项）；
6. 设计说明：不使用 agent framework/SDK，调用模型 API 使用原生 tool calling；
7. 安全提示与已知限制。

### 10.2 两分钟视频脚本

建议目标时长 90–110 秒，留出缓冲。

| 时间 | 内容 |
|---|---|
| 0–10s | 题目、项目名、技术栈，说明 agent 独立实现的核心。 |
| 10–25s | 展示启动、workspace、模型与可用工具/skill。 |
| 25–75s | 真实任务：阅读已有小项目 → 定位 TODO/测试失败 → 修改文件 → 运行测试失败 → 再修复 → 测试通过。可加速但保留关键 tool calls 与 exit code。 |
| 75–95s | 展示安全或扩展亮点：危险写入被要求确认/拒绝，或 Skill/MCP 动态加载。 |
| 95–110s | 简图讲清：Model → 自建 AgentRunner → ToolRegistry/Policy → Local environment；消息和 session/summary 如何保存。 |
| 110–120s | 给出仓库地址，结束。 |

录制要求：MP4、≤2 分钟、≤200 MB；录制前运行 `git grep`、终端历史、环境显示检查，确保 key/base URL 中敏感部分不出现。

### 10.3 面试高频问题与回答要点

| 问题 | 回答应包含 |
|---|---|
| Agent 为什么能自主工作？ | 模型负责选择工具和停止；本项目的 `while` loop 执行 tool call、把 observation 回写，再请求模型。 |
| 为什么不用 agent 框架？ | 题目禁止；核心状态机、工具注册/执行、消息历史和错误处理全部自行实现，API SDK 仅为 HTTP/tool-calling transport。 |
| 如何避免模型乱操作？ | workspace canonical path、policy、审批、超时、限额、日志；并诚实说明不是 OS sandbox。 |
| 为什么要 tool result？ | 它是模型对真实世界操作的 observation；每个 tool_call 必须有匹配结果，否则协议/推理链不完整。 |
| 如何处理大上下文？ | 先落盘和引用大输出，再裁剪旧结果，最后结构化摘要；完整记录仍可在本地重读。 |
| MCP 是否安全？ | MCP 只提供发现与调用协议，不授权；host policy 独立判断，外部 server description 不可信。 |
| 为什么先做单 agent？ | 可测、可解释、核心价值最高；子 agent 只在隔离上下文或并发能带来明确收益时引入。 |
| 如何判断任务完成？ | 基础上模型停止；复杂编码任务还需测试/lint/diff 等证据，GoalGate 可要求补齐验证。 |
| 为什么 JSONL？ | append-only、人可读、容易恢复与审计；用 abstraction 保留日后切换 SQLite 的空间。 |

---

## 11. 建议的 Demo 任务

新建一个很小的、无网络依赖的 fixture 项目，例如 `examples/buggy-todo-cli/`：

- Node/TypeScript CLI，已有 2–4 个源文件和 3–5 个 Vitest 测试；
- 初始含一个真实但易理解的 bug，例如：重复任务错误去重、未处理空输入、持久化路径错误；
- 用户 prompt：
  > “阅读这个小项目，找出导致测试失败的原因，修复实现；不要修改 tests，最后运行测试确认。”
- 理想工具轨迹：`list_files` → `read_file`/`grep_files` → `run_command npm test` → `edit_file` → `run_command npm test` → `git_diff` → 最终总结。

优势：任务真实、可复现、能展示模型基于测试输出迭代，不依赖临时创建项目或网络下载。准备一个备用 reset 脚本和一份已验证的 session，以应对视频录制时 API 波动。

---

## 12. Spec 文档计划

本项目是模型驱动系统，许多关键行为不能只靠 TypeScript 类型约束。因此后续实现应先以自然语言 spec 冻结协议和边界，再写代码和测试。每份 spec 都应标注参考来源，尤其是 `Assignment.md` 与 `refs/` 中的 Pi / pi-minimal-doc / learn-claude-code 资料。

首批已建立的核心 spec：

| 文件 | 约束对象 | 主要参考 |
|---|---|---|
| `specs/01-agent-loop.md` | Agent 主循环、tool call/result 配对、停止条件、预算、取消、重试 | `Assignment.md`、`refs/pi-minimal-doc/source/minimal-agent.md`、`input-to-llm.md`、`architecture.md`、`learn-claude-code/s01_agent_loop`、`s17_goal_loop` |
| `specs/02-tool-protocol.md` | 工具定义、schema、handler、错误格式、输出截断、内置工具语义 | `Assignment.md`、`pi-minimal-doc/minimal-agent.md`、`input-to-llm.md`、`learn-claude-code/s03_permission`、Pi extensions 文档 |
| `specs/03-permission-trust.md` | 权限策略、workspace 边界、敏感路径、shell 风险、项目 trust、凭据规则 | `Assignment.md`、`pi-minimal-doc/trust-and-auth.md`、`cli-to-tui.md`、`learn-claude-code/s03_permission` |
| `specs/04-context-assembly.md` | system prompt、项目指令、skills、历史、摘要、附件、prompt injection 边界 | `Assignment.md`、`pi-minimal-doc/input-to-llm.md`、`compaction-and-branches.md`、Pi skills 文档、`learn-claude-code/s07/s08` |
| `specs/05-session-persistence.md` | JSONL session、entry 类型、恢复、artifact、分支预留、脱敏持久化 | `Assignment.md`、`pi-minimal-doc/compaction-and-branches.md`、Pi harness 文档、`learn-claude-code/s08` |
| `specs/06-telemetry.md` | 本地事件日志、run report、脱敏、隐私模式、调试证据 | `Assignment.md`、`pi-minimal-doc/architecture.md`、`input-to-llm.md`、`trust-and-auth.md` |
| `specs/07-cli-ux.md` | CLI 模式、参数、slash commands、渲染、审批交互、退出码、demo 约束 | `Assignment.md`、`pi-minimal-doc/cli-to-tui.md`、`input-to-llm.md`、`trust-and-auth.md`、Pi README |

建议审核方式：

1. 先审核 `01-agent-loop.md`、`02-tool-protocol.md`、`03-permission-trust.md`，因为 Phase B/C 会直接依赖它们。
2. 审核时重点看“必须/默认/禁止”的表述是否符合预期，而不是纠结命名细节。
3. 每个 Phase 开始前，先检查相关 spec 是否已冻结；实现后按 spec 补测试。
4. 若实现中发现 spec 不合理，先修改 spec 并记录原因，再改代码，避免代码和文档分叉。

后续可选 spec：

- `08-skills.md`：Skill frontmatter、catalog、`load_skill`、信任边界；
- `09-mcp.md`：stdio MCP client、动态工具注册、命名、权限、mock server；
- `10-compaction.md`：摘要结构、触发条件、overflow retry、artifact 引用；
- `11-subagents-workflows.md`：子 agent、后台任务、workflow、worktree 隔离；
- `12-model-runtime.md`：模型配置、OpenAI-compatible adapter、认证优先级、错误映射。

---

## 13. 后续 session 的启动顺序

每个新的实现 session 开始时：

1. 先读本文件；
2. 查看 `git status`、最近 commit 与 `README.md`；
3. 选择一个尚未完成的 Phase，明确验收命令；
4. 只实施该 Phase 所需的最小改动；
5. 跑 typecheck、测试和必要的手工 smoke test；
6. 更新 README/docs 与本计划中的状态（可另建 `progress.md`）；
7. 形成清晰的 Git commit，再进入下一 Phase。

**第一实现 session 的唯一建议目标：完成 Phase A。** 不要第一天开始做 TUI、MCP、subagent 或 memory。

---

## 14. 尚待冻结的产品决策

这些决策不阻塞 Phase A/B，但应在 Phase C 前确认：

1. 是否将项目名称定为 `nju-coding-agent`，配置目录定为 `.nju-agent/`？
2. 默认权限模式：
   - **推荐**：工作区内读操作自动允许；写、编辑、shell 默认展示摘要后允许/按策略询问；高危/越界直接拒绝；
   - 自动模式：工作区内常规写和测试命令自动允许，仅高危操作询问；
   - 严格模式：每一个写/命令都确认。
3. 是否在 P1 就实现简易全屏 TUI，还是保持可靠的行式 CLI 至 P2？推荐后者。
4. Skills 是否直接采用 Agent Skills 风格的 `SKILL.md` frontmatter？推荐采用，以便格式直观且未来可复用；加载器必须自行编写。
5. MCP 是否作为 P2 的显著亮点，还是只做最小 demo？推荐完整但受控的 stdio MCP client，不做 server marketplace。

---

## 15. 当前状态

截至当前实现检查：

- [x] Phase A：TypeScript/Node CLI、配置、错误处理、Vitest、README、CI 与安全 gitignore。
- [x] Phase B：自建 AgentRunner、三种模型协议、tool calling、streaming、取消和配对错误处理。
- [x] Phase C：工作区文件/搜索/PowerShell 工具、路径保护、权限模式、输出限制和 redaction。
- [x] Phase D：JSONL session、交互命令、resume、上下文恢复和 TUI 历史 hydration。
- [x] Phase E：项目 instructions、catalog-first Skills、`load_skill`、lifecycle hooks 与有界 compaction 基础。
- [x] Project Trust：`--approve`/`--no-approve`、用户级 canonical workspace trust store、TUI `/trust`，未信任项目不加载 Skills/MCP 行为资源。
- [x] Phase F 基础：结构化 todo、run evidence telemetry、stop 生命周期和可复现 demo fixture。
- [x] GoalGate 基础：验证型目标必须具备成功 `run_command` 证据；缺证据时向模型追加一次 host verification requirement。
- [x] Phase G 基础：opt-in MCP stdio JSON-RPC、initialize/tools/list/tools/call、命名冲突检测、host registry/policy 边界。
- [x] Phase H 基础：`/fork` session lineage、显式 background command/status/cancel；并发高级 workflow/subagent/worktree 仍未实现。
- [x] Phase I 文档基础：README、architecture、decisions、threat-model、CI；README 汉字数符合 Assignment 约束。
- [x] TUI：参考 Pi/Claude Code 完成可见光标、多行编辑、Markdown、语义 transcript、picker、取消、resume 历史分页。
- [ ] 完整 MCP demo server、完整 context compaction/summary lifecycle、GoalGate、复杂 session tree/fork、subagent/worktree/background workflow。
- [ ] 用户侧交付：创建并填写题目发布后新建的公开 GitHub/Gitee 仓库地址，录制不超过 2 分钟且不超过 200 MB 的 MP4，并按要求打包提交。

代码验证：`npm run typecheck`、`npm test -- --run`（18 files / 71 tests）、`npm run build`、`git diff --check` 均通过；工作区已清洁并保留功能切片提交历史。