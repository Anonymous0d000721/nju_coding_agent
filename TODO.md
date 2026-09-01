# NJU-Agent 完整 TODO

> 总原则：
>
> 向优秀 coding agent 和同类项目学习其可验证的工程方法，但不照搬界面、框架或未经证明的实现；把有效经验转化为自己的架构、测试、审计和演示证据，最终在可靠性、安全边界和可解释性上超过单纯的“能调用工具”的 Agent。

---

## 0. 执行规则

- [ ] 每项功能先写清楚目标、边界、失败语义和验收命令，再实现。
- [ ] 每个功能只允许一个明确的源码入口，避免 TUI、RPC、脚本各自实现一套逻辑。
- [ ] 所有模型驱动行为都必须有 FakeModel 或确定性单元测试；真实模型只能作为补充验证。
- [ ] 所有文件变更都必须经过 workspace guard、统一 ToolExecutor、telemetry 和必要的 Change Journal。
- [ ] 不使用任何被禁止的 Agent 框架或 SDK，不包装现成 Agent 产品界面；核心循环、上下文、工具执行和停止逻辑必须由本项目维护。
- [ ] 不把 README、设计文档或模型回复当成实现证据；证据必须来自源码、测试、命令输出或可复现脚本。
- [ ] 每个逻辑功能单独提交；提交前运行 typecheck、test、build、diff check，并清理 runtime、dist、node_modules 等生成物。
- [ ] 任何涉及安全、权限、会话、持久化或协议的改动，都必须增加回归测试和失败案例。

---

## 1. 当前基线与完成判断

### 1.1 已形成的核心能力（不要重复实现）

- [x] TypeScript/Node.js 分层架构：模型、AgentRunner、工具、上下文、会话、TUI、RPC、插件、MCP 分离。
- [x] Agent loop：模型请求、工具调用、结果回填、自然完成、取消、错误恢复。
- [x] 不设置固定 `maxTurns` 或 `maxToolCalls` 硬上限；依靠自然完成、取消、错误、压缩和收敛保护结束。
- [x] 工具统一注册并经过 ToolExecutor 执行。
- [x] 文件读写、Hashline 编辑、glob、grep、Git、PowerShell、后台任务、todo 工具。
- [x] `yolo`、`strict`、`confirm` 权限模式和统一 policy decision。
- [x] workspace 越界、realpath、敏感路径、附件、文件搜索和输出脱敏保护。
- [x] JSONL 会话、恢复、命名、分页、fork 和 append-only 历史。
- [x] native instructions/skills 加载和受 Trust 约束的用户插件加载。
- [x] Markdown Memory：索引、topic 按需读取、搜索、显式证据写入、脱敏、删除和禁用边界。
- [x] 零模型、零网络的 deterministic compaction，并保留原始会话记录和压缩审计元数据。
- [x] 结构化 Goal Gate、验证计划、验证证据和 stale 状态。
- [x] 重复工具调用 fingerprint、warning/block、无工具 finalization 和 `convergence_stopped`。
- [x] Change Journal、`/diff`、after-hash 保护的有限 `/undo`。
- [x] RunReport、结构化 RunStatus、TUI/RPC `/status`、运行中 progress 和 `run_status` 事件。
- [x] OpenAI Chat、OpenAI Responses、Anthropic，以及模型传输重试、退避、Retry-After、取消和 partial-stream 保护。
- [x] Ink TUI：Transcript、Editor、Widget、Status Bar 的现代布局，Markdown 表格、工具预览、slash completion、queue/steer。
- [x] 用户插件发现、metadata/schema 校验、Trust gating、cache-busting reload。
- [x] 长驻 JSON-RPC stdin/stdout JSONL 服务及 session、prompt、cancel、slash、shutdown 等基础方法。

### 1.2 当前必须先重新验证的基线

- [ ] 在当前工作树重新运行 `npm test -- --run`，记录准确的测试文件数和测试数。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run build`。
- [ ] 运行 `git diff --check`，处理真实错误，不把 LF/CRLF 转换警告误报为失败。
- [ ] 运行 `npm run verify:offline` 两轮，确认 `networkRequests=0`。
- [ ] 清理所有示例 runtime、dist 和本地依赖生成物。
- [ ] 将最终验证结果写入报告和提交记录，避免沿用过期数字。

---

## 2. P0：先把边界闭环做完整

### 2.1 RPC 交互式审批

> 学习集中式 policy runtime 和会话授权设计；用自己的 JSON-RPC 协议实现可审计审批，而不是让 RPC 直接绕过权限系统。

- [ ] 定义 RPC 审批协议：`approval/request`、`approval/resolve`，或等价的 request/notification 机制。
- [ ] 审批请求包含 `runId`、`toolCallId`、工具名、风险等级、脱敏参数摘要、workspace 相对路径、原因和超时。
- [ ] 审批响应支持 allow、deny、allow_once、allow_session、cancel、timeout。
- [ ] 只允许对应客户端、对应运行和对应 toolCallId 的响应生效。
- [ ] 活动运行收到审批请求时暂停在工具边界，不阻塞整个 RPC 服务处理其他安全请求。
- [ ] shutdown、cancel、超时和客户端断开时自动结束待审批请求。
- [ ] 把审批结果、原因、授权范围和耗时写入 ToolResult、RunReport、session telemetry。
- [ ] 明确非交互模式行为：无客户端审批时 strict/confirm 必须拒绝或按显式策略处理，不得静默升级为 yolo。
- [ ] 增加 RPC 审批单元测试：允许、拒绝、超时、错配响应、取消、断开、并发请求、敏感参数脱敏。
- [ ] 增加 TUI 与 RPC 使用同一审批核心的集成测试。

### 2.2 MCP 生命周期、Trust 和 reload

> 学习 MCP 的发现/调用能力，但坚持“连接发现不等于授权”，MCP 必须服从主机的 schema、policy、超时、脱敏和审计。

- [ ] 明确 MCP 配置是否属于 Project Trust gating；未信任工作区不得加载行为改变型本地 MCP 配置。
- [ ] 为 `McpManager` 增加显式 server 生命周期：connect、initialize、list tools、call、disconnect、reload。
- [ ] 设计 MCP reload 语义：只影响下一次运行，还是允许在空闲时重建；禁止热替换正在执行的工具。
- [ ] reload 前后比较工具定义，检测工具删除、风险变化、schema 变化和名称冲突。
- [ ] MCP reload 失败时保留旧实例还是清空实例，必须定义并测试；不能留下半初始化状态。
- [ ] 对 MCP 子进程增加启动超时、退出码、stderr 限制、取消和孤儿进程清理。
- [ ] MCP 工具统一进入 ToolExecutor，不允许 registry-adapter 旁路执行。
- [ ] 为 MCP 调用记录 server、tool、参数摘要、policy、耗时、错误、退出和 disconnect 事件。
- [ ] 将 `/reload` 命令文案与真实能力保持一致：若支持 MCP，明确写出；若不支持，严格限定为用户插件 reload。
- [ ] 增加 MCP reload、Trust、工具变化、子进程失败和运行中 reload 的回归测试。

### 2.3 TUI/RPC 命令一致性

- [ ] 建立统一 slash command 描述表：名称、别名、参数、是否允许活动运行时调用、返回结构。
- [ ] 对齐 `/help`、`/new`、`/trust`、`/name`、`/rename`、`/fork`、`/sessions`、`/session`、`/resume`。
- [ ] 对齐 `/model`、`/effort`、`/reasoning`、`/thinking`、`/memory`、`/reload`、`/compact`、`/status`。
- [ ] 对齐 `/diff`、`/undo`、`/quit`、`/exit` 和错误码/错误文本。
- [ ] 明确哪些配置只在下一次运行生效，哪些可以即时生效。
- [ ] RPC 所有 slash 命令返回结构化结果；TUI 只负责把同一结果渲染成人类可读文本。
- [ ] 增加 TUI/RPC 命令矩阵测试，避免新增命令只接入一端。

### 2.4 三个示例统一成为可复现工程练习

- [ ] 为三个示例定义统一入口：`baseline`、`demo`、`test`、`typecheck`、`build`、`reset`。
- [ ] `buggy-todo-cli`：保持故意缺陷 fixture，验证 agent 调查、修改、测试、恢复和 reset。
- [ ] `feature-development`：保持 `reserveBatch` 未实现作为练习，明确 3 个失败测试是预期，不得修改测试逃避任务。
- [ ] `feature-development`：为 agent 修复后的结果补充独立验收脚本，验证原子预留、回滚、幂等、校验、审计和旧 API 兼容。
- [ ] `self-hosting-plugin`：补齐 demo、build、typecheck 入口。
- [ ] `self-hosting-plugin`：验证合法 manifest、非法 manifest、越界路径、重复工具名、危险外部字段和未信任 workspace。
- [ ] `self-hosting-plugin`：若定位为完整自举案例，端到端调用 `inventory_lookup` 和 `inventory_reserve`；若不实现，文档明确其只是安全 manifest adaptor。
- [ ] 所有示例都验证 `/resume`、中途取消、继续运行和 `reset` 后重复执行。
- [ ] 所有示例都断言测试文件、fixture 和受保护文件未被 agent 篡改。
- [ ] 增加根目录统一示例验收脚本，输出 JSON 证据，不把故意失败和基础设施失败混为一谈。

### 2.5 Windows 安全边界回归

> 学习对 workspace、凭据、symlink 和 UNC 的集中测试；不把黑名单或 `shell:false` 宣称为沙箱。

- [ ] 补充绝对路径、相对越界、盘符切换、UNC 路径、NUL 字符和路径大小写测试。
- [ ] 补充 symlink、junction、reparse point 指向 workspace 外部的测试。
- [ ] 补充 workspace 根目录写入、内部目录、`.git`、`.nju-agent`、`node_modules`、`.env`、证书、SSH、token、secret、credentials 文件名测试。
- [ ] 检查 file、glob、grep、attachments、Git、plugin、MCP 和 background 工具是否使用同一 guard。
- [ ] 补充 PowerShell 管道、重定向、脚本块、后台进程、超时、取消和孤儿进程测试。
- [ ] 对 `ExecutionPolicy Bypass`、`shell:false`、命令黑名单和当前用户权限写出明确限制说明。
- [ ] 高风险 demo 使用 disposable workspace 或低权限账户，不在真实项目目录中演示破坏性命令。

---

## 3. P1：把“能运行”提升为“可靠、可解释、可证明”

### 3.1 Agent loop 和运行预算

- [ ] 保持无固定 turn/tool-call 硬上限的自然循环设计。
- [ ] 增加外部可取消的 runtime deadline、AbortSignal 和宿主侧资源预算，不把预算写成模型循环的隐式截断。
- [ ] 定义模型请求、工具执行、压缩、审批、队列和收尾各阶段的状态转换。
- [ ] 为每个状态定义正常结束、取消、失败和恢复路径。
- [ ] 验证同批次工具结果按模型原始顺序持久化，执行顺序与持久化顺序不混淆。
- [ ] 需要并行执行独立工具；加入并发上限、取消、顺序持久化和竞态测试。
- [ ] 将 queue、steer、cancel 和 approval 统一纳入 AgentRunControl，避免多个控制通道互相覆盖。
- [ ] 对长时间运行、模型重复失败、工具持续失败和用户反复 steer 增加 FakeModel 场景。

### 3.2 验证证据和 Goal Gate

- [ ] 为 test、typecheck、build、lint、static_check、git_diff、custom 维护结构化证据。
- [ ] 将命令退出码、开始/结束时间、工作区、目标路径和输出尾部纳入证据。
- [ ] 修改文件后自动使相关旧证据变为 stale。
- [ ] 区分 passed、failed、not_run、stale、blocked，不用“任意命令成功”替代目标验证。
- [ ] 根据任务目标生成最小 VerificationPlan，并允许用户显式追加验证要求。
- [ ] 当验证失败时向模型注入可操作的失败摘要，但避免重复注入完整历史输出。
- [ ] 最终答复必须说明做了什么、验证了什么、哪些验证未运行、剩余风险是什么。
- [ ] 增加跨轮次验证债务、修改后重新验证、验证失败后修复和无法执行命令的测试。

### 3.3 收敛和卡死恢复

- [ ] 保持 workspace-aware tool-call fingerprint 和敏感参数安全归一化。
- [ ] 对连续重复、近邻重复、相同失败和仅改变无关参数的重复调用分别统计。
- [ ] 达到 warning 阈值时要求模型改变策略，并记录 warning。
- [ ] 达到 block 阈值时阻止重复调用，返回结构化 convergence warning。
- [ ] 执行一次不带工具定义的收尾请求，避免突然截断导致没有最终答复。
- [ ] 收尾阶段若再次请求工具，使用 `convergence_stopped` 结束并给出原因。
- [ ] 增加“重复但合理”“循环修改同一文件”“测试反复失败”“steer 后重新尝试”的区分测试。

### 3.4 模型传输与 provider 兼容性

- [ ] 保持统一 retry wrapper，只重试 429、5xx、可判定网络错误、单次超时和 provider 明确允许的错误。
- [ ] 不重试 schema 错误、工具错误、权限拒绝、无效模型响应和已产生内容的 partial stream。
- [ ] 验证 Retry-After、指数退避、jitter、总 wall-clock 上限、取消和最终 stop reason。
- [ ] 为 OpenAI Chat、Responses、Anthropic 分别增加协议级错误映射测试。
- [ ] 增加可选的本地 fake HTTP server 测试，但不在测试中使用真实 API key。
- [ ] 记录 `model_retry` telemetry，同时脱敏 URL、header、API key 和响应正文。
- [ ] 明确 thinking level、reasoning display、provider budget 和 effort 的区别。

### 3.5 Change Journal 和变更可追溯性

- [ ] recovery artifact 必须有大小上限、脱敏和 workspace-safe 路径。
- [ ] `/diff` 按当前会话展示变更，标记当前文件、外部修改、缺失和不可逆操作。
- [ ] `/undo` 必须校验 afterHash，外部修改时拒绝恢复并返回结构化错误。
- [ ] undo 记录必须持久化 `undoOf`，并同步 session 与 telemetry。
- [ ] 只允许有限文件变更回滚；shell、MCP、网络和外部副作用不得伪装成可回滚事务。
- [ ] 增加并发写入、原子写失败、进程中断、恢复 artifact 缺失和外部编辑冲突测试。

### 3.6 RunReport、实时状态和诊断

- [ ] RunStatus 至少包含 workspace、session、model、effort、permission、state、stopReason、turns、toolCalls。
- [ ] 记录工具成功/失败、策略决定、最近命令退出码、脱敏 stdout/stderr 尾部、验证证据、压缩、变更、warning/error。
- [ ] AgentRunner 在 model request、tool result、compaction、turn end、stop 时发出增量快照。
- [ ] TUI `/status` 优先显示当前会话和当前运行，不误读旧历史报告作为首次运行状态。
- [ ] RPC `status`、`session/state`、`run_status` 事件和 slash `/status` 使用同一字段语义。
- [ ] 兼容旧版不完整 RunReport，数组、verification、state 等字段统一补默认值。
- [ ] 状态输出必须能区分 idle、running、completed、failed、cancelled、convergence_stopped。
- [ ] 增加运行中状态、首次空闲、切换 session、旧报告回退、取消和异常状态测试。

### 3.7 Context Harness、Memory 和 Compaction

- [ ] 保持 native instructions/skills 与 plugin context contribution 的边界清晰。
- [ ] 保持项目 Trust 只控制项目本地资源加载，不把它错误地当成 OS 沙箱。
- [ ] `MEMORY.md` 启动注入保持行数/字符数上限，topic 内容按需读取。
- [ ] memory_write 必须需要显式用户意图、证据、脱敏和可追踪记录。
- [ ] 增加记忆过期、删除、同义 topic、重复写入、并发写入和损坏文件恢复测试。
- [ ] 为 Memory 检索建立离线质量集：命中率、误命中、敏感内容泄漏、容量上限和响应时间。
- [ ] 继续使用 deterministic compaction 作为默认零网络方案，保留 covered entry IDs 和统计数据。
- [ ] 评估语义记忆或 observational memory 时，必须作为独立可选插件，不得污染默认运行路径。
- [ ] 验证 compaction 后模型请求包含摘要、保留最近完整工具对、且不重复注入已覆盖历史。

---

## 4. P2：从可靠内核发展为可扩展平台

### 4.1 用户插件体系

- [x] 完善插件开发 skill：模块格式、版本、schema、risk、readonly、workspace、signal、错误和测试规范。
- [x] 插件加载失败必须 fail-soft，单个插件不能破坏主 Agent。
- [x] 插件工具必须经过统一 ToolExecutor，禁止直接访问未授权路径或执行外部命令。
- [x] 增加插件 manifest 签名/哈希或明确的本地信任提示机制。
- [x] 增加插件版本冲突、工具名冲突、schema 过宽、危险字段和 reload 失败测试。
- [x] 提供最小插件模板和一个只读、一个受控写入的官方示例。

### 4.2 MCP 和外部工具生态

- [x] 将 MCP server 配置、连接状态、工具目录、版本和 reload 状态加入 `/status`。
- [x] 支持独立 MCP server 的超时、重启、健康状态和故障隔离。
- [x] 为外部工具建立更细风险分类：readonly、workspace_mutation、external_side_effect、unknown。
- [x] unknown/external 工具默认进入明确的 deny 或 ask 路径，不因 yolo 造成文档和实现语义冲突。
- [x] 增加工具目录快照，检测定义变化并防止静默替换。

### 4.3 可观测性和性能

- [x] telemetry 使用统一事件 schema，字段可查询、可脱敏、可版本化。
- [x] 为 session、run、toolCall、approval、verification、compaction 和 mutation 建立关联 ID。
- [x] 对大型输出、长历史、并发工具、插件数量和 MCP server 数量做基准测试。
- [x] 测量启动时间、首 token 时间、工具平均耗时、重试等待、压缩耗时和内存占用。
- [x] 对日志文件提供大小上限、轮转或清理策略，避免长期运行无限增长。
- [x] 所有性能优化必须保留可读性和审计字段，不以删除证据换取速度。

### 4.4 子 Agent 与只读探索

- [x] 只有在主 Agent 核心稳定后，才评估只读探索子循环。
- [x] 子 Agent 必须使用独立上下文、明确工具白名单和 workspace 边界。
- [x] 主 Agent 只接收结构化结论，不把完整探索 transcript 无限制注入主上下文。
- [x] 子 Agent 的取消、失败、超时和权限必须可追踪。
- [x] 不引入外部 Agent orchestration framework；自行维护最小调度协议。

---

## 5. 对照表

| 学习对象的有效经验 | 本项目吸收方式 | 超越目标 | 证据 |
|---|---|---|---|
| 小而清晰的 Agent loop | 保持 AgentRunner 分层和自然循环 | 同时支持流式、取消、会话、压缩、收敛、RPC | runner 测试、FakeModel E2E |
| 计划与卡死提示 | Goal Gate、VerificationPlan、fingerprint | 不只提示，还能 stale、阻断并完成无工具收尾 | convergence/goal-gate 测试 |
| 集中权限策略 | ToolExecutor 唯一执行入口 | TUI 与 RPC 共用审批、策略和审计 | policy/approval/RPC 测试 |
| workspace 与凭据保护 | path guard、敏感路径识别、脱敏 | 覆盖 Windows junction、UNC、附件、glob、grep、MCP、插件 | Windows 回归矩阵 |
| FakeModel 离线验收 | `verify:offline` 和三个工程 fixture | 两轮零网络、可恢复、可 reset、断言测试文件不变 | JSON 验收 artifact |
| Change Journal 与 undo | append-only journal、before/after hash | 明确外部副作用不可回滚，拒绝外部修改覆盖 | journal/undo 测试 |
| `/status` 与运行摘要 | RunStatus、TUI/RPC status、增量事件 | 同时支持运行中、历史、首次空闲和旧报告兼容 | TUI/RPC/run-report 测试 |
| 多模型 provider 适配 | Chat、Responses、Anthropic client | 统一错误分类、重试、取消、partial-stream 规则 | model/retry 测试 |
| 长期记忆与检索 | Markdown Memory + topic | 显式证据、脱敏、可删除、离线质量评测 | memory evaluation |
| 插件和 MCP 扩展 | Trust gating、标准 registry、reload | 外部工具也必须服从本地 policy 和审计 | plugin/MCP 集成测试 |

---

## 6. 交付前最终门禁

### 6.1 源码与依赖

- [ ] 检查没有禁止的 Agent 框架、SDK 或 API 托管代码执行/文件工具。
- [ ] 检查 API key、token、cookie、私密路径和真实用户数据未进入 Git、README、日志和视频。
- [ ] 检查 `.env` 未跟踪，`.env.example` 不含真实凭据。
- [ ] 检查生成物、runtime、dist、node_modules 不进入提交内容。
- [ ] 检查提交历史按功能拆分且没有不必要的历史改写。

### 6.2 自动化验证

- [ ] `npm ci` 后从干净依赖重新验证。
- [ ] 根项目 test、typecheck、build 全部通过。
- [ ] offline FakeModel E2E 至少连续两轮通过且网络请求数为 0。
- [ ] 三个示例分别完成 baseline、demo、test、reset；故意失败必须有明确标注。
- [ ] RPC 测试覆盖 malformed JSON、unknown method、invalid params、prompt、event、cancel、shutdown 和 approval。
- [ ] TUI 测试覆盖布局、表格、光标、slash completion、status、queue/steer、cancel 和审批。
- [ ] 安全测试覆盖越界、敏感路径、symlink/junction/UNC、命令、插件和 MCP。
- [ ] Git diff check、工作区状态和最终文件清单通过。

### 6.3 README 与演示材料

- [ ] README 使用中文，控制在作业要求的 1000 汉字以内。
- [ ] README 包含真实公开仓库 URL、安装/运行方法、核心特色和安全限制。
- [ ] 演示任务选择一个真实编程任务，而不是只展示启动界面或静态帮助。
- [ ] 视频展示：调查、工具调用、修改、测试、最终结果和必要的错误恢复。
- [ ] 视频不展示 API key、`.env` 内容、私密路径或无关桌面信息。
- [ ] 视频时长不超过 2 分钟、格式为 MP4、大小不超过 200 MB。
- [ ] 提交压缩包只包含姓名命名的 zip，内部包含 README 和视频。
- [ ] 在提交前最后一次确认仓库 URL、README、视频和压缩包内容一致。

---

## 7. 推荐实施顺序

### 第一阶段：重新建立真实基线

- [ ] 清理生成物。
- [ ] 运行根项目和现有示例验证。
- [ ] 修正报告、TODO 和文档中的过期数字与状态。
- [ ] 提交“baseline: record current verified state”。

### 第二阶段：完成 RPC 审批

- [ ] 协议设计。
- [ ] ToolExecutor/AgentRunControl 接线。
- [ ] TUI/RPC 共用审批核心。
- [ ] telemetry、session、RunReport 接线。
- [ ] 单元测试、集成测试和离线演示。

### 第三阶段：完成 MCP 生命周期

- [ ] Trust 边界。
- [ ] McpManager reload。
- [ ] 子进程关闭/取消/超时。
- [ ] 工具目录变化检测。
- [ ] `/reload`、`/status` 和测试同步。

### 第四阶段：统一三个示例

- [ ] self-hosting-plugin 入口和完整定位。
- [ ] 根目录统一示例验收脚本。
- [ ] reset、resume、cancel、重复执行证据。
- [ ] 清理生成物并更新比较报告。

### 第五阶段：安全与可靠性补强

- [ ] Windows 特殊路径。
- [ ] 外部工具风险策略。
- [ ] 长运行取消、并发和资源预算。
- [ ] Memory 质量评测。
- [ ] provider 错误映射和可选集成测试。

### 第六阶段：交付收尾

- [ ] 最终全量验证。
- [ ] README 压缩和检查。

---

## 8. 每个 TODO 的完成模板

完成任何一项时，必须补充以下信息：

```text
任务：
原因：借鉴了什么工程经验：
本项目采用的独立方案：
影响文件：
新增/修改的测试：
验证命令：
验证结果：
已知限制：
提交：
```

完成标准不是“代码写完”，而是：

1. 行为可运行；
2. 失败路径有定义；
3. 证据可重复；
4. 安全边界没有被绕过；
5. TUI、RPC、session、telemetry 和文档没有出现互相矛盾的语义。
