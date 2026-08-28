# ObservationalMemoryPlugin：可选自动观察记忆

> 阶段：P3。**默认关闭**。启用后可能向配置的模型发送 session/tool 数据并产生额外费用。
>
> 本插件不替代 [`memory.md`](memory.md) 的 P1 显式、Markdown 长期记忆；宿主契约与共同安全规则见 [`README.md`](README.md)。

## 1. 目的与启用门槛

本插件参考本机 `pi-mem-cc` 和 `pi-blackhole` 的 observer / reflector / dropper 思路：从对话和工具结果中提取带 provenance 的 observations，合并为较稳定的 reflections，并在 compaction 后提供有限 recall。

它的价值是减少用户手工记录负担；风险是：会增加模型调用、延迟、成本、敏感数据发送和错误记忆。因此 P3 前不得实现为隐式默认功能。

只有满足以下条件才能启用：

1. 用户在配置/命令中明确选择 `enabled: true`；
2. UI/CLI 显示所用 provider/model、发送数据类型、预算、存储位置与保留策略；
3. 选择是否允许发送 tool inputs/outputs；默认仅允许经 redaction 的摘要候选；
4. 用户可立即 disable、暂停、查看与删除 observation/reflection；
5. 宿主确认 Project Trust、secret-redaction 和网络 policy 都满足。

## 2. 数据模型与存储

持久化可以采用本地 SQLite FTS 或 append-only JSONL ledger；无论后端如何，逻辑模型统一：

```ts
type Observation = {
  id: string;                 // stable short id
  content: string;
  timestamp: string;
  relevance: 'low' | 'medium' | 'high' | 'critical';
  sourceEntryIds: string[];
  tokenCount: number;
};

type Reflection = {
  id: string;
  content: string;            // 单行、简短、可审阅
  supportingObservationIds: string[];
  tokenCount: number;
};
```

- 每项必须有 session entry provenance；无来源项不可注入 context；
- store 位于用户本机 agent data，默认不在仓库、不可提交 Git；
- 删除必须只删除派生 ledger/store，绝不修改 session JSONL；
- 可选 retention limit、按 workspace 隔离与显式 export/import；export 默认脱敏。

## 3. Worker 与生命周期

候选 worker：

```text
Observer  : tool_result / turn_end 后产生 observation 候选
Reflector : 达到阈值时将多条 observation 合并为 reflection 候选
Dropper   : 超预算或过期时删除/折叠低价值候选
Recall    : 按 query 返回小型 index，随后按 ID 获取详情
```

约束：

- worker 必须独立于主 AgentRunner；其失败不能影响主 run、tool persistence 或 deterministic compact；
- 默认在 turn end 后异步执行，不在 tool result 热路径阻塞；TUI/CLI 显示 pending/failed 状态；
- 每个 worker 具有独立 timeout、并发上限、每日/每 session token 与费用预算；
- provider/model 采用显式配置，不能“静默复用当前 session 模型”；
- 采用 persisted cooldown、fallback chain 与 retry 上限，防止失败风暴；
- 禁止 worker 调用会修改 workspace 的 agent tools；它们只可读取已 redacted 的 event projection。

## 4. Context 与 recall

默认不把全部 observations/reflections 自动塞入 prompt。`beforeContextBuild` 至多注入小型、带来源的 recent/relevant index；主 agent 必须经：

```text
memory_search(query, limit?) -> observation/reflection ID + short snippet
memory_timeline(id)          -> 附近时间线（可选）
memory_get(ids)              -> 有界详细内容
```

读取结果必须标记为 `[Observational memory; may be incomplete; source IDs: ...]`，低于 host policy、用户请求和 trusted project instructions。它不能自动触发 `memory_write` 到人类维护的 `MEMORY.md`；若要提升为长期手工 memory，仍须遵守 [`memory.md`](memory.md) 的确认/evidence 规则。

## 5. 隐私、安全与故障降级

- 发送任何内容前应用 secret redaction、大小限制和用户选定的 data scope；
- 绝不发送 `.env`、credential、token、private key、未批准个人数据、完整大文件或原始超长 tool output；
- 外部工具/MCP/仓库文本不能自行启用 worker、扩大 data scope 或改写 retention；
- metrics 只包含 worker 状态、调用数、字符/token/费用统计、duration 和错误 code；不写 observation 正文；
- 用户可以 `/memory observer status|pause|resume|disable|clear`；clear 需要明确确认；
- 网络、provider、schema 或 store 出错时 fail-soft，保留 deterministic memory/compact 与 session resume。

## 6. 验收

- 未 opt-in 时零 worker 启动、零额外模型/网络调用；
- opt-in 信息完整显示，data scope/budget/provider 均可检查与修改；
- 每条 injected observation/reflection 可追溯到 source entry ids；
- cooldown、fallback、timeout、费用上限和 worker crash 均不影响主 agent；
- fake secret 与禁止数据不会进入 worker request、store、recall 或 telemetry；
- 查询结果分层有界，clear/disable 后不可再注入；
- observational content 无法覆盖 instruction/tool policy，也不能无确认写入 `MEMORY.md`。

## 7. 参考

- `pi-mem-cc` README：session start injection、tool-result observation、SQLite FTS 与三层 read API。
- `pi-blackhole`：`src/index.ts`、`src/hooks/before-compact.ts`、`src/om/ledger/types.ts`；其中自动 compaction/worker 仅作为 opt-in 设计参考。
