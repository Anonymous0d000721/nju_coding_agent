# DeterministicCompactPlugin：本地确定性会话压缩

> 阶段：P1。默认启用。compaction 本身零模型调用、零网络调用。
>
> 宿主契约与共同安全规则见 [`README.md`](README.md) 和 [`../09-context-harness.md`](../09-context-harness.md)。

## 1. 目标与边界

本插件替换当前自由文本/字符串截断式的 `compactMessages()` 路径，以本地、结构化、可复现的方式将旧 session history 投影为短 recap。设计参考 `pi-blackhole` / `pi-vcc` 的结构化 compaction 与 append summary 思路，但严格适配本项目 JSONL schema。

本插件不：

- 调用 `ModelClient`、工具或网络；
- 删除、重写 session 的 message/tool/summary 原始 entry；
- 生成没有 message、tool observation 或用户确认支撑的“智能结论”；
- 作为 observational memory 的后台 LLM worker。

## 2. 输入、输出与不变量

```ts
interface CompactionPlan {
  sessionId: string;
  reason: 'manual' | 'threshold' | 'overflow';
  sourceEntries: SessionEntry[];
  previousSummary?: SummaryEntry;
  contextBudgetChars: number;
  keepRecentTurns: number;
}

interface DeterministicCompactionResult {
  summary: string;
  coveredEntryIds: string[];
  firstKeptEntryId?: string;
  keptMessages: AgentMessage[];
  artifacts: string[];
  stats: { sourceChars: number; outputChars: number; omittedToolOutputChars: number };
}
```

不变量：

- 相同输入与算法版本产生字节稳定结果；
- 成功 compaction 只向 JSONL 追加 `summary` entry；
- 保留最近完整 user turn；不得拆散 assistant tool-call 与其 tool-result；
- 优先保留已有 artifact reference，禁止把大工具输出复制入 summary；
- summary 记录 coverage entry ids、生成原因、算法版本、预算与统计；
- 解析失败、预算不足或无法修复 tool pairing 时 fail closed：保留原 context 并采用安全截断，或报告 context-overflow；不得编造 recap。

## 3. 结构化提取

摘要以固定章节顺序输出；空章节省略：

```md
[Session Goal]
[User Constraints]
[Files And Changes]
[Commands And Checks]
[Tool Failures / Blockers]
[Decisions]
[Outstanding Next Steps]
[Recall]
```

提取规则：

- user message：显式目标、约束、确认或否决；
- `hashline_edit` / `write_file`：路径、operation、diff/artifact reference；
- `run_command`：命令、exit code、截断状态，仅保留有意义的短诊断；
- git 工具：commit hash/subject、修改文件；
- tool failure：错误 code 与最短诊断；
- assistant text：只保留有工具 observation 或用户确认支撑的决定/下一步；
- 所有文本沿用 session redaction，summary 不得重新暴露敏感数据。

## 4. Append segment 与 rebase

P1 使用不可变 append segment `S<n>`。ContextBuilder 以稳定顺序投影仍适用的 segment，维持 cache-stable prefix，且无需覆写旧 summary。

`SummaryEntry` 至少包含：

```ts
{
  algorithm: 'deterministic-v1',
  coveredEntryIds: string[],
  firstKeptEntryId?: string,
  reason: 'manual' | 'threshold' | 'overflow',
  budget: { contextBudgetChars: number, keepRecentTurns: number },
  stats: { sourceChars: number, outputChars: number, omittedToolOutputChars: number },
  supersedesEntryIds?: string[],
}
```

P2 中，当 segment 数或总字符数达到阈值，`/compact --rebase` 可以由同一 deterministic 算法合并成新 segment，旧 segment 保留在 JSONL 并被 `supersedesEntryIds` 标记。若结构化字段不可靠，降低旧 segment context priority，而非伪造合并结论。

## 5. 触发和命令

- `/compact`：manual compaction；显示覆盖范围、保留 turns、摘要大小，不回显敏感原文；
- `threshold`：每次 model request 前估算预算；超过 soft threshold 时执行；
- `overflow`：provider overflow 后最多再尝试一次更激进的 deterministic compact；仍失败就返回明确错误，禁止无限重试；
- P1 不支持 run 中后台 compact；P2 若加入 mid-run compact，只能在 turn boundary 且无 pending tool result 时进行。

插件可向 `/context status` 提供当前 summary segments、覆盖范围、预算及截断说明。

## 6. 失败、隐私与 telemetry

- 任何 hook 失败不会阻断 session append 或工具结果持久化；
- summary/telemetry 继续经过 secret redaction；
- telemetry 仅记 reason、输入/输出字符数、覆盖数、保留 turns、耗时和 error code；
- 绝不记录完整 summary/prompt 或 tool output；
- 即使用户禁用本插件，session resume 保持可用；只是改用 runner 的安全上下文截断，并作可见告警。

## 7. 验收

- fixture JSONL 对相同输入产生完全相同的 summary bytes；
- spy/assert 证明 compaction 不触发 ModelClient、tools 或 network；
- 原始 JSONL entry 只增不改，coverage 和算法版本可审计；
- 近期完整 user turn 与 tool-call/result pairing 均保留；
- 大工具输出变 artifact reference/截断统计，而非进入 summary；
- overflow 至多重试一次；无可行方案时错误清晰；
- fake secret、畸形 entry、缺失 artifact、过小预算和损坏历史均受测试覆盖。

## 8. 参考

- `pi-blackhole`：`README.md`、`src/hooks/before-compact.ts`、`src/om/ledger/types.ts`。
- `refs/pi-minimal-doc/source/compaction-and-branches.md`：append-only session 与 compaction projection。
