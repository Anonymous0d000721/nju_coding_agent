# 08 TUI 与终端渲染 Spec

> 状态：设计规范。未获得明确“执行/实现”指令前，不继续改 TUI 代码。

## 1. 背景与参考结论



核心结论：TUI 是交互 harness，不是 agent loop。它只负责输入、选择、状态展示、事件渲染和用户控制；模型调用、工具执行、权限、session 持久化必须继续由 App/Runner/Tool 层负责。

## 2. 目标

为 `nju-agent` 提供一个 Pi-like 的最小交互 TUI：

- 让用户在终端中进行多轮对话；
- 以流式方式观察 assistant 文本、可选 reasoning、工具调用和工具结果；
- 通过选择器完成 resume/model/effort/reasoning-display 等交互；
- 提供具备可见光标、光标移动、多行编辑和 prompt history 的编辑器；
- 使用背景色和 Markdown 渲染清晰区分 transcript 内容，而非显示 `user`、`assistant`、`thinking` 等角色标签；
- 在输入 `/` 时提供命令候选与键盘选择；
- 保持 `--print`、普通单次 prompt、JSON 模式的输出契约不变；
- 为后续审批 UI、session navigator、工具折叠、快捷键和主题预留稳定边界。

## 3. 非目标

第一版 TUI 不实现：

- 会话树、fork/clone、分支导航；
- 可配置 keybindings 文件；
- 鼠标、搜索、滚动条、复杂 diff/file-tree 渲染；
- 外部编辑器、文件 `@` 引用、路径补全；
- 完整审批 overlay；
- 后台任务、message queue/steering；
- theme/package/extension UI；
- TUI 内修改全局默认模型或全局默认 effort。

这些可以作为后续增强，但不能阻塞当前交互模式可用性。

## 4. 运行模式边界

### 4.1 模式选择

`createApp()` 应先解析 CLI 参数，再决定模式：

| 模式 | 触发 | UI 行为 |
|---|---|---|
| interactive TUI | 无 prompt，且非 `--mode json/rpc` | 启动 Ink TUI |
| text prompt | 有 prompt 或 `--print`，默认 text | 沿用现有 stdout 流式输出 |
| JSON | `--json` 或 `--mode json` | 只输出最终 JSON 对象/错误对象 |
| RPC | `--mode rpc` | 启动 stdin/stdout JSONL 长驻协议，不进入 TUI |

### 4.2 不变量

- TUI 只能在 interactive 模式启动。
- `--mode json` 不得输出 ANSI 控制符、状态栏、picker、流式 text delta 或 TUI frame。
- 单次 text/print 模式不进入 TUI；仍允许流式写 stdout。
- TUI 不解析 provider SSE；只消费 Runner 发出的统一事件。
- TUI 崩溃或渲染失败不得破坏 tool-call/tool-result 配对与 session 落盘。
- interactive UI、`runPrompt()` 与 Runner 必须共享明确的 run lifecycle；不得因流式运行期间输入第二条 prompt 而产生未跟踪的并发 run。

## 5. 架构边界

建议分层：

```text
CLI args / createApp
  ├─ text/json prompt path ── runPrompt()
  └─ interactive path ────── runTui()
                              ├─ TuiState / reducer
                              ├─ Editor / Picker / Transcript / StatusBar
                              └─ calls runPrompt(prompt, callbacks)

runPrompt()
  ├─ session open/create/append
  ├─ model client / tool registry / runner setup
  └─ AgentRunner.run(onStreamEvent)
```

TUI 可以持有界面状态，但不得持有或复制 agent loop 状态。所有真实状态变更必须通过现有服务完成：

- session 创建/恢复：`JsonlSessionStore`；
- prompt 执行：`runPrompt()`；
- model/effort：App 配置 + session change entry；
- 工具状态：`AgentStreamEvent`。

## 6. UI 布局

### 工具活动预览

TUI 必须渲染工具事件携带的 `preview`，不得重新解析原始工具参数或读取文件来拼装展示内容。默认预览上限为 8 行，可由 `NJU_AGENT_TOOL_PREVIEW_LINES` 配置（1–100）。`read_file` 展示路径和实际读取行范围；`write_file` 展示写入内容头部；`hashline_edit` 展示 unified diff；`run_command` 展示完整命令和输出头部；其他工具展示脱敏后的关键参数与结果摘要。超长单行应截断，敏感字段必须脱敏。

第一版采用 regular mode，不要求 fullscreen/alternate screen；若 Ink 默认使用差分渲染即可，不自行实现 ANSI diff。

布局的核心是连续阅读与直接输入，而不是堆叠多个带框 panel。除可选 Header 外，主区域从上到下必须严格为：

```text
Transcript
Editor
Widget Area
Status Bar
```

```text
[可选：单行、低干扰 Header]

Transcript（占据剩余的主要高度；无外框；底部留白）

┌────────────────────────────────────────────┐
│ Editor（唯一默认有外框的区域；无内部 padding）│
└────────────────────────────────────────────┘
Widget Area（按需出现；无外框、无 padding）
Status Bar（固定单行；无外框、无上下 padding）
```

### 6.1 区域顺序与尺寸

1. **可选 Header**
   - Header 位于四个主区域之前，不属于主交互布局；它只能是单行、低对比度的 app/version、workspace 与当前 session short id。
   - 仅在启动、切换 session 或发生明确状态变化时更新；不是大边框卡片，也不得重复 Status Bar 可展示的信息。
   - 窄终端按优先级截断 workspace，再截断 session id。P0 可省略 Header。
2. **Transcript**
   - 是默认占据剩余可用高度的主体区域；内容不足时不强制撑满视觉卡片。
   - 必须位于 Editor 之前，且自身**没有外框**、没有独立 panel 边界。
   - 作为连续阅读流呈现，不给每条 message、每个 tool call 或每个 delta 套完整边框/卡片。
   - 区域底部必须保留至少一行的视觉留白（bottom padding），使最后一条 transcript 内容不紧贴 Editor 边框；此留白属于 Transcript，不得以 Editor 的上内边距替代。
   - transcript 连续区的最大可见项目数、分页 marker 与滚动锚点由 state 管理；不得用 `slice(-N)` 静默丢弃 UI 已加载的会话历史。
3. **Editor**
   - 紧跟 Transcript，是唯一默认带稳定可见外框的主区域。
   - Editor **没有内部 padding**：输入首行/末行不应额外空出内容内边距；边框与终端 cell 的必要间隔由 renderer 的边框实现处理，不另叠加布局 padding。
   - 多行输入，必须有可见光标；Enter 提交；使用 `Shift+Enter` 或 `Ctrl+J` 插入换行（最终选择一个并在 help 中固定）。
   - 运行中可先禁用提交或显示 busy，后续再做 message queue。
4. **Widget Area**
   - 必须位于 Editor 下方、Status Bar 上方；不使用时高度为 0，不留下空白占位。
   - 无外框、无 padding；不得形成常驻 panel。
   - 用于 `/resume`、`/model`、`/effort`、`/reasoning` 的 picker，以及 editor 当前文本以 `/` 开头且不存在 picker 时的 slash-command completion 菜单。
   - picker 或 completion 菜单打开时拥有键盘焦点。
5. **Status Bar**
   - 固定在最下方，位于 Widget Area 下方。
   - 无外框、无上下 padding；默认恰好一行高。
   - 展示 workspace、api format、model、effort、session id 或 `(new)`、permission mode、reasoning display、run status；可附紧凑 key hint，如 `Enter send · Shift+Enter newline · Esc cancel`。
   - 宽度不足时按优先级裁剪信息，不允许换行为第二个 status panel。

### 6.2 Transcript 内容规则

- 用户 prompt、assistant 主文本、reasoning、tool activity、system notice 与 error 都属于同一个无框连续阅读流；语义分组优先使用留白、前景色、字重、缩进或左侧 marker，而不是卡片边框。
- 用户 prompt 文本允许换行、不显示冗余角色标签；相邻用户 prompt 不应合并。
- assistant 主文本为无背景的 Markdown 阅读内容，使用段落间距；不能把每个 token/delta 变成单独块。
- reasoning 关闭时不占行；开启时使用低对比度、斜体且可折叠的次级文本，不能与 assistant 正文或错误同色。
- tool execution 使用紧凑单行或少数多行活动记录；pending、success、error 使用语义前景色或 marker。正常 completion 默认只显示工具名、结果状态、耗时和必要修改摘要，不显示参数或完整输出。
- system/notice 使用低对比度文本而不是彩色大卡片；错误、权限拒绝、取消和模型中断使用不同的语义前景色与简短说明。
- assistant、reasoning 与系统文本支持安全的终端 Markdown 渲染（标题、段落、强调、行内 code、code block、列表、引用、链接文本）；未知/不支持语法必须回退为原文，绝不输出原始 HTML 或不受控 ANSI。

### 6.3 边框、padding 与背景色

边框和背景是稀缺的层级信号，默认克制使用：

| 区域/元素 | 外框 | Padding | 背景色 |
|---|---|---|---|
| Transcript | 禁止 | 仅底部保留视觉留白 | 默认无背景；若使用，必须覆盖完整语义区域。 |
| Editor | 必须 | 禁止内部 padding | 可为整个 Editor 使用统一背景，也可无背景。 |
| Widget Area | 禁止 | 禁止 | 默认无背景；picker/completion 可对完整菜单区域或完整选中行使用背景。 |
| Status Bar | 禁止 | 禁止上下 padding | 可为整个单行 Status Bar 使用统一背景，也可无背景。 |
| 单条 Transcript 文本 / 单个 token / 单个词 | 禁止 | 不适用 | 禁止单独使用背景色。 |

具体规则：

- 背景色只能施加到完整、连续的视觉区域：整个 Editor、整个 Status Bar、完整 widget/menu、完整 selected row，或确有完整语义边界的完整内容块。
- 不得只给单个文字、单个 token、命令名称、状态词或按钮词套背景色；禁止使用零碎的 `allow`、`deny`、`error` 等词级色块制造视觉噪声。
- 要强调状态时，优先使用前景色、bold、dim、underline、图标或左侧 marker；焦点优先通过完整选中行而不是 token 背景表达。
- 如果某区域不使用统一背景，就保持透明/终端默认背景；不得用碎片化背景色模拟层级。
- 所有颜色都必须在低色彩终端下降级为字重、文本或 marker，不能只依赖颜色传达 pending/success/error/focus 等状态。

### 6.4 运行中输入与取消

允许一个 active run，同时支持显式 queue 与 steering：

- `running` 时 editor 保留可编辑草稿；普通 `Enter` 将当前草稿加入显式 queue，不提交第二个独立 active run；
- `Ctrl+Enter` 将当前草稿作为 steering message，放入 Runner 的 steering 队列，并在下一次模型请求前注入；
- queue message 在当前模型回答结束后作为下一轮 user message 注入；必须保留顺序，不得静默丢弃；
- queue/steering 必须可视化显示 pending notice，且 run 结束、取消或出错时清理未投递项，不能泄漏到下一次独立 run；
- 没有 overlay/completion 时，`Esc` 对 active run 发出取消请求（经 `AbortController` / Runner cancellation）；取消优先级低于关闭 completion/picker；
- `Ctrl+C` 在 active run 中等价于取消，不得直接退出进程；空闲状态下才执行清空草稿或退出行为；
- 取消请求发出后禁止新增 queue/steering，直到当前 run 清理完毕并回到 `idle`；原有草稿和已显示 notice 必须保留；
- 被取消的 run 必须出现独立于 error 的 `cancelled`/`interrupted` notice，并让状态栏返回 idle；不得将 user cancellation 渲染为模型或工具错误。

## 7. UI 状态模型

```ts
type RunStatus = 'idle' | 'running' | 'error';
type PickerKind = 'resume' | 'model' | 'effort' | 'reasoning-display';

interface TuiState {
  sessionId?: string;
  workspaceRoot: string;
  apiFormat: 'openai-chat' | 'openai-responses' | 'anthropic';
  model: string;
  effort: ThinkingLevel;
  permissionMode: PermissionMode;
  showReasoning: boolean;
  status: RunStatus;
  /** 当前 run 的取消请求已发出但尚未完成清理时为 true。 */
  cancelling?: boolean;
  transcript: TuiTranscriptItem[];
  editor: {
    text: string;
    cursorOffset: number;
    disabled: boolean;
    history: string[];
    historyIndex?: number;
  };
  picker?:
    kind: PickerKind;
    title: string;
    options: PickerOption[];
    selectedIndex: number;
  };
}

interface PickerOption {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}
```

`showReasoning` 是显示开关；`effort` 是发送给模型的 reasoning/thinking 强度。二者必须在命名和状态栏中区分。

## 8. 事件渲染规范

TUI 消费 `AgentStreamEvent`：

```ts
type AgentStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'done'; turn: AssistantTurn }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; result: ToolResult };
```

渲染规则：

- `text_delta`：追加到当前 assistant item；没有则新建 assistant item；以 Markdown renderer 渲染。
- cancellation 完成：追加或更新为独立 cancelled/interrupted notice，不将已接收的 assistant 文本或已有工具卡片删除、伪造为 error，且不得追加重复的最终 assistant 文本。
- `thinking_delta`：
  - `showReasoning=false`：不显示，但不影响 run；
  - `showReasoning=true`：追加到低对比度 reasoning item，并以 Markdown renderer 渲染；
  - 不持久化 UI-only 隐藏/展开状态。
- `done`：只用于结束当前 assistant item；不得重复显示完整文本。
- `tool_call`：在执行期间显示紧凑工具活动卡片（工具名和 running 状态）；默认不显示完整 arguments。
- `tool_result`：更新对应活动卡片为完成/失败的紧凑摘要；**run 完成后不得在 transcript 末尾额外追加工具调用结果总览或重复摘要**。
- tool 默认只显示统一 preview；`Ctrl+O` 展开或折叠最近一个已有结果的工具详情，详情仍必须经过脱敏与长度限制。

## 9. Slash command 语义

### 9.1 命令总表

| 命令 | 无参数行为 | 带参数行为 |
|---|---|---|
| `/help` | 显示帮助摘要 | 不需要参数 |
| `/session` | 显示当前 session/model/effort/reasoning/permission | 不需要参数 |
| `/new` | 清空当前 session id；下一条 prompt 创建新 session | 不需要参数 |
| `/sessions` | 列出 sessions 文本摘要 | 不需要参数 |
| `/resume` | 打开 session picker | `/resume <id>` 直接切换 |
| `/model` | 打开 model picker | `/model <id>` 直接切换当前模型 |
| `/effort` | 打开 effort picker | `/effort <level>` 设置 thinking effort |
| `/reasoning` | 打开 reasoning display picker | `/reasoning on|off` 设置显示开关 |
| `/thinking` | `/reasoning` 的兼容 alias | `/thinking on|off` 同 alias |
| `/compact` | 显示未实现说明 | 可暂不处理参数 |
| `/quit` `/exit` | 退出 TUI | 不需要参数 |

### 9.2 resume picker 与 transcript hydration

`/resume` 不是只替换 `sessionId` 的配置操作；确认一个 session 后，TUI 必须将其历史变为可阅读的 transcript 视图，并且保持 Runner 的 session history 与显示 history 使用同一个 session source。

- picker 首屏可使用轻量 `SessionSummary`，至少包含：short id、最近修改时间、消息数、首条用户消息的安全单行摘要，以及 current 标识；不得为了展示列表同步读取每份完整 JSONL。
- 选择后立刻清空旧 session 的 transient UI 项（streaming assistant、pending tool、旧 error）；保留 editor 草稿、model/effort/reasoning display 和 picker 返回语义。
- 进入 `hydrating` 状态：状态栏明确显示 `loading session history`，transcript 可先显示 loading placeholder；加载期间不得接受 prompt submit，`Esc` 必须取消 hydration 并恢复选择前的 session/transcript/editor 状态。
- 首页必须加载**最近且完整的 N 个可渲染 transcript items**（建议默认 80，范围 50–100），并按时间正序显示。该预算按 render item 而不是 JSONL line 计算，以免 tool call/result 或 metadata 挤掉所有对话。
- hydration 必须从 JSONL 解析 user、assistant、tool lifecycle、run notice、model/thinking changes；只影响 LLM context 的 entry 与只影响 UI 的 entry 必须明确区分。不得从 event 字段、工具输出或未知 JSON 中执行任何内容。
- 历史 assistant/tool 内容必须沿用当前 Markdown、tool-card 与 redaction 规则。历史 reasoning 仅在 session 确实持久化它且 `showReasoning=true` 时显示；缺失 reasoning 不得伪造。
- 首页之前仍有记录时，在 transcript 顶部显示紧凑的 `Load earlier history` marker，而不是静默截断。激活后以 cursor/line-offset 加载紧邻的更早一页，去重后追加到顶部，并保持用户当前阅读锚点不跳动。
- `PageUp`/`PageDown` 只移动显示窗口，不删除已加载消息；加载更早页面后保留当前阅读位置，避免回到最新消息。
- 分页中每次只允许一个 request；重复触发、过期 request、切换 session 或退出 TUI 后返回的结果必须丢弃。分页完成时 marker 变为 `Beginning of session`；空 session 显示明确 empty state。
- JSONL 读取失败、解析失败、损坏尾行、权限错误或 session 不存在时，保留已有的成功页和 editor，显示可读 error notice；不得清空为新 session、不得使 TUI 崩溃。损坏尾行可忽略并报告已恢复到最后一条合法 entry；中间损坏必须报告 session unreadable 并允许返回 picker。
- hydration 成功后才提交新的 active `sessionId`；若失败或被取消，应原子恢复此前选择的 session、transcript 和 status，避免 status 与实际 Runner history 不一致。
- `/resume <id>` 与 picker 选择必须共享同一 hydration action 和错误路径；不能保留一个只改 id 的 fast path。

后续可增强搜索、按 workspace/branch 分组、命名、tree/fork/clone，但不得替代本节的首屏 history 与降级语义。

### 9.3 model picker

第一版没有完整模型 catalog，因此 model picker 的来源：

1. 当前模型；
2. 配置/环境中的 model；
3. 按 api format 提供少量常见候选；
4. 后续再接模型目录或 `--models` scoped list。

语义：

- 选择模型只影响当前进程/当前 TUI session；
- 必须追加 model change session entry（如果项目已实现该 entry）；
- model 切换后 effort 必须重新 clamp 到当前 thinking map；
- 不隐式修改全局默认模型。

### 9.4 effort picker

- 候选为 provider-neutral levels：`off,minimal,low,medium,high,xhigh,max`；
- `NJU_AGENT_THINKING_LEVEL_MAP` 中值为 `null` 的 level 不可选或隐藏；第一版可直接隐藏；
- 选中后更新当前 config thinking level；
- 若 session 已存在，追加 `thinking_level_change`；
- 不改变 reasoning display 开关。

### 9.5 reasoning display picker

- 替代原 `/thinking` 的 UI 文案，避免和 effort 混淆；
- 候选：`on` / `off`；
- 只影响 TUI 是否显示 `thinking_delta`；
- 不改变请求中的 `ThinkingConfig.level`；
- `/thinking` 保留 alias，但 help 和状态栏优先显示 `reasoning display`。

## 10. Picker 输入规范

Picker 打开时拥有焦点：

| Key | 行为 |
|---|---|
| Up/Down | 移动选中项 |
| PageUp/PageDown | Transcript 按页向前/向后移动；到达已加载历史边界时 PageUp 加载更早页面 |
| Enter | 确认选择 |
| Esc | 取消 picker，返回 editor |
| Ctrl+C | 取消 picker；若无 picker 且 editor 为空，退出或提示 |

Picker 取消不得改变模型/session/effort/reasoning 状态。

## 11. Editor 与 prompt history 输入规范

Editor 是多行文本编辑器，不得把输入简化为只会 append/backspace 的单行字符串。光标 offset 必须与文本状态独立保存并始终可见。

### 11.1 基础编辑

- 可输入普通文本、粘贴文本和换行；
- 文本操作中的“字符”一律指 Unicode grapheme cluster：Left/Right、Backspace/Delete 不得将组合字符、emoji 或 ZWJ 序列截断；
- editor 必须以终端显示列而非 UTF-16 offset 计算布局。CJK 宽字符、emoji、combining mark 和窄终端下的软换行都必须使可见光标落在正确 visual column；
- Left/Right：在同一逻辑行按 grapheme cluster 移动光标；到行首/行尾时不得跳到其他 prompt；
- Backspace/Delete：删除光标前/后的一个 grapheme cluster；
- `Shift+Enter` 插入换行，`Ctrl+J` 是所有受支持终端中的必备换行后备键；若终端不能可靠区分 `Shift+Enter`，它不得意外提交 prompt；`Enter` 提交当前 prompt；
- 输入 `/` 开头的内容时触发第 12 节命令补全；提交完整 slash command 后按第 9 节处理；
- running 时禁止提交，必须保留或明确提示当前 editor 内容。

### 11.2 Up/Down 与多行优先级

1. **多行 editor**：Up/Down 首先遵循普通编辑器行为，在相邻 visual line（包含软换行）移动，并尽力保持同一显示列；到首个/最后一个 visual line 后才考虑 history。
2. **单行且有文字**：第一次 Up 将光标移至该行开头；第一次 Down 将光标移至该行末尾。只有光标已经在对应边界时，再切换 prompt history。
3. **空 editor**：Up/Down 直接切换 prompt history。
4. history 切换必须保存被替换前的草稿；从最新 history 再 Down 时恢复草稿或清空 editor。
5. history 只含已成功提交的普通 prompt；slash command、空白 prompt、以及失败前未提交的草稿不进入 history。

### 11.3 Paste 与输入协议

- 支持 bracketed paste（`ESC[200~` 至 `ESC[201~`）：必须先缓冲完整 payload，再作为一次原子 editor insertion；不得将 payload 内的 Enter、`/` 或控制序列解释为提交、slash completion 或快捷键；
- 终端不支持 bracketed paste 时，降级为普通文本输入，不得崩溃；
- 必须规定并实现单次 inline paste 上限。超过上限时，安全截断或替换为可见占位提示；不得造成无界内存增长、逐字符重绘风暴或意外提交；
- pasted 内容（包括多行 slash-like 文本与 escape-like 文本）只能在用户随后显式按下提交键时才会被当作 prompt/command 处理。

### 11.4 取消与恢复

- `Esc` 先关闭 picker/completion；无 overlay 时按第 6.1 节中断 active run；
- `Ctrl+C` 清空 editor，editor 已空时退出或显示二次确认提示；
- prompt history 与 editor 操作应由纯 reducer 覆盖测试，避免依赖真实 Ink raw-mode。

## 12. Slash command completion

当 editor 文本第一个字符为 `/` 且没有显式 picker 时，显示命令候选菜单。第一版采用**大小写不敏感前缀匹配**：例如 `/re` 匹配 `/resume` 与 `/reasoning`；没有匹配时隐藏菜单，不阻塞普通输入。

- 候选包含命令名和一行用途，至少覆盖第 9.1 节命令总表；
- completion 选中项必须以完整选中行的明显背景色表达焦点；不得只给候选命令中的单个词加背景色；
- Up/Down 在 completion 打开时移动候选，不进入 editor/history 导航；
- Tab 或 Enter 接受选中候选，替换 editor 中的命令 token，并将光标置于命令末尾；
- Esc 关闭 completion，保留 editor 原文；
- 若用户继续输入参数，completion 可保留匹配命令或在第一个空格后关闭；第一版固定为第一个空格后关闭；
- 对 `/` 本身显示全部命令；命令列表从单一数据源导出，供 completion、`/help` 与命令解析共享，避免漂移。

## 13. 终端、焦点与渲染约束

- 每次渲染产生的每一条 visual line（包括 Markdown、status、completion 描述、错误和工具卡片）去除 ANSI 后的显示宽度必须 `<=` 当前 terminal cell width；宽度不足时换行或截断，绝不输出超宽裸行；
- terminal resize 后必须重新计算软换行、cursor visual location、picker/completion 可见区域与选中索引；不得丢失 editor text、草稿或 session 状态；
- 样式不得跨行泄漏；每条消息独立渲染并 reset styling。Markdown 渲染与截断必须 ANSI-aware；
- editor、completion 与 picker 的焦点必须互斥，任意时刻只能有一个键盘输入 owner；关闭 overlay/completion 必须恢复 editor focus 和 visible cursor；
- 必须支持可见 hardware cursor；在支持的终端中应将其位置与 editor cursor 同步，以便 CJK IME 候选窗定位。若能力不可用，降级为软件光标但不得隐藏输入位置；
- 终端不支持 bracketed paste、enhanced keyboard 或 modified Enter 时必须平稳降级，且 `Ctrl+J` 始终可插入换行；
- 不打印 secret、API key、Authorization header；错误沿用 redaction。
- 运行中状态更新应节流或依赖 Ink 渲染调度，避免每 token 强制全屏刷屏。
- Windows Terminal 下避免默认依赖 `Alt+Enter` 等会与系统冲突的快捷键。

## 14. 与 session 的关系

- TUI transcript 是 session 的可重建视图，不是 session 真源；但 **恢复 session 后必须 hydration 最近历史**，具体规则见第 9.2 节。
- 用户 prompt、assistant message、tool result、run start/end 仍由 runPrompt/Runner/session store 负责落盘；UI 不能将纯展示状态反写成新的消息 entry。
- `SessionStore` 需暴露或新增只读、分页、可取消的 display-history 查询边界。该边界返回经过 schema 校验的 session entries、`hasMore` 和 next cursor；它不允许 TUI 直接读取任意路径或自行解释未验证 JSONL。
- status 中的 session id 只有在 hydration 成功后才更新；显示的历史、`runPrompt()` 传入的 restored context、以及 active session id 必须对应同一 revision/session。
- model/effort 变更应作为 session change entry 记录；reasoning display 不必落盘。
- session history 的显示预算与送入模型的 context budget 是两个独立限制：UI 可分页浏览完整本地历史，Runner 仍按 context policy 裁剪模型请求；不得从 UI 截断推断 context 截断。

## 15. 错误处理

- 缺 API key：interactive 启动前返回现有 missing-auth 文本错误，不进入 TUI。
- picker 数据加载失败：在 transcript 添加 error item，保持 TUI 可继续使用。
- runPrompt 返回 stderr：显示 error item。
- runPrompt 抛异常：显示脱敏 error item，状态变为 error；下一条输入可继续。
- 用户取消 picker：只关闭 picker，不显示 error。

## 16. 测试与验收

实现后必须满足：

1. `npm run typecheck` 通过；
2. `npm test -- --run` 通过；
3. `npm run build` 通过；
4. `git diff --check` 无 whitespace error（允许 Windows LF/CRLF warning）；
5. `nju-agent --help` 文档中区分 `/effort` 与 `/reasoning`；
6. `nju-agent --mode json "hi"` 不输出 TUI frame/ANSI/picker；
7. 有 prompt 的 text 模式仍流式输出，不进入 TUI；
8. 无 prompt 时进入 TUI；
9. editor 显示光标，Left/Right、Backspace/Delete、提交和多行编辑符合第 11 节；
10. Up/Down 的多行、边界和 prompt-history 优先级符合第 11.2 节；
11. `/`、`/re` 和无匹配命令分别显示全部、前缀匹配和空的 completion 状态；completion 支持 Up/Down、Tab/Enter、Esc；
12. `/resume`、`/resume <id>`、`/model`、`/effort`、`/reasoning` 无参数分别遵循 picker/统一 action 语义；
13. picker 支持 Up/Down、Enter、Esc；
14. `/thinking` 作为 `/reasoning` alias 可用；
15. 选择有历史的 session 后，TUI 在不调用模型的情况下显示最近完整 history page，顺序、Markdown、tool cards 和已有 redaction 与 live transcript 一致；`/resume <id>` 与 picker 行为一致；
16. 有更早 history 时显示可操作的 pagination marker；加载前页后不重复、不跳动 editor、不会覆盖较新的 transcript；
17. history hydration 的 missing/corrupt/permission/abort 情形保留已有成功内容或恢复前一 session，并给出可读 notice；
18. `text_delta` 更新 assistant item，Markdown 内容正确渲染；
19. transcript 采用连续阅读层级：用户强调块、assistant 主阅读区、低对比 reasoning、状态化 tool activity、轻量 notices；不得将每条消息都渲染为同质化全边框卡片，也不得显示 user/assistant/thinking 角色标签；
20. `thinking_delta` 默认隐藏，`/reasoning on` 后显示；
21. tool_call/tool_result 仅显示运行期紧凑卡片，run 结束后没有额外总览；
22. status 位于 editor 下方；
23. run 结束不重复渲染已流出的 assistant 文本；
24. running 时第二条 prompt 不会被提交、隐式排队或丢弃；Esc 遵循 overlay-first 优先级，取消后保留草稿并显示 cancelled/interrupted notice；
25. 组合字符、emoji/ZWJ、CJK 宽字符、软换行与窄终端下的移动/删除/光标位置正确；
26. bracketed-paste 多行 slash-like 内容、escape-like 内容及超过上限的 paste 不会触发提交/命令，且行为受限、可见；
27. width 为 20/40 及 resize 后，所有 visual line 均不超宽，editor 文本与 picker/completion 状态仍有效；
28. 至少在 Windows Terminal 和一个不支持 Kitty/enhanced keyboard 的基础终端完成 smoke；Shift+Enter 不可用时 Ctrl+J 可稳定换行，IME/软件光标始终可见。

建议测试层次：

- reducer/state transition 单元测试：事件渲染、picker select/cancel、slash command 解析；
- app 模式测试：JSON/text 不进入 TUI；interactive 调用 TUI；
- 必要时用 mock `runPrompt` 做 TUI smoke，而不是真实 API。

## 17. 后续增强边界

以下仍为明确的 v1 非目标，但为避免未来破坏性重构，后续设计必须沿用稳定 action/状态边界：

- **可配置快捷键**：采用 namespaced action id、一个 action 可绑定多个键，并声明 editor、completion、picker、global shortcut 的冲突优先级；
- **fullscreen transcript**：若引入 alternate screen，必须固定 editor dock，定义 transcript scroll focus、PageUp/PageDown/Home/End、搜索及恢复滚动位置；v1 继续使用终端原生 scrollback；
- **message queue / steering**：必须有显式 pending 项、delivery 时机、取消/恢复/重排规则及 session 语义；
- **扩展 completion**：后续可接异步 command/参数/path/`@` provider，但应有 debounce、AbortSignal、陈旧请求丢弃和按 cursor 位置替换的契约；
- **附件与外部 editor**：引入 clipboard image/file 或外部编辑器前，先定义 provider/session attachment contract、清理策略、权限及敏感信息处理；
- **会话树与 compaction**：tree/fork/clone/rename/delete、真实 `/compact` 及其 lifecycle 必须与第 6.1 节的 active-run 输入规则一致。

## 18. 实施顺序建议

等用户明确说“执行/实现”后，按以下顺序：

1. 若已有偏离本 spec 的 TUI WIP，先回滚或改到符合 spec；
2. 抽出 `runPrompt` 回调边界，保证 text/json 单次路径不变；
3. 新增纯状态 reducer，先测 command/picker/event、cursor、多行和 history；
4. 增加共享 slash-command 数据源、前缀 completion 与安全 Markdown renderer；
5. 新增 Ink 组件：Header、Markdown Transcript、Editor、Completion、Picker、位于 editor 下方的 StatusBar；
6. 接入 `runTui()` 到 interactive 模式；
6. 更新 help/README；
7. 跑完整验证。