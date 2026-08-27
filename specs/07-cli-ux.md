# Spec 07：CLI、机器可读模式与集成协议

## 1. 目的

本规范约束 coding agent 的命令行入口、运行模式、机器可读输出、JSON-RPC 子进程集成、ACP 兼容方向、slash commands、渲染方式和退出行为。

第一版交付应优先做可靠的行式 CLI 和可测试的机器可读事件输出。全屏 TUI 是可选增强，不应早于正确的 agent loop、工具协议、session store 和基础 CLI/RPC 边界。

## 2. 参考来源

- `Assignment.md`：提交物包含可运行 README 和 2 分钟以内演示视频；CLI 必须易运行、易讲解。
- `refs/pi-minimal-doc/source/cli-to-tui.md`：Pi 从 `cli.ts` 启动，解析参数、解析 `text/json/rpc` mode、处理 project trust、创建 runtime services，再进入对应 mode。
- `refs/pi-minimal-doc/source/input-to-llm.md`：用户输入先经过 slash commands 和 session prompt handling，再进入 agent loop。
- `refs/pi-minimal-doc/source/trust-and-auth.md`：非交互模式不弹 trust prompt，project trust 影响项目资源加载。
- `refs/pi/packages/coding-agent/README.md`：Pi 支持 `--mode json` 输出 JSONL events，支持 `--mode rpc` 做进程集成。
- `refs/pi/packages/coding-agent/docs/json.md`：JSON event mode 用于机器可读事件流。
- `refs/pi/packages/coding-agent/docs/rpc.md`：RPC mode 通过 stdin/stdout JSONL 协议做长期子进程集成。
- Agent Client Protocol：ACP 是面向编辑器/IDE 与 coding agent 的 JSON-RPC 2.0 标准协议，stdio 是优先传输方式之一。

## 3. 分阶段运行模式

推荐分阶段：

```text
P0：text interactive / print / json event
P1：JSON-RPC mode over stdio
P2：ACP-compatible adapter 或 --mode acp
```

原因：

- `print` 适合最小 demo；
- `json event` 适合测试、CI、脚本集成和录制运行轨迹；
- `rpc` 适合 Web UI、TUI wrapper、IDE 插件等长期进程集成；
- ACP 是更标准的 editor-agent 协议，应作为兼容目标，但不必阻塞 P0 MVP。

## 4. Text / Interactive mode

stdin 是 TTY 且未指定 `--print` / `--mode json` / `--mode rpc` 时默认进入：

```bash
nju-agent
```

行为：

- 展示当前 workspace、model、session 和 permission mode；
- 接受单行或多行输入；
- 本地处理 slash commands；
- 展示 assistant text、tool calls、错误和最终状态；
- P0 默认 YOLO，不展示逐次工具审批；
- 支持 Ctrl+C 取消当前 run。

## 5. Print mode

单 prompt 人类可读模式：

```bash
nju-agent --print "explain this repo"
nju-agent -p "fix the failing test"
```

行为：

- 执行一个任务；
- 输出人类可读 final answer 和必要工具进度；
- 任务结束后退出；
- fatal runtime error 返回非 0 exit code；
- 不等待交互输入；
- P0 默认 YOLO 工具执行，但 Project Trust 的非交互规则仍生效。

## 6. JSON Event mode

机器可读单 prompt 模式：

```bash
nju-agent --mode json "explain this repo"
nju-agent --json "explain this repo"
```

行为：

- 执行一个 prompt 后退出；
- stdout 只输出 JSONL events，每行一个合法 JSON；
- stderr 可输出启动诊断、警告和人类可读错误，但不得污染 stdout JSONL；
- 事件 schema 应复用 `specs/06-telemetry.md` 的 run event schema；
- 事件必须有 `runId` / `sessionId` / timestamp 等 correlation metadata；
- payload 必须有界且经过 redaction；
- 缺少 auth、非法参数、fatal error 也应尽量输出结构化 `run_error` / `run_end` 事件，然后以非 0 exit code 退出。

示例：

```jsonl
{"type":"run_start","runId":"r1","sessionId":"s1","timestamp":"...","level":"info","data":{"mode":"json"}}
{"type":"message_delta","runId":"r1","timestamp":"...","level":"info","data":{"text":"I'll inspect the project."}}
{"type":"tool_call_start","runId":"r1","timestamp":"...","level":"info","data":{"tool":"read_file","argsPreview":"package.json"}}
{"type":"tool_result","runId":"r1","timestamp":"...","level":"info","data":{"tool":"read_file","status":"ok","elapsedMs":12}}
{"type":"run_end","runId":"r1","timestamp":"...","level":"info","data":{"status":"success"}}
```

P0 必须实现 JSON event mode，因为它能让测试断言 agent 行为，而不依赖 terminal renderer。

## 7. JSON-RPC mode

长期子进程集成模式：

```bash
nju-agent --mode rpc
nju-agent --rpc
```

用途：

- Web UI；
- TUI wrapper；
- IDE/editor 插件；
- 自动化控制器；
- 需要多次 prompt、cancel、resume、session inspection 的上层程序。

P1 推荐实现 JSON-RPC 风格协议，使用 stdin/stdout JSONL framing：

- stdin：客户端发送 request / notification；
- stdout：agent 发送 response / event notification；
- stderr：只放诊断日志，不放协议消息；
- 每行一个 JSON object；
- request 必须带 `id`；
- notification 不带 `id`；
- 错误使用 JSON-RPC 风格 `{ code, message, data? }`。

示例 request：

```json
{"jsonrpc":"2.0","id":"1","method":"session/new","params":{"cwd":"D:/repo"}}
```

示例 response：

```json
{"jsonrpc":"2.0","id":"1","result":{"sessionId":"s1"}}
```

示例 prompt：

```json
{"jsonrpc":"2.0","id":"2","method":"prompt","params":{"text":"fix failing test"}}
```

示例 event notification：

```json
{"jsonrpc":"2.0","method":"event","params":{"type":"tool_call_start","runId":"r1","data":{"tool":"run_command"}}}
```

P1 最小方法集：

| Method | 作用 |
|---|---|
| `initialize` | 协商协议版本和客户端能力。 |
| `session/new` | 创建 session。 |
| `session/resume` | 恢复 session。 |
| `session/state` | 获取当前 session/run 状态。 |
| `prompt` | 发送用户 prompt 并启动/排队 run。 |
| `cancel` | 取消当前或指定 run。 |
| `slash` | 执行宿主 slash command。 |
| `shutdown` | 干净关闭子进程。 |

P1 最小 event 集合应覆盖 `specs/06-telemetry.md` 的 run/model/tool lifecycle，并额外支持：

- `message_delta`；
- `message_end`；
- `session_updated`；
- `approval_required`，仅 strict/confirm 模式或未来交互策略使用；
- `error`。

RPC mode 与 JSON event mode 的区别：

| 模式 | 生命周期 | 输入 | 输出 | 用途 |
|---|---|---|---|---|
| `json` | 单 prompt 后退出 | CLI prompt / piped input | JSONL events | 测试、CI、脚本 |
| `rpc` | 长期子进程 | JSON-RPC requests | responses + event notifications | Web/TUI/IDE 集成 |

## 8. ACP-compatible mode / adapter

ACP 是面向编辑器/IDE 与 coding agent 的标准协议方向，基于 JSON-RPC 2.0，常用 stdio 传输。

本项目 P2 可以选择两种方式之一：

```text
方式 A：提供 --mode acp，直接作为 ACP server 运行。
方式 B：提供 adapter，把内部 JSON-RPC 映射到 ACP。
```

设计内部 JSON-RPC 时应尽量避免与 ACP 冲突：

- 使用 JSON-RPC 2.0 风格 envelope；
- 保留 initialize/capabilities 协商；
- session、prompt、cancel、event 使用清晰 method/event 命名；
- 文件上下文、编辑器状态、approval UI 不写死为 terminal-only；
- 错误结构接近 JSON-RPC；
- stdio transport 保持 stdout 协议纯净。

P2 ACP 兼容目标：

- 能被支持 ACP 的编辑器或 adapter 识别；
- 能接收用户 prompt；
- 能流式发送 assistant/tool events；
- 能报告 session/run 状态；
- 能处理 cancel/shutdown；
- 权限/审批事件能映射到客户端 UI。

ACP 不阻塞 P0/P1，但 spec 应把它作为长期集成规范方向。

## 9. Help/version

```bash
nju-agent --help
nju-agent --version
```

不得要求 API key。

`--help` 至少展示：

- `--mode <text|json|rpc>`；
- `--print` / `-p`；
- `--json`；
- `--rpc`；
- `--cwd`；
- model/auth 参数；
- session 参数；
- Project Trust override 参数。

## 10. CLI 参数

推荐参数：

- `--mode <text|json|rpc>`：运行模式，默认 `text`；
- `--print <prompt>` / `-p <prompt>`：单 prompt 人类可读输出；
- `--json`：`--mode json` 简写；
- `--rpc`：`--mode rpc` 简写；
- `--model <id>`：覆盖模型；
- `--base-url <url>`：覆盖 OpenAI-compatible base URL；
- `--api-key-env <name>`：API key 环境变量名，默认 `NJU_AGENT_API_KEY`；
- `--cwd <path>`：workspace root；
- `--session <id>`：恢复指定 session；
- `--no-session`：不持久化对话；
- `--permission-mode <yolo|strict|confirm>`：权限模式，P0 默认 `yolo`；
- `--approve`：本次运行 trust 当前 workspace 的项目本地资源；
- `--no-approve`：本次运行不 trust 当前 workspace 的项目本地资源；
- `--telemetry <off|normal|debug>`。

推荐路径中不要接受 raw API key 作为命令行参数，因为进程列表可能泄露。

参数约束：

- `--mode rpc` 不接受 positional prompt；stdin/stdout 保留给协议；
- `--mode json` 可以接受 positional prompt 或 piped prompt；
- `--print` 与 `--mode rpc` 互斥；
- `--json` 与 `--rpc` 互斥；
- stdout 在 `json` / `rpc` 下必须保持协议纯净。

## 11. Slash Commands

P0/P1 slash commands：

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令和配置提示。 |
| `/quit` | 干净退出。 |
| `/new` | 开启新 session。 |
| `/sessions` | 列出最近 sessions。 |
| `/resume [id]` | 恢复 session。 |
| `/session` | 显示当前 session 元数据。 |
| `/model [id]` | 查看或切换模型。 |
| `/compact` | 手动触发压缩，如果已实现。 |
| `/trust` | 查看或修改 project trust。 |
| `/clear` | 清屏/display，不等于删除 session history，除非明确说明。 |

Slash command 是宿主命令，不应直接发送给模型；除非用户明确转义。

RPC mode 中 slash command 应通过 `slash` method 表达，而不是要求客户端模拟 terminal 输入。

## 12. 渲染要求

行式 renderer 应展示：

- 用户输入边界；
- 可选流式 assistant text；
- tool call start：工具名和简短 args preview；
- tool result：成功/失败、耗时、输出 preview；
- 截断/artifact 提示；
- run end summary。

P0 默认 YOLO，因此不要求展示逐次工具审批提示。若 P1/P2 启用 strict/confirm，则 renderer 再展示 approval UI。

示例：

```text
> fix the failing test

assistant: I'll inspect the project first.

tool read_file(package.json) ... ok 12ms
tool run_command(npm test) ... failed exit=1 2.3s

assistant: The failure is caused by ...
```

不得打印密钥。命令 preview 和输出都应经过 redaction。

## 13. 审批交互

P0 不要求实现逐次审批。

P1/P2 当 policy 返回 `ask` 时，CLI/TUI/Web 必须展示：

- operation/tool；
- target path 或 command；
- risk reason；
- 文件写入/编辑时的 diff preview；
- 选项：allow once、deny、可选 allow similar this session。

Print/json 非交互模式下不得卡住等待输入。若 strict/confirm 模式需要审批但没有 UI，应返回结构化 `approval_required` 错误或事件。

## 14. Auth Guidance

如果缺少 API key 或 model 配置，显示短而可操作的提示：

```text
Missing API key.
Set NJU_AGENT_API_KEY, NJU_AGENT_BASE_URL, and NJU_AGENT_MODEL.
See .env.example.
```

不得回显已有环境变量值。

JSON/RPC mode 中 auth error 也必须结构化输出，同时 stderr 可给人类可读提示。

## 15. Exit Codes

推荐：

- `0`：成功 final answer 或干净 `/quit` / `shutdown`；
- `1`：fatal runtime/config error；
- `2`：非法 CLI 参数；
- `3`：model/auth error；
- `4`：任务因预算/限制停止；
- `130`：用户中断。

RPC mode 下单个 request 失败不应直接退出进程；只有 fatal protocol/runtime error 或 `shutdown` 才退出。

## 16. Rich TUI 可选边界

核心稳定后可考虑全屏 TUI。

可增强：

- raw-mode editor；
- status bar；
- 可折叠 tool outputs；
- session list picker；
- `@path` completion；
- trust selector；
- approval cards。

TUI 不得改变 agent-loop 语义。CLI/print/json/rpc mode 必须保留，便于测试、脚本集成和演示。

## 17. README / Demo 约束

CLI 必须支持适合作业的 fresh-checkout 流程：

1. 安装依赖；
2. 复制 `.env.example` 或 export env vars；
3. 运行 `npm run dev -- --help`；
4. 运行一个小 prompt；
5. 运行 JSON event mode 展示机器可读事件；
6. 运行 demo coding task。

README 有 1000 汉字以内限制，细节应放入 `docs/` 和 specs。

## 18. 验收标准

P0 实现满足本规范需要测试/手工检查证明：

- `--help` 和 `--version` 无 API key 可运行；
- interactive prompt 能本地处理 slash commands；
- print mode 执行一个 prompt 后退出；
- `--mode json "prompt"` 输出合法 JSONL events，stdout 不混入人类文本；
- JSON event mode 事件复用 telemetry/run event schema；
- 缺少 auth 时给出可操作提示且不泄露值；
- P0 默认 `permissionMode = yolo`，普通工具执行不要求逐次审批；
- Ctrl+C 取消当前 run 且不破坏 session；
- renderer 能展示工具进度和最终 run summary。

P1/P2 验收标准：

- `--mode rpc` 可以作为长期子进程通过 stdin/stdout JSONL 收发消息；
- RPC mode 支持 initialize、prompt、cancel、session state、shutdown；
- RPC event notification 能表达 assistant streaming、tool lifecycle、run lifecycle；
- RPC stdout 保持协议纯净；
- ACP-compatible adapter 或 `--mode acp` 有明确映射文档和最小互操作 demo；
- strict/confirm 模式下 approval 事件不会让非交互进程卡死。
