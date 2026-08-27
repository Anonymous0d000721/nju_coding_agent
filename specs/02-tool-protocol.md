# Spec 02：工具协议

## 1. 目的

本规范约束工具如何被描述、注册、校验、执行，以及如何把结果返回给模型。

工具是概率性模型决策和确定性宿主行为之间的边界。每个工具都必须有 schema、风险元数据、输出上限和结构化错误。

## 2. 参考来源

- `Assignment.md`：文件读写、命令执行、模型输出解析和错误处理均要求自行实现。
- `refs/pi-minimal-doc/source/minimal-agent.md`：工具调用由宿主执行，结果追加回对话。
- `refs/pi-minimal-doc/source/input-to-llm.md`：Pi 的 `executeToolCalls()` 是模型请求变成宿主 observation 的边界。
- `refs/pi-minimal-doc/source/architecture.md`：tool execution protocol 与模型层、UI 层分离。
- `refs/learn-claude-code/s03_permission/README.zh.md`：工具执行前需要权限检查。
- `refs/pi/packages/coding-agent/docs/extensions.md`：Pi 风格工具/扩展通过结构化能力注册，而不是在 loop 中堆分支。
- `refs/hashline-edit/README.md`：本项目对 hashline edit 做法的参考索引，汇总 `pi-hashline-edit`、`opencode-hashline`、`hashline`、`vscode-hashline-edit-tool` 等资料。

## 3. 工具定义

每个工具定义必须包含：

```ts
interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: ToolRisk;
  readonly: boolean;
  timeoutMs?: number;
  outputLimit?: OutputLimit;
  handler: ToolHandler<TArgs, TResult>;
}
```

规则：

- `name` 规范化后必须唯一；
- `description` 解释功能和约束，不承载隐藏安全策略；
- `parameters` 必须兼容 OpenAI-compatible tool calling 的 JSON Schema；
- `handler` 接收的是校验后的参数，不得信任模型原始输入；
- `risk` / `readonly` 可帮助规划，但不能替代 `PermissionEngine`。

## 4. 命名规则

- 内置工具使用 snake_case，例如 `read_file`、`hashline_edit`、`run_command`；
- MCP 工具命名为 `mcp__<server>__<tool>`；
- Skill 第一版不拆成多个动态工具，优先提供 `load_skill(name)`；
- 规范化后只允许小写字母、数字、下划线；
- 名称碰撞是启动/配置错误，除非用户明确禁用其中一个来源。

## 5. 内置工具集合

P0 必须实现：

- `list_files(path?, depth?, includeHidden?)`
- `read_file(path, offset?, limit?, format?)`
- `write_file(path, content, createDirectories?)`
- `hashline_edit(path, edits[], expectedFileHash?)`
- `glob_files(pattern, path?)`
- `grep_files(pattern, path?, glob?)`
- `run_command(command, cwd?, timeoutMs?)`

P1/P2 可实现：

- `git_status()`
- `git_diff(path?)`
- `git_log(limit?)`
- `load_skill(name)`
- `todo_write(items)` / `todo_list()`
- MCP 动态发现工具。

## 6. 工具结果格式

所有工具结果必须被宿主归一化：

```ts
interface ToolResult {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  content: string;
  details?: unknown;
  error?: ToolError;
  truncated?: boolean;
  artifactPath?: string;
  elapsedMs: number;
}

interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
}
```

规则：

- `content` 是给模型看的 observation；
- `details` 是给宿主/测试/日志看的结构化元数据；
- 输出被截断时，`content` 必须说明截断，并在保存完整输出时给出 `artifactPath`；
- `error.message` 要能帮助模型恢复，但不能泄露密钥。

## 7. 标准错误码

建议统一错误码：

- `unknown_tool`
- `invalid_arguments`
- `permission_denied`
- `user_rejected`
- `path_outside_workspace`
- `sensitive_path`
- `not_found`
- `not_unique`
- `stale_anchor`
- `anchor_not_found`
- `invalid_anchor`
- `overlapping_edits`
- `file_revision_mismatch`
- `timeout`
- `cancelled`
- `process_failed`
- `output_too_large`
- `internal_error`
- `mcp_server_error`

工具可以扩展专用错误码，但应在测试中覆盖。

## 8. 输出限制

所有工具返回给模型前必须限流：

- 文件读取支持 `offset` / `limit`；
- 搜索限制匹配数量和单行长度；
- shell 限制 stdout/stderr 字节数和耗时；
- 大输出保存到内部 artifact 目录，只返回 preview + 引用；
- artifact 目录需要避免被模型随意写入。

目标是给模型足够信息继续任务，但不能让无限输出淹没上下文。

## 9. 文件工具语义

### 9.1 `read_file`

- 默认读取文本文件；
- 二进制文件应拒绝或安全摘要；
- 支持有界行/字节范围；
- 敏感文件读取受权限策略控制；
- 必须支持 `format: "plain" | "hashline"`，默认可以是 `plain`，但当模型准备编辑文件时应优先请求 `hashline`；
- `hashline` 格式必须为每一行提供可复制的行锚点，例如 `12#A7:  const value = 1;`；
- 行锚点由 1-indexed 行号和短内容 hash 组成，格式为 `LINE#HASH`；
- hash 必须由宿主对原始行内容确定性计算，至少应对缩进变化敏感；
- `read_file(format: "hashline")` 可以额外返回整文件 revision/hash，用于检测整文件是否在读取后发生变化。

### 9.2 `write_file`

- 创建或覆盖文件；
- P0 `permissionMode = "yolo"` 时，workspace 内普通文件写入不需要逐次审批；
- P1/P2 的 `strict` / `confirm` 模式可以要求覆盖前审批或 diff preview；
- 仅当 `createDirectories = true` 且路径策略允许时创建父目录；
- 未经显式授权不得写出 workspace。

### 9.3 `hashline_edit`

`hashline_edit` 是本项目 P0/P1 的默认局部编辑工具。它使用 `read_file(format: "hashline")` 或 hashline grep 结果中的 `LINE#HASH` 锚点定位行，而不是要求模型复述 `oldText`。

推荐参数：

```ts
interface HashlineEditArgs {
  path: string;
  edits: HashlineEdit[];
  /** 可选：来自 hashline read 的整文件 revision/hash。若提供，文件变化时应优先拒绝。 */
  expectedFileHash?: string;
}

interface HashlineEdit {
  op: 'replace' | 'delete' | 'insert_before' | 'insert_after';
  /** replace/delete 的起始锚点，例如 "12#A7"。 */
  start?: string;
  /** replace/delete 的结束锚点；省略时只作用于 start 行。 */
  end?: string;
  /** insert_before/insert_after 的单行锚点。 */
  anchor?: string;
  /** replace/insert 的新文件内容，不得包含 hashline 显示前缀。 */
  content?: string;
}
```

必须满足：

- `start`、`end`、`anchor` 必须是合法 `LINE#HASH`；
- 执行前必须基于同一个 pre-edit snapshot 校验本次调用涉及的所有锚点；
- 行号存在但 hash 不一致时返回 `stale_anchor` 或 `file_revision_mismatch`，不得猜测、模糊匹配或静默改到“看起来相似”的行；
- 行号越界或锚点无法解析时返回 `anchor_not_found` / `invalid_anchor`；
- 多个 edits 必须区间不重叠；若重叠，返回 `overlapping_edits`；
- 通过校验后，应按从文件尾到文件头的顺序应用 edits，避免前面的编辑导致后续行号漂移；
- `replace` 替换 inclusive range `[start, end]`，`end` 省略时替换单行；
- `delete` 删除 inclusive range `[start, end]`，`end` 省略时删除单行；
- `insert_before` / `insert_after` 只接受 `anchor`；
- `content` 是字面文件内容，不得包含 `12#A7:` 这类显示前缀，也不得包含 diff marker；
- 成功后必须返回简短 diff preview；
- 成功后应尽量返回变更区域的新 `LINE#HASH` anchors，方便模型连续编辑而不必整文件重读；
- 失败时应在 `content` 中给出明确恢复建议，例如“请重新 `read_file` 获取新 hashline anchors”。

设计理由：

- 相比 `oldText/newText`，hashline edit 避免模型复述大段旧文本；
- 可检测 stale read，避免文件变化后误改；
- 重复代码块不再依赖全文唯一匹配；
- 多 edit 可以统一校验并稳定应用。

`oldText/newText` 不作为主编辑协议。若未来需要兼容，可作为 P2 的 `replace_text` op 或单独 fallback 工具，但默认应关闭或要求额外审批。

## 10. Shell 工具语义

`run_command` 的 P0 默认 shell runner 为 PowerShell Core / `pwsh`。本项目的开发、测试和演示环境优先面向 Windows，因此第一版不依赖 Git Bash、WSL 或 POSIX shell。

通用要求：

- 使用可控的 process spawning，由宿主显式启动目标 shell 或可执行文件；
- 不使用 Node.js `shell: true` 作为默认执行方式；
- 明确设置 cwd，且 cwd 必须经过 workspace/path policy 校验；
- 必须支持 timeout 和 cancellation；
- 捕获 exit code、signal、stdout/stderr preview、elapsed time；
- stdout/stderr 必须限流并脱敏；
- 危险命令由 `03-permission-trust.md` 约束。

### 10.1 PowerShell Runner

P0 必须实现原生 PowerShell runner：

- Windows 下默认使用 `pwsh`；
- 启动参数应包含 `-NoLogo`、`-NoProfile`、`-NonInteractive`；
- 可使用 `-ExecutionPolicy Bypass` 降低本地 demo 环境差异，但不得把它描述为安全机制；
- 命令通过 `-Command` 执行；
- 推荐 Node.js spawn 形态：

```ts
spawn('pwsh', [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  command,
], {
  cwd,
  env,
  shell: false,
  signal,
});
```

- 找不到 `pwsh` 时，可以尝试 `powershell.exe` fallback，或返回清晰的 `shell_not_found` 错误；
- PowerShell runner 必须记录实际使用的 executable，例如 `pwsh` 或 `powershell.exe`；
- PowerShell 命令字符串仍然是 shell script，安全性不能依赖 `shell: false`，而必须依赖权限审批、cwd 限制、超时、输出脱敏和危险命令拦截。

### 10.2 Bash/Sh Runner

`bash` / `sh` runner 是 P2 跨平台增强，不作为 Windows P0 依赖。

未来实现时必须通过 `ShellRunner` 抽象接入，不能把 bash 语义写死进 `run_command`：

```ts
interface ShellRunner {
  id: 'pwsh' | 'powershell' | 'bash' | 'sh' | string;
  platform: NodeJS.Platform | 'any';
  run(args: RunCommandArgs, ctx: ToolExecutionContext): Promise<CommandResult>;
}
```

Bash/Sh runner 需要单独处理：

- shell executable 发现；
- Windows 路径和 POSIX 路径转换；
- quoting 差异；
- login/non-login shell 差异；
- Git Bash、WSL、MSYS2 是否存在的环境差异。

## 11. Handler 规则

Handler 必须：

- 不让未捕获异常越过 executor 边界；
- 尊重 `AbortSignal`；
- 返回确定的结构化结果；
- 不打印密钥；
- 不绕开中心化权限策略；
- 文件访问必须使用共享 path guard。

## 12. 验收标准

实现满足本规范需要测试证明：

- 工具注册和重复名称拒绝；
- JSON Schema 校验成功/失败；
- 每个内置工具的成功路径；
- 未知工具和非法参数会转换为 tool result；
- 文件不存在、hashline anchor 过期/不存在/非法、多个 edit 重叠、命令失败、超时、取消；
- 截断和 artifact 引用行为；
- 每个结果都正确配对 `tool_call_id`。
