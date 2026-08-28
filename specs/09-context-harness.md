# Spec 09：上下文 Harness

> 状态：设计规范。本文定义 context harness 的系统边界、原生能力与插件集成契约；各插件的独立行为定义在 [`plugins/`](plugins/README.md)。

## 1. 目的与范围

本规范定义 `nju-agent` 每个 run 前后如何装配、预算、标记与审计上下文。目标是在 context window 有限时，让长期工程任务仍可恢复和延续，同时不把不可信仓库内容、隐私数据或隐式额外模型调用带入模型上下文。

本文是 `specs/04-context-assembly.md` 的 harness 专项补充：

- Spec 04 定义模型输入顺序、预算、标签及安全处理；
- Spec 05 定义 JSONL session 的 append-only 持久化与恢复；
- **Spec 09 定义上下文来源的宿主、原生能力、插件边界和故障处理。**

本 spec 管理：

1. 原生项目指令（`AGENTS.md` 等）；
2. 原生 Skills catalog 与按需加载；
3. Harness plugin host、生命周期与 context contribution；
4. 原生与插件化能力的上下文装配、trust、预算及可观测性；
5. 插件规范索引与跨插件验收条件。

长期 memory、deterministic compact 与未来 observational memory 的详细契约不在本文重复，见第 5 节索引。

## 2. 设计原则

1. **原始会话优先。** session JSONL 是事实记录；memory 和 compact summary 是派生数据，不能替代、修改或删除原始记录。
2. **本地优先。** 插件不能擅自增加网络访问或模型调用；凡可能调用模型/发送数据的能力，必须在独立插件规范中声明、默认关闭并明确 opt-in。
3. **渐进披露。** 启动仅注入稳定、小型索引；详情、历史、大文件和完整 skill 通过受限接口按需读取。
4. **可追溯而非臆测。** contribution 必须附带来源。派生内容应能指向 session entry、文件版本或用户确认；无证据推断不得写成事实。
5. **信任与优先级分离。** trusted project data 仍只是低优先级上下文，不得覆盖 host 安全规则、tool policy 或用户当前请求。
6. **失败降级。** 插件损坏、超时、超预算时记录诊断并跳过；核心 agent loop、工具执行和 session 落盘必须继续运行。

## 3. 总体架构

```text
App / runPrompt
  ├─ 原生 ContextResourceLoader
  │   ├─ ProjectInstructionLoader  (AGENTS.md 等)
  │   └─ SkillRegistry             (catalog + load_skill)
  ├─ HarnessPluginHost
  │   ├─ MemoryPlugin
  │   ├─ DeterministicCompactPlugin
  │   └─ future plugins
  ├─ ContextBuilder
  │   └─ 依 Spec 04 的顺序、预算与标签组合 contribution
  └─ AgentRunner / SessionStore
       ├─ append-only 原始 entry
       └─ 生命周期事件
```

### 3.1 原生与插件的边界

| 能力 | 归属 | 原因 |
|---|---|---|
| `AGENTS.md`、`CLAUDE.md`、`.nju-agent/instructions.md` | 原生 | 项目行为约束是 harness 的基本输入，不应依赖可选包。 |
| skill 扫描、catalog、`load_skill(name)` | 原生 | 工具与 prompt 的基本渐进披露机制。 |
| session JSONL、artifact、summary entry | 原生 | 可恢复性和审计的基础。 |
| Claude-like 长期记忆 | `MemoryPlugin` | 可关闭/替换，不破坏 session。见 [`plugins/memory.md`](plugins/memory.md)。 |
| deterministic compaction | `DeterministicCompactPlugin` | 可替换、可独立测试，不能耦合 Model runtime。见 [`plugins/deterministic-compact.md`](plugins/deterministic-compact.md)。 |
| observer/reflector 自动记忆 | `ObservationalMemoryPlugin`（未来） | 会增加模型调用、成本与隐私面。见 [`plugins/observational-memory.md`](plugins/observational-memory.md)。 |

原生 loader 可以产出 contribution；插件不得绕过 Project Trust 或直接修改 `AgentRunner` 内部 message array。

## 4. Harness 插件协议

### 4.1 生命周期

宿主提供有序、超时、隔离的 hook。推荐最小接口：

```ts
type ContextPriority = 'stable' | 'project' | 'memory' | 'history' | 'runtime';

interface ContextContribution {
  id: string;
  priority: ContextPriority;
  label: 'memory' | 'project_instruction' | 'skill_catalog' | 'summary' | 'runtime_note';
  content: string;
  maxChars?: number;
  source: { plugin: string; paths?: string[]; entryIds?: string[] };
  trusted: boolean;
}

interface HarnessPlugin {
  readonly id: string;
  readonly version: string;
  onSessionOpen?(ctx: HarnessContext): Promise<void>;
  beforeContextBuild?(ctx: HarnessContext): Promise<ContextContribution[]>;
  afterRun?(ctx: HarnessContext, result: AgentRunResult): Promise<void>;
  beforeCompact?(ctx: HarnessContext, plan: CompactionPlan): Promise<CompactionDecision>;
  commands?(): HarnessCommand[];
  tools?(): ToolDefinition[];
  dispose?(): Promise<void>;
}
```

规则：

- 注册顺序确定；同一 priority 内按 `plugin.id` 排序，保证 prompt 可复现；
- hook 有独立 timeout 与字符预算；异常/超时仅产生 telemetry 与可查看 warning；
- 只有宿主可写入 ContextBuilder；插件内容须携带来源、标签与 trust 状态；
- 插件命令和 tools 名称全局唯一；项目本地插件继续受 Project Trust 保护；
- P1 仅支持本地 TypeScript/JavaScript 插件；禁止下载后自动执行、远程代码、任意 shell hook；
- 插件配置须 schema 校验；密钥不得进入 session、memory 或 telemetry。

### 4.2 装配顺序与预算

ContextBuilder 继续遵守 Spec 04：

```text
stable host rules
→ tools
→ trusted project instructions
→ skill catalog
→ plugin memory
→ compact summaries / recent history
→ current user input
→ runtime notes
```

每个来源有独立预算。超限时依次缩减：topic detail → 检索结果 → memory index 的低优先级条目 → 旧 summary 细节。不得为加入插件内容而移除当前 user message，或破坏 assistant tool-call / tool-result 配对；所有省略须写入 `omitted[]` 与 telemetry。

## 5. 插件规范索引

插件可独立演进，均须遵守第 4 节的 host contract、Spec 03 Project Trust 和 Spec 04 context-budget 规则。

| 插件 | 状态 | 规范 | 简述 |
|---|---|---|---|
| `MemoryPlugin` | P1 | [`plugins/memory.md`](plugins/memory.md) | 本地 `MEMORY.md` index、topic files、显式确认写入、本地检索。 |
| `DeterministicCompactPlugin` | P1 | [`plugins/deterministic-compact.md`](plugins/deterministic-compact.md) | 零模型/零网络、append-only 的结构化 session compaction。 |
| `ObservationalMemoryPlugin` | P3，默认关闭 | [`plugins/observational-memory.md`](plugins/observational-memory.md) | 可选 observer/reflector/dropper；必须明确数据发送、成本和 opt-in。 |

新增插件时必须：在 [`plugins/README.md`](plugins/README.md) 登记、编写独立规范、声明 context contribution/存储/网络/模型调用/信任边界，并在本表增加入口。

## 6. 原生项目指令：`AGENTS.md`

### 6.1 发现与排序

原生 `ProjectInstructionLoader` 从 workspace root 向文件系统根搜索：

```text
AGENTS.md
CLAUDE.md
.nju-agent/instructions.md
```

通用目录规则排在前，越接近 workspace 的规则排在后；同目录采用固定文件名优先级。loader 返回 path、content、size、scope root、trust 与截断信息。

要求：

- 只有 Project Trust 批准后才读取并注入项目文件；untrusted 时仅报告发现，不读入模型 context；
- 处理 UTF-8/BOM、上限与重复路径去重；
- 后续可支持 path-scoped rules，但 scope 不能由未读文件自行声明；
- 内容以 `[Project instruction; lower priority than host policy]` 标注，不能越权；
- 指令不应自动执行 shell、加载 npm 包、启用 MCP 或改变 permission mode。

### 6.2 用户级规则

用户级 `AGENTS.md` 可作为 host-configured、与项目无关的 stable instruction。其路径由启动配置指定，仓库不得反向指定；它仍低于 system/developer policy，并与 project instruction 分开标记。

## 7. 原生 Skills

### 7.1 发现与 trust

保留目录：

```text
<workspace>/.agents/skills/<name>/SKILL.md
<workspace>/.nju-agent/skills/<name>/SKILL.md
```

仅在 Project Trust 后扫描。P2 可增加 host-configured 的用户级只读 skill root。descriptor 至少包含 `name`、`description`、`path`、`trusted`、content hash、大小和发现 root。

### 7.2 渐进披露与加载

常规 context 只注入排序稳定的 catalog：

```text
- skill-name: short description
```

`load_skill(name)` 必须：

- 仅接受已注册名称，不接受任意 path；
- 有界读取 `SKILL.md` 并附来源/trust；
- 将内容当作低优先级 data/操作指南，不改变 tool permission；
- 只在当前 session 的 context state 生效；resume 时按当前 trust 重新验证；
- 将相对引用以 skill directory 解析，且继续经过普通 file tool、Project Trust 与 path policy。

frontmatter 格式错误、重名、过大或读取失败须可见，不得阻断其他 skill。

## 8. 安全、隐私与可观测性

### 8.1 Prompt injection

memory、summary、project instructions、skills、tool output、artifact 和 MCP 结果都必须有来源标签；只有 host system/developer prompt 是高优先级策略。尤其：

- 外部内容、工具输出和仓库文本不能触发插件安装、config 修改或持久化写入；
- memory/summary 跨 session 存在也不等于升级为可信指令；
- 所有派生存储沿用 secret redaction；
- 禁止将 `.env`、credential、token、私钥或未经批准的个人数据写入派生存储。

### 8.2 Telemetry 与诊断

记录最小必要元数据：plugin id/version、hook duration、contribution 字符数、budget omission、compact reason/stats 与错误 code。默认不得记录 memory 正文、prompt 正文或密钥。

统一状态接口：

```text
/context status  # 每项 contribution 的来源、预算、是否省略
```

各插件可增设自己的安全命令，必须写在独立插件规范中。TUI status bar 仅显示简短状态；大正文使用 Transcript 或文件读取。

## 9. 跨插件验收标准

实现任意 plugin 时至少证明：

- Project Trust 前，不读取/注入项目 instructions、project skills 或项目配置的插件资源；
- instruction、skills、plugin contribution、summary 的顺序、标签、预算稳定；
- plugin 异常/损坏时 session resume 和普通 run 可继续；
- 所有 contribution 能在 `/context status` 中说明来源、截断或省略；
- plugin content 不能改变 tool policy，也不能绕过 secret redaction；
- 存储、模型调用、网络访问和用户确认要求符合该插件独立规范。

## 10. 参考来源

- `Assignment.md`：要求自行实现 context/session 管理。
- `specs/03-permission-trust.md`、`specs/04-context-assembly.md`、`specs/05-session-persistence.md`：本项目的 trust、context 与 append-only session 基线。
- `refs/pi-minimal-doc/source/input-to-llm.md`、`architecture.md`、`compaction-and-branches.md`：Pi 的 context assembly、event layer 和 session/compaction 模型。
- `refs/pi/packages/coding-agent/docs/skills.md`：catalog-first skill progressive disclosure。
- 各插件的外部和本机参考材料见 [`plugins/README.md`](plugins/README.md)。
