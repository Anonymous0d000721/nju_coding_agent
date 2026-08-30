# Spec 10：质量闭环执行规范

> 本文件是 Agent 的内部执行合同，不是面向最终用户的说明。Agent 必须按本文件的优先级、边界、测试和完成定义执行；每个阶段都要留下可复核的代码、测试或报告证据，不能用口头说明代替证据。

## 1. 执行目标

Agent 必须把已有能力收敛为可验证、可追溯、可恢复的工程闭环：

1. 危险操作必须经过统一的风险分类与策略决策；
2. 修改完成后必须保留结构化、可核验的验证证据；
3. 模型重复失败或陷入停滞时必须触发收敛处理，而不是无限循环；
4. 每次运行必须能说明执行过什么、修改过什么以及为何结束；
5. 离线示例、自动化测试和交付材料必须形成可重复的证据链。

## 2. 架构约束

实现不得改变以下既定边界：

- 保留 TypeScript/Node.js、`AgentRunner`、`ToolExecutor`、`ToolRegistry`、JSONL session、deterministic compaction、TUI、JSON-RPC、MCP 和插件体系；
- 不改造成其他语言的单循环、GUI 或数据库架构；
- 不引入 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 或其他 agent framework；
- 不把 `shell:false`、黑名单、路径检查或审批描述为 OS sandbox；
- 不以固定 turn/tool-call 数量上限替代自然完成、取消、错误和收敛控制；
- `hashline_edit` 继续作为局部编辑的主协议，不把无保护的模糊替换设为默认行为。

与现有规范的关系：

- `specs/03-permission-trust.md` 规定 P0 默认 `yolo`；本规范补充统一的风险分类、决策记录和 strict/confirm 行为；
- `specs/01-agent-loop.md` 禁止固定 turn/tool-call 上限；本规范的重复调用熔断只针对具体行为指纹，不构成全局次数预算；
- `specs/02-tool-protocol.md`、`specs/05-session-persistence.md`、`specs/06-telemetry.md`、`specs/08-tui.md`、`specs/09-context-harness.md` 分别提供工具、持久化、遥测、UI 和插件边界。

## 3. 优先级

### 3.1 P0：质量与交付门禁

Agent 必须先完成以下门禁，未满足时不得进入 P1：

1. 统一风险/审批策略入口；
2. workspace、敏感文件和 Windows symlink/junction 安全测试；
3. 一个无网络 FakeModel 端到端验收流程；
4. 将风险、审批、路径摘要、命令退出码和耗时写入 run report；
5. 重新核验已知的 PowerShell 时序测试失败；
6. 完成公开仓库、README、视频和压缩包的交付检查。

### 3.2 P1：核心质量增强

只有 P0 的实现、测试和验收证据稳定后，Agent 才能继续：

1. 结构化验证证据和更准确的 Goal Gate；
2. 重复 tool-call/重复失败检测与无工具收尾；
3. 本次运行的变更记录、`/diff` 和受 hash 保护的有限 `/undo`；
4. `/status` 与验证/工具/压缩/停止原因展示；
5. 模型 429、5xx、超时和无效响应的有限退避恢复。

### 3.3 P2：扩展能力统一治理

P0/P1 不得被以下可选工作阻塞；在前两级稳定后，Agent 可继续：

1. MCP、用户插件和后台任务纳入同一风险、超时、取消、脱敏和 telemetry 矩阵；
2. Markdown Memory 的结构化 topic、检索评分、容量、过期、删除和离线评测；
3. SQLite、多 agent 或 worktree；这些项目不得阻塞交付。

## 4. P0-A：统一风险与审批策略

### 4.1 策略模型

现有 `ToolRisk = read | write | shell | external` 只用于工具描述；策略层必须定义归一化结果：

```ts
type OperationClass = 'read' | 'mutating' | 'shell' | 'external';
type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';
type PolicyAction = 'allow' | 'ask' | 'deny';

interface PolicyDecision {
  action: PolicyAction;
  operationClass: OperationClass;
  risk: RiskLevel;
  reason: string;
  ruleId: string;
  approvalScope?: 'once' | 'session';
}
```

策略必须在 `ToolExecutor` 的唯一执行入口中生效。工具 handler、MCP adapter、用户插件和后台任务不得绕过该入口直接执行。

### 4.2 默认分类

| 操作 | 默认风险 | 说明 |
|---|---:|---|
| 普通 `list/read/glob/grep` | low | 仍受 workspace 和敏感数据策略约束 |
| 普通 `write/hashline_edit` | medium | 记录路径、前后 hash 和变更摘要 |
| 普通 `run_command` | medium | 记录 executable、cwd、退出码和耗时 |
| 删除、覆盖敏感文件、依赖安装、网络命令 | high | 必须执行明确的策略处理 |
| `git reset/clean/push` 等高影响 Git 操作 | high | 不得仅依据工具自报的 readonly 判断 |
| 外部/MCP/插件工具 | high | server description 和 annotation 不构成授权 |
| 未注册工具、无法分类的工具 | blocked/high | 未注册工具直接返回结构化错误 |
| 格式化磁盘、系统级破坏、凭据泄露 | blocked | 所有 permission mode 均拒绝 |

具体命令检测不得被描述为完整 shell 安全；它只是策略的一部分。

### 4.3 permission mode 行为

- `yolo`：已注册且未触发 hard deny 的操作不逐次弹窗，但仍必须经过策略分类、路径保护、超时、输出限制和审计；`blocked` 永远拒绝；
- `strict`：低风险普通读取可自动允许；medium/high 或未知来源默认不自动允许；无交互时返回 `approval_required` 或 `permission_denied`；
- `confirm`：medium/high 操作通过统一 approval callback/TUI 请求确认，支持 allow once、deny、allow for session；没有 callback 时不得假装已批准；
- unknown tool、workspace 越界、敏感路径 hard deny 不因 `yolo` 或会话授权而放行。

审批结果必须包含：工具名、风险、归类原因、脱敏参数摘要、cwd/path 摘要、决定、授权范围和耗时。

### 4.4 审计要求

每次工具调用至少在 run report/telemetry 中记录：

- tool name、operation class、risk level、policy rule；
- `allow/ask/deny` 和最终审批结果；
- 脱敏后的路径或命令摘要；
- elapsed time、timeout/cancel 状态；
- 文件操作的前后 hash（若可得）；
- shell 的 executable、cwd、exit code；
- 错误 code 和恢复提示。

默认不记录完整文件内容、完整环境变量、API key 或未经限制的 stdout/stderr。

## 5. P0-B：Workspace 与敏感数据安全基线

### 5.1 所有入口统一使用路径守卫

以下入口必须使用同一套 canonical/realpath containment：

- `read_file`、`write_file`、`hashline_edit`；
- `list_files`、`glob_files`、`grep_files`；
- `run_command` 的 cwd；
- `@<file_relative_path>` 和 `@{path}` 附件展开；
- MCP、用户插件和后台任务传入的 workspace path。

必须覆盖 Windows 的相对路径、盘符绝对路径、UNC 路径、`..`、大小写差异、symlink 和 junction escape。

### 5.2 敏感路径规则

默认策略如下：

| 目标 | list/search | read | write/edit |
|---|---|---|---|
| 普通 workspace 文件 | 可按参数允许 | 允许 | 按 permission mode |
| `.env`、`.env.*`（`.env.example` 除外） | 默认隐藏或标记敏感 | 默认拒绝 | 拒绝 |
| `.pem`、SSH 私钥、`id_rsa`、`id_ed25519`、`credentials`、`token`、`secret` | 默认隐藏或标记敏感 | 默认拒绝 | 拒绝 |
| `.git/**` | 可显示有限状态信息 | 默认拒绝内部内容 | 拒绝写入 |
| `.nju-agent/**` session/log/cache | 默认隐藏 | 默认拒绝原始私密内容 | 拒绝普通 file tools 写入 |
| workspace 外路径 | 拒绝 | 拒绝 | 拒绝 |
| symlink/junction 解析后越界 | 拒绝 | 拒绝 | 拒绝 |

敏感读取若未来支持，必须走显式 approval、脱敏和审计，不能由模型仅凭 prompt 自行升级权限。`@` 引用不能绕过该规则。

### 5.3 P0 测试向量

必须有独立回归测试覆盖：

- `..`、绝对路径、盘符路径、UNC 路径；
- symlink 和 Windows junction 指向 workspace 外；
- `.env`、`.env.local`、`.pem`、SSH/key/credential/token/secret 文件；
- `.git`、`.nju-agent`、`node_modules` 的读、列举、写行为；
- workspace 根目录与普通子文件的边界；
- `@path`、MCP/plugin 参数与本地工具使用同一结果；
- 错误 code 稳定且不泄露敏感绝对路径或文件内容。

## 6. P0-C：离线 FakeModel E2E 验收

### 6.1 总原则

必须提供不需要 API key、不访问网络、可重复 reset 的验收流程。FakeModel 只模拟已知的模型响应和 tool calls，不替代真实模型 smoke test，也不把固定脚本伪装成通用 agent 能力。

### 6.2 主场景

以 `examples/buggy-todo-cli/` 为 P0 主场景：

1. `reset` 恢复固定 fixture；
2. baseline 测试按设计出现两个失败；
3. FakeModel 先读取源码和测试输出；
4. agent 只修改实现文件，不修改测试和 fixture；
5. agent 重新运行测试、typecheck 和 build；
6. 所有要求的验证成功；
7. run report 包含工具轨迹、文件变更、验证证据和正确 stop reason；
8. 再次 reset 后可以重复同一流程。

P1 再把同一 harness 扩展到 `feature-development/` 和 `self-hosting-plugin/`，覆盖回滚、manifest 校验、`/reload` 和错误恢复。

### 6.3 E2E 强制断言

- 全程无网络请求；
- 测试文件 hash 在 run 前后不变；
- 未授权路径和敏感文件调用被拒绝；
- 每个 assistant tool call 都有配对 tool result；
- 每次写入都有策略决策和变更记录；
- baseline 的预期失败与修复后的成功状态均可观察；
- `npm test`、`npm run typecheck`、`npm run build` 或场景等价命令的 exit code 被记录；
- 运行结果不得声称未运行的检查已通过；
- reset 后 fixture、测试和源码状态可重现。

### 6.4 验收入口

实现时提供单一 PowerShell 验收入口，例如 `npm run verify:offline`。该入口必须返回非零退出码表示验收失败，并将详细结果写入被 `.gitignore` 忽略的本地 artifact 目录；不得把 session、API response 或含敏感信息的日志提交到仓库。

## 7. P0-D：交付门禁

交付门禁与代码功能并行，但在 P0 结束前必须全部重新核验：

1. 全量测试、typecheck、build、`git diff --check` 通过；已知的 PowerShell 时序失败必须明确标记为“已修复并复验”或“仍失败”，不能沿用旧结果；
2. 公开 Git 仓库已创建，README 使用真实 URL，不使用占位符；
3. README 严格按项目交付约束不超过 1000 个字符，并覆盖运行方式、核心特色和仓库地址；
4. MP4 演示视频不超过 2 分钟且不超过 200 MB；
5. 视频中不出现 API key、base URL 中的私密部分、`.env`、session 原文或系统敏感路径；
6. 最终 zip 使用指定交付名称命名，包含 README 和视频，不包含 `node_modules`、session、日志、缓存和密钥；
7. 至少完成三次 clean-room 演练：reset、运行、恢复、验证、录制入口均可执行；
8. Git 历史保持完整，不 force push、不重写已发布提交。

## 8. P1-A：结构化验证证据与 Goal Gate

### 8.1 证据模型

`run_command` 成功不再被视为足以证明所有任务完成。宿主应从工具结果中收集结构化证据：

```ts
type VerificationKind =
  | 'test'
  | 'typecheck'
  | 'build'
  | 'lint'
  | 'static_check'
  | 'git_diff'
  | 'custom';

type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'stale';

interface VerificationEvidence {
  id: string;
  kind: VerificationKind;
  command?: string;
  cwd?: string;
  status: VerificationStatus;
  exitCode?: number | null;
  startedAt: string;
  elapsedMs: number;
  sourceToolCallId: string;
  summary: string;
}
```

### 8.2 验证计划

Goal Gate 必须根据任务目标或 host 配置形成 `VerificationPlan`，包含：

- 目标需要的证据类型；
- 可接受的命令模式或 fixture 标识；
- 证据的时间顺序和相关 workspace；
- 修改发生后是否必须重新验证。

例如“修复并运行测试”至少需要与当前 workspace 相关的测试证据；仅执行一次成功的 `echo done` 不满足要求。

### 8.3 停止行为

- 计划中的证据全部通过：允许 `completed`；
- 有失败证据：向模型返回结构化验证债务，继续 loop；
- 没有证据：可以返回 `model_finished`，但 run report 必须标记 `unverified`，不得声称已验证；若目标明确要求验证，则继续请求模型补证据；
- 修改后旧证据失效：标记 `stale`，要求重新运行；
- 不引入第二个 LLM evaluator 作为 P1 必需依赖。

## 9. P1-B：重复调用与收敛机制

### 9.1 指纹

对规范化后的 `toolName + arguments` 计算 tool-call fingerprint：

- JSON 对象键排序；
- 路径转为 workspace-relative canonical form；
- 去除仅用于显示的 preview 和不可稳定字段；
- 不记录或哈希化敏感值；
- 结果错误另记录 `tool fingerprint + error.code + normalized message`。

### 9.2 默认行为

默认阈值如下：

1. 同一调用指纹连续或近邻重复 3 次：向模型注入一次“请换策略”的 runtime warning；
2. 同一调用在 warning 后仍重复，或相同失败持续重复：暂时阻止该次重复执行，并返回 `convergence_warning`；
3. 仍然无法改变策略：执行一次无工具收尾请求，要求模型总结当前状态、失败原因和下一步，不再接受新的工具调用；
4. 无工具收尾仍请求同一无效操作：以 `convergence_stopped` 结束，并在 report 中记录指纹、阈值和最后错误。

该机制：

- 不设置全局最大 turn/tool-call 数；
- 不自动猜测或修改模型参数；
- 不吞掉被阻止的 tool call，必须产生结构化 tool result；
- 允许取消并保留完整 session。

## 10. P1-C：变更记录、`/diff` 与有限 `/undo`

### 10.1 Change Journal

文件变更必须追加结构化记录：

```ts
interface FileMutationRecord {
  id: string;
  runId: string;
  sessionId?: string;
  toolCallId: string;
  operation: 'create' | 'modify' | 'delete';
  relativePath: string;
  beforeHash?: string;
  afterHash?: string;
  preview?: string;
  reversible: boolean;
  artifactPath?: string;
  createdAt: string;
}
```

记录不能把完整敏感文件内容写入 session 或 telemetry。需要恢复的旧内容放在受控、脱敏、被忽略的 artifact 位置，并有大小上限。

### 10.2 `/diff`

默认显示当前 session/最近 run 的变更：

- 文件路径、操作类型、前后 hash；
- 有界 diff preview；
- 是否可撤销；
- 变更来源 tool call 和时间；
- 被外部修改、内容截断或无法计算 diff 时的明确状态。

不得把 shell、网络、MCP 或任意外部副作用伪装成可回滚文件事务。可选的 Git diff 只能作为补充观察，不替代 Change Journal。

### 10.3 `/undo`

P1 只允许撤销受 journal 记录且可逆的文件 create/modify/delete：

1. 读取当前文件并计算 hash；
2. 当前 hash 必须等于该记录的 `afterHash`；
3. 不一致时返回 `undo_conflict`，不得覆盖外部修改；
4. 通过同一 workspace guard、文件锁和原子写恢复；
5. 撤销操作自身追加新的 journal/session/telemetry 记录；
6. 不支持 shell、MCP、插件、后台任务或网络副作用的“撤销”。

## 11. P1-D：运行证据展示

新增或扩展 `/status`，至少展示：

- workspace、session 名称和 run 状态；
- model、effort、permission mode；
- turns、tool calls、成功/失败计数；
- 当前验证状态：passed/failed/not_run/stale；
- 最近测试或命令的 exit code 与 stdout/stderr 尾部；
- compaction 次数和最近原因；
- stop reason、warnings/errors；
- 本次变更文件列表。

TUI 遵守 `specs/08-tui.md` 的布局规则：短状态放 Widget/Status 区，大段测试输出和 diff 放 Transcript 或受控 artifact；不使用逐词背景色。

JSON-RPC/JSON event 需要提供等价的结构化字段，不把 TUI 文本反向解析成协议。

## 12. P1-E：模型失败恢复

模型 transport 层可以对以下错误做有限退避：

- HTTP 429；
- HTTP 5xx；
- 可判定的网络断开；
- 单次请求超时；
- provider 明确表示可重试的临时错误。

要求：

- 次数有上限，采用带 jitter 的指数退避；
- 尊重 `Retry-After`，但设置总 wall-clock 上限；
- 每次重试写入 `model_retry` telemetry；
- tool handler 错误、权限拒绝、schema 错误默认不自动重试；
- 无效模型响应应转成结构化错误或有限修复，不得无限重试；
- FakeModel 测试必须覆盖重试次数、总耗时、取消和最终 stop reason。

## 13. P2：扩展工具统一审计

MCP、用户插件和后台命令接入同一矩阵：

| 能力 | 必须统一的行为 |
|---|---|
| 风险 | operation class、risk、policy decision、unknown default |
| 路径 | workspace/canonical/symlink guard |
| 执行 | timeout、AbortSignal、并发/队列规则 |
| 输出 | bounded preview、artifact reference、redaction |
| 持久化 | tool call/result、错误、耗时、外部资源摘要 |
| 交互 | 无前台审批时不假装获得 confirm |
| 生命周期 | connect/reload/background completion/cancel 都可追踪 |

插件和 MCP server 自己声称的 `readonly`、description 或 annotation 只能作为提示，不能覆盖 host policy。

## 14. P2：Memory 评测与生命周期

在当前显式写入和 redaction 基础上，再考虑：

- topic 结构化和检索评分；
- 去重、容量上限、过期、删除和可见状态；
- 以固定 fixture 评估召回准确性和无关记忆污染；
- 继续禁止未经意图确认的 transcript 自动写入；
- 观察型、会调用模型的 memory worker 继续保持默认关闭，除非另行批准独立 spec。

## 15. 执行顺序与提交边界

Agent 从本次授权开始按以下顺序实施；每一步先写测试，再改实现，完成后同步文档并运行该阶段门禁：

1. 风险分类、策略决策和审计事件；
2. workspace/敏感文件/Windows link 安全测试；
3. FakeModel 离线 E2E 与主场景验收入口；
4. run report、README 和交付门禁复核；
5. 验证证据与 Goal Gate；
6. 收敛检测与无工具收尾；
7. Change Journal、`/diff`、hash 保护的 `/undo`；
8. `/status` 和 TUI/JSON-RPC 证据展示；
9. 模型有限退避；
10. P2 扩展工具审计和 memory 评测。

每个逻辑阶段单独提交，提交前必须通过该阶段测试和文档校验。提交消息可采用以下形式：

```text
feat: add unified risk policy and audit decisions
test: cover workspace sensitive-path boundaries
test: add offline FakeModel coding evaluation
docs: document quality and delivery gates
feat: add structured verification evidence
feat: add convergence detection and graceful finalization
feat: add change journal diff and guarded undo
feat: add run evidence status view
feat: add bounded model retry recovery
```

## 16. 测试与最终验收矩阵

### 单元测试

- risk classification、policy decision、yolo/strict/confirm；
- unknown/high/blocked 工具；
- sensitive path、symlink/junction、UNC/盘符；
- policy/approval/telemetry redaction；
- verification evidence 状态转换和 stale 规则；
- tool-call fingerprint、warning、熔断和 no-tool finalization；
- journal hash conflict、atomic undo、shell 不可回滚；
- retry backoff、Retry-After、cancel 和 wall-clock 上限。

### 集成测试

- read → edit → test → failure → fix → test passed；
- tool call 被拒绝后模型能收到结构化 observation；
- session resume 保留 policy、evidence、journal 和 stop reason；
- `/diff` 只展示当前可追踪变更；
- `/undo` 遇到外部 hash 变化时拒绝覆盖；
- TUI、JSON event、JSON-RPC 的报告字段一致且 stdout 协议纯净。

### 离线 E2E

- reset、baseline、修复、验证、report、再次 reset 全流程可重复；
- 测试文件和受保护 fixture 不被修改；
- 无网络、无真实 API key、无未记录工具执行；
- 失败场景以非零退出码结束并留下可审计 artifact。

### 交付前命令

至少重新运行：

```powershell
npm test -- --run
npm run typecheck
npm run build
git diff --check
git status --short
```

并单独运行主场景离线 E2E 和视频录制前安全检查。历史验证结果只能作为记录，不能替代本次最终结果。

## 17. 完成定义

本规范全部完成并不等于拥有 OS sandbox 或完全自主的质量证明。完成定义是：

- 工具执行有统一、可解释、可审计的 policy decision；
- workspace 和敏感文件边界有 Windows 真实回归测试；
- 至少一个离线工程任务能从失败到修复成功重复运行；
- Goal Gate 能区分 verified、failed、unverified 和 stale；
- 重复失败能警告、收敛并留下结构化 stop reason；
- 能查看本次变更并安全撤销未被外部修改的文件变更；
- TUI、JSON 和 RPC 都能展示同一组关键运行证据；
- 所有已知限制仍在文档中诚实声明。
