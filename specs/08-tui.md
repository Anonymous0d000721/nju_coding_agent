# 08 TUI 与终端渲染 Spec

> 状态：设计规范。未获得明确“执行/实现”指令前，不继续改 TUI 代码。

## 1. 背景与参考结论

本 spec 基于本项目已有 CLI/streaming/session 能力，并参考 `refs/` 中的终端 Agent 设计：

- `refs/pi-minimal-doc/source/cli-to-tui.md`：Pi 将 CLI 入口、模式解析、runtime 工厂、InteractiveMode/TUI 严格分层；interactive 使用 raw mode、备用屏幕、bracketed paste、差分渲染和聚焦组件。
- `refs/pi/packages/coding-agent/README.md`：Pi 交互界面由启动 header、消息区、editor、footer 组成；`/model`、`/thinking`、`/resume` 打开选择器；非交互模式 `-p`/JSON/RPC 不弹交互 UI。
- `refs/pi/packages/coding-agent/docs/keybindings.md`：选择器与编辑器有独立键位域；`Enter` 提交/确认、`Esc` 取消或中断、`Ctrl+L` 选模型、`Shift+Tab` 循环 thinking、`Ctrl+T` 折叠 thinking、`Ctrl+O` 折叠工具输出。
- `refs/pi/packages/coding-agent/docs/tui.md`：UI 组件应只处理渲染与输入，不承担 agent loop；selector/confirm/input 是通用交互原语；overlay/picker 需要明确焦点和生命周期。
- `refs/pi/packages/coding-agent/src/core/agent-session.ts`：model 切换应重新计算/钳制 thinking level，并记录 model/thinking 变更；thinking level 是模型请求配置，不等同于“是否显示思考块”。
- `refs/hello-agents/.../cli_channel.py` 与 `cli/repl.py`：较简单 REPL 也遵循欢迎区、命令处理、流式文本、工具开始提示、错误兜底的最小交互模式。
- `refs/sjtu-agent/docs/AGENT_ARCHITECTURE.md`：TUI 属于 Harness/Observability 层，应服务于可靠 loop、权限和上下文质量，而不是把业务逻辑写进 UI。

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
| RPC | `--mode rpc` | 当前仍返回未实现 |

### 4.2 不变量

- TUI 只能在 interactive 模式启动。
- `--mode json` 不得输出 ANSI 控制符、状态栏、picker、流式 text delta 或 TUI frame。
- 单次 text/print 模式不进入 TUI；仍允许流式写 stdout。
- TUI 不解析 provider SSE；只消费 Runner 发出的统一事件。
- TUI 崩溃或渲染失败不得破坏 tool-call/tool-result 配对与 session 落盘。

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

第一版采用 regular mode，不要求 fullscreen/alternate screen；若 Ink 默认使用差分渲染即可，不自行实现 ANSI diff。

从上到下：

1. **Header**
   - 仅展示简洁 app/version 与 workspace 标识；不把运行状态塞在顶部。
2. **Transcript**
   - system notice、用户输入、assistant 流式文本、可选 reasoning、工具生命周期和错误；
   - 消息不得显示 `user`、`assistant`、`thinking` 等角色前缀；以不同背景色、边距和文字样式分组，形成类似 Pi/Claude Code/Codex 的视觉层级；
   - 用户消息使用一类强调背景；assistant 使用另一类中性背景；reasoning 在开启时使用低对比度背景；错误使用明显但可读的错误背景；
   - assistant、reasoning 与系统文本支持安全的终端 Markdown 渲染（标题、段落、强调、行内 code、code block、列表、引用、链接文本）；未知/不支持语法必须回退为原文，绝不输出原始 HTML 或不受控 ANSI。
3. **Widget area**
   - `/resume`、`/model`、`/effort`、`/reasoning` 的 picker；
   - 当 editor 当前文本以 `/` 开头且不存在 picker 时，显示 slash-command completion 菜单；
   - picker 或 completion 菜单打开时拥有键盘焦点。
4. **Editor**
   - 多行输入，必须有可见光标；
   - Enter 提交；使用 `Shift+Enter` 或 `Ctrl+J` 插入换行（最终选择一个并在 help 中固定）；
   - 运行中可先禁用提交或显示 busy，后续再做 message queue。
5. **Status bar（位于 editor 下方）**
   - workspace、api format、model、effort、session id 或 `(new)`、permission mode、reasoning display、run status；
   - 可附紧凑 key hint，如 `Enter send · Shift+Enter newline · Esc cancel`。

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
- `thinking_delta`：
  - `showReasoning=false`：不显示，但不影响 run；
  - `showReasoning=true`：追加到低对比度 reasoning item，并以 Markdown renderer 渲染；
  - 不持久化 UI-only 隐藏/展开状态。
- `done`：只用于结束当前 assistant item；不得重复显示完整文本。
- `tool_call`：在执行期间显示紧凑工具活动卡片（工具名和 running 状态）；默认不显示完整 arguments。
- `tool_result`：更新对应活动卡片为完成/失败的紧凑摘要；**run 完成后不得在 transcript 末尾额外追加工具调用结果总览或重复摘要**。
- tool 详细输出第一版不展开；后续可通过 `Ctrl+O` 或 item toggle 加。

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

### 9.2 resume picker

- 展示 `(new session)` 和最近 sessions；
- 当前 session 标注 `current`；
- 选中 session 后仅切换 session id，下一条 prompt 使用该 session 的历史；
- 若 session disabled，显示 `Sessions are disabled`，不打开空 picker。

后续可增强：显示 cwd、modified time、first message、message count、搜索过滤。

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
| PageUp/PageDown | 第一版可选；若实现则按页移动 |
| Enter | 确认选择 |
| Esc | 取消 picker，返回 editor |
| Ctrl+C | 取消 picker；若无 picker 且 editor 为空，退出或提示 |

Picker 取消不得改变模型/session/effort/reasoning 状态。

## 11. Editor 与 prompt history 输入规范

Editor 是多行文本编辑器，不得把输入简化为只会 append/backspace 的单行字符串。光标 offset 必须与文本状态独立保存并始终可见。

### 11.1 基础编辑

- 可输入普通文本、粘贴文本和换行；
- Left/Right：在同一行按字符移动光标；到行首/行尾时不得跳到其他 prompt；
- Backspace/Delete：删除光标前/后的字符；
- `Shift+Enter` 插入换行；`Enter` 提交当前 prompt；
- 输入 `/` 开头的内容时触发第 12 节命令补全；提交完整 slash command 后按第 9 节处理；
- running 时禁止提交，必须保留或明确提示当前 editor 内容。

### 11.2 Up/Down 与多行优先级

1. **多行 editor**：Up/Down 首先遵循普通编辑器行为，在相邻可视/逻辑行移动，并尽力保持同一 column；到首行/末行后才考虑 history。
2. **单行且有文字**：第一次 Up 将光标移至该行开头；第一次 Down 将光标移至该行末尾。只有光标已经在对应边界时，再切换 prompt history。
3. **空 editor**：Up/Down 直接切换 prompt history。
4. history 切换必须保存被替换前的草稿；从最新 history 再 Down 时恢复草稿或清空 editor。
5. history 只含已成功提交的普通 prompt；slash command、空白 prompt、以及失败前未提交的草稿不进入 history。

### 11.3 取消与恢复

- `Esc` 先关闭 picker/completion；无 overlay 时可中断当前 run；
- `Ctrl+C` 清空 editor，editor 已空时退出或显示二次确认提示；
- prompt history 与 editor 操作应由纯 reducer 覆盖测试，避免依赖真实 Ink raw-mode。

## 12. Slash command completion

当 editor 文本第一个字符为 `/` 且没有显式 picker 时，显示命令候选菜单。第一版采用**大小写不敏感前缀匹配**：例如 `/re` 匹配 `/resume` 与 `/reasoning`；没有匹配时隐藏菜单，不阻塞普通输入。

- 候选包含命令名和一行用途，至少覆盖第 9.1 节命令总表；
- completion 选中项必须有明显背景色；
- Up/Down 在 completion 打开时移动候选，不进入 editor/history 导航；
- Tab 或 Enter 接受选中候选，替换 editor 中的命令 token，并将光标置于命令末尾；
- Esc 关闭 completion，保留 editor 原文；
- 若用户继续输入参数，completion 可保留匹配命令或在第一个空格后关闭；第一版固定为第一个空格后关闭；
- 对 `/` 本身显示全部命令；命令列表从单一数据源导出，供 completion、`/help` 与命令解析共享，避免漂移。

## 13. 终端与渲染约束

- 终端宽度不足时，长文本必须换行或截断，不输出超过宽度的裸行；Ink 可承担基础换行。
- 样式不得跨行泄漏；每条消息独立渲染。
- 不打印 secret、API key、Authorization header；错误沿用 redaction。
- 运行中状态更新应节流或依赖 Ink 渲染调度，避免每 token 强制全屏刷屏。
- Windows Terminal 下避免默认依赖 `Alt+Enter` 等会与系统冲突的快捷键。

## 14. 与 session 的关系

- TUI transcript 是 session 的视图，不是 session 真源。
- 用户 prompt、assistant message、tool result、run start/end 仍由 runPrompt/Runner/session store 负责落盘。
- resume 后，状态栏 session id 立即更新；历史 transcript 第一版可以不回放，后续可加载最近消息摘要。
- model/effort 变更应作为 session change entry 记录；reasoning display 不必落盘。

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
12. `/resume`、`/model`、`/effort`、`/reasoning` 无参数打开 picker；
13. picker 支持 Up/Down、Enter、Esc；
14. `/thinking` 作为 `/reasoning` alias 可用；
15. `text_delta` 更新 assistant item，Markdown 内容正确渲染；
16. transcript 通过背景和样式区分内容，不显示 user/assistant/thinking 角色标签；
17. `thinking_delta` 默认隐藏，`/reasoning on` 后显示；
18. tool_call/tool_result 仅显示运行期紧凑卡片，run 结束后没有额外总览；
19. status 位于 editor 下方；
20. run 结束不重复渲染已流出的 assistant 文本。

建议测试层次：

- reducer/state transition 单元测试：事件渲染、picker select/cancel、slash command 解析；
- app 模式测试：JSON/text 不进入 TUI；interactive 调用 TUI；
- 必要时用 mock `runPrompt` 做 TUI smoke，而不是真实 API。

## 17. 实施顺序建议

等用户明确说“执行/实现”后，按以下顺序：

1. 若已有偏离本 spec 的 TUI WIP，先回滚或改到符合 spec；
2. 抽出 `runPrompt` 回调边界，保证 text/json 单次路径不变；
3. 新增纯状态 reducer，先测 command/picker/event、cursor、多行和 history；
4. 增加共享 slash-command 数据源、前缀 completion 与安全 Markdown renderer；
5. 新增 Ink 组件：Header、Markdown Transcript、Editor、Completion、Picker、位于 editor 下方的 StatusBar；
6. 接入 `runTui()` 到 interactive 模式；
6. 更新 help/README；
7. 跑完整验证。
