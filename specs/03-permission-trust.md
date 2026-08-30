# Spec 03：权限、YOLO 执行与项目 Trust

## 1. 目的

本规范约束本项目的安全边界与实现顺序：

- P0 默认采用 Pi-like 的 **YOLO 工具执行模式**；
- P0 不实现逐次工具审批，也不依赖 TUI/Web 交互；
- P0 必须实现 **Project Trust Guard**，防止未信任仓库静默加载项目本地可执行资源或行为配置；
- P0 必须实现若干工程安全底线，例如路径规范化、timeout、输出截断和凭据脱敏；
- P1/P2 再扩展 strict/confirm 权限模式、危险命令审批、diff preview 和 TUI/Web 审批 UX。

核心原则：**P0 的默认工具执行是 YOLO，但 YOLO 不是 sandbox，也不是安全保证。**

## 2. 参考来源

- `Assignment.md`：API key 等凭据不得进入仓库、README 或视频；本地执行逻辑由我们负责。

## 3. 设计结论

本项目采用以下分层：

```text
P0：YOLO Tool Execution + Project Trust Guard + Safety Baseline
P1：可选 permissionMode = yolo | strict | confirm
P2：TUI/Web Approval UX + Permission Gate Extension
```

P0 的重点不是“每次工具调用前审批”，而是：

- 先让 agent loop、tool protocol、session、CLI 跑通；
- 保持行为接近 Pi；
- 明确项目资源加载边界；
- 明确文档风险，避免把普通本地进程误称为 sandbox。

## 4. P0：YOLO Tool Execution

P0 默认：

```ts
type PermissionMode = 'yolo';
```

含义：

- `read_file` 默认可读取工作区内普通文件；
- `write_file` 默认可写入工作区内普通文件；
- `hashline_edit` 默认可编辑工作区内普通文件；
- `run_command` 默认可在工作区 cwd 中执行命令；
- 工具调用不弹出逐次确认；
- 非交互 JSON-RPC / print 模式不会返回大量 `approval_required` 以阻断任务执行。

P0 文档和 README 必须明确说明：

```text
本 agent 没有内置 sandbox。
工具以启动该 agent 的 OS 用户权限运行。
请不要在不信任仓库或含敏感凭据的环境中无隔离运行。
如需强安全边界，应使用 Docker、VM、远程沙箱或系统级 sandbox。
```

## 5. P0 安全底线

即使默认 YOLO，P0 仍必须实现以下工程安全底线。

### 5.1 路径规范化

所有文件工具必须：

- 基于 workspace root 或工具 cwd 解析相对路径；
- 在读写前 canonicalize / normalize 路径；
- 处理 `..` 路径穿越；
- 尽平台能力处理 symlink；
- 在 tool result 中返回规范化后的 path；
- 不只依赖未经规范化的字符串前缀判断。

P0 可以默认允许 workspace 内读写；workspace 外行为可先采用较简单策略：

- 用户 prompt 明确引用的绝对路径，可以执行；
- 模型自行猜测或构造的 workspace 外写入，应拒绝或要求未来 strict/confirm 模式处理；
- `.git/` 内部写入默认拒绝。

### 5.2 Shell 执行底线

`run_command` P0 默认 YOLO，但必须具备：

- 明确 cwd；
- 明确 shell runner，本项目 P0 使用 `pwsh`；
- timeout；
- stdout/stderr 捕获；
- 输出大小限制；
- exit code / signal / elapsed time；
- 支持取消；
- telemetry/log redaction；
- 不把 `shell: false` 描述为安全边界。

P0 可以不做危险命令审批；但可以保留少量硬拒绝，防止明显事故：

- 拒绝无必要输出全部环境变量；
- 拒绝读取或打印已识别凭据文件；
- 拒绝直接写 `.git/` 内部；
- 拒绝明显指向系统根目录或磁盘格式化的命令。

这些硬拒绝是 safety baseline，不是完整 permission system。

### 5.3 输出截断

所有工具结果必须限制返回给模型和写入日志的体积：

- stdout/stderr 分别有最大字符数或最大行数；
- 大输出只保留头尾摘要或写入受控 artifact；
- tool result 标明是否 truncated；
- 不允许无限制 `cat`/`Get-Content` 大文件结果塞入上下文。

### 5.4 凭据脱敏

必须对以下位置做 redaction：

- tool args preview；
- stdout/stderr；
- error message；
- session transcript；
- telemetry / run report；
- README 或 demo 输出。

默认敏感模式包括：

- API key / token 常见格式；
- `.env`、`.env.*`，但 `.env.example` 除外；
- 名称或目录包含 `secret`、`token`、`credential`、`key` 的文件；
- SSH 私钥，例如 `id_rsa`、`id_ed25519`；
- agent auth/session/log 目录中可能含私密信息的文件。

## 6. Project Trust Guard

Project Trust 与 YOLO Tool Execution 是两件事：

```text
YOLO Tool Execution：模型请求工具时默认直接执行。
Project Trust：决定是否加载项目本地可执行资源和行为配置。
```

Project Trust 不是 sandbox，也不限制工具后续能执行什么。它只防止一个未信任仓库在启动时静默改变 agent 行为。

## 7. 受 Trust 约束的项目资源

加载以下项目本地资源前，必须解析 workspace trust：

- `.nju-agent/settings.json`；
- `.nju-agent/extensions/**`；
- `.nju-agent/skills/**/SKILL.md`；
- `.nju-agent/prompts/**`；
- `.nju-agent/SYSTEM.md` 或类似追加系统提示文件；
- `.agents/skills/**/SKILL.md`；
- 项目本地 MCP 配置；
- 项目本地 hooks/extensions；
- 会显著改变 agent 行为的项目指令文件。

P0 可以继续加载普通上下文说明文件，例如：

- `AGENTS.md`；
- `CLAUDE.md`；
- `README.md`；
- 用户明确指定读取的项目文档。

但文档必须说明：上下文文件仍可能包含 prompt injection；Project Trust 不能消除该风险。

## 8. Trust 状态与默认行为

Trust 状态：

```ts
type ProjectTrustState =
  | 'trusted'
  | 'session_only'
  | 'denied'
  | 'unknown';
```

默认配置：

```ts
type DefaultProjectTrust = 'ask' | 'always' | 'never';

const defaultProjectTrust: DefaultProjectTrust = 'ask';
```

行为规则：

| 模式 | unknown + ask | always | never |
|---|---|---|---|
| interactive | 询问用户是否 trust | trust | 不加载项目资源 |
| print/json/rpc | 不弹窗，默认不加载项目资源 | trust | 不加载项目资源 |

P0 如果尚未实现 TUI trust selector，可以先实现：

- `--approve`：本次运行 trust 当前 workspace；
- `--no-approve`：本次运行不 trust 当前 workspace；
- 无 UI 且默认 `ask`：不加载受 trust 约束资源；
- 可选持久化 trust store 放到用户目录，而不是仓库。

trust store 必须：

- 与 session log 分离；
- 按 canonical workspace path 存储；
- 不保存密钥；
- 不写入仓库。

## 9. P1：Strict / Confirm Mode

P1 可以增加：

```ts
type PermissionMode = 'yolo' | 'strict' | 'confirm';
```

### 9.1 strict

`strict` 模式可以：

- 默认拒绝 workspace 外写入；
- 默认拒绝敏感文件读取；
- 默认拒绝安装依赖、网络命令、破坏性命令；
- 默认拒绝未知 MCP 工具；
- 在非交互模式中把需要确认的操作返回为 `approval_required`。

### 9.2 confirm

`confirm` 模式可以：

- shell 执行前显示命令、cwd 和风险说明；
- 文件写入/编辑前显示 diff preview；
- 支持 allow once / deny / allow for session；
- 支持 session allowlist；
- 支持 dangerous command detector。

P1 的 permission decision 可以设计为：

```ts
type PermissionDecision =
  | { action: 'allow'; reason: string }
  | { action: 'ask'; reason: string; prompt: ApprovalPrompt }
  | { action: 'deny'; reason: string; code: string };
```

但 P0 不要求每个工具调用都经过此完整决策流。

## 10. P2：TUI/Web Approval UX

P2 再实现完整交互体验：

- 首次进入项目时的 trust selector；
- `/trust` 命令；
- diff preview；
- shell command card；
- dangerous-tool approval；
- permission history；
- permission-gate extension；
- MCP tool trust/confirmation；
- 可视化 session allowlist。

审批提示必须包含：

- 工具名；
- 规范化目标路径或命令；
- 风险原因；
- 文件写入/编辑时的简短 diff；
- 选项：允许一次、拒绝、可选“本 session 允许类似操作”。

默认高亮选项不应是破坏性操作。

## 11. MCP 与扩展安全

P0 如果实现 MCP 或扩展能力，必须遵循：

- 项目本地 MCP 配置受 Project Trust 约束；
- 项目本地扩展受 Project Trust 约束；
- user/global 扩展视为用户主动安装，默认可加载；
- extension 代码与主进程具有相同 OS 权限；
- README 必须提醒用户只安装可信扩展；
- MCP server description 不能作为安全声明，宿主程序不能因为工具自称 read-only 就放弃边界检查。

## 12. 验收标准

P0 实现满足本规范需要测试证明：

- 默认 `permissionMode` 为 `yolo`；
- 普通 `read_file` / `write_file` / `hashline_edit` / `run_command` 不需要逐次审批即可执行；
- 文档明确说明没有 sandbox，工具以当前 OS 用户权限运行；
- 路径 canonicalization 能处理 `..` 和基本 symlink 风险；
- `.git/` 内部写入被拒绝；
- shell 有 timeout、输出截断、exit code 和 elapsed time；
- fake secret 不出现在 logs/session/telemetry 中；
- 未 trust 前，项目本地 skills/extensions/MCP config 不会加载；
- 非交互模式下 `defaultProjectTrust = ask` 不弹窗，并默认不加载受 trust 约束资源；
- `--approve` / `--no-approve` 可以对 Project Trust 做一次性覆盖。

P1/P2 验收标准另行补充：

- strict/confirm 模式的 allow/deny/ask 决策；
- 危险 shell 命令识别；
- diff preview approval；
- TUI/Web approval UX；
- permission-gate extension。