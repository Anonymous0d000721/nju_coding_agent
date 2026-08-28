# Context Harness 插件规范索引

本目录存放 `nju-agent` context harness 的**独立插件设计规范**。Harness 的原生能力、宿主契约、context 装配顺序、Project Trust 与跨插件安全基线见 [`../09-context-harness.md`](../09-context-harness.md)。

## 插件列表

| 插件 | 阶段 | 规范 | 默认状态 | 一句话边界 |
|---|---|---|---|---|
| `MemoryPlugin` | P1 | [`memory.md`](memory.md) | 启用，但仅显式/确认写入 | 本机 Markdown `MEMORY.md` index 与 topic files；不自动调用模型。 |
| `DeterministicCompactPlugin` | P1 | [`deterministic-compact.md`](deterministic-compact.md) | 启用 | 本地、零模型、零网络、append-only 的 session recap。 |
| `ObservationalMemoryPlugin` | P3 | [`observational-memory.md`](observational-memory.md) | 禁用 | 可选的 observer/reflector/dropper；可能调用模型，必须明确 opt-in。 |

## 共同要求

每个插件规范必须说明：

1. plugin id/version、生命周期 hook 与 context contribution；
2. 持久化位置、数据 schema、保留与删除策略；
3. Project Trust、来源标记、prompt-injection 与 secret-redaction 边界；
4. 是否调用模型/网络，以及默认状态、成本/隐私告知和 opt-in；
5. 独立预算、超时、错误降级、telemetry 元数据；
6. 命令/tools 的 schema 与权限；
7. 单元、集成、失败恢复和确定性验收测试。

插件不得直接篡改 `AgentRunner` message array、绕过 `ContextBuilder`、读取未信任的项目资源，或以自身文本改变 host 的 tool/permission policy。

## 新增插件流程

1. 在本目录创建 `<plugin-id>.md`；
2. 明确生命周期、输入输出、数据/网络/模型边界与验收测试；
3. 在本文件登记阶段和默认状态；
4. 在 [`../09-context-harness.md`](../09-context-harness.md) 的插件索引登记入口；
5. 若影响工具、trust、session 或 telemetry，同步相应核心 spec 的交叉引用。

## 参考材料

- `C:\Users\lenovo\.pi\agent\npm\node_modules\pi-mem-cc\README.md`：自动观察型 SQLite memory 与三层渐进检索的参考；仅作为可选 adapter 思路。
- `C:\Users\lenovo\.pi\agent\npm\node_modules\pi-blackhole\README.md`、`src/hooks/before-compact.ts`、`src/om/ledger/types.ts`：结构化 deterministic compaction、append summary、观测账本/recall 的参考。
- Claude Code Memory 文档：<https://code.claude.com/docs/en/memory>：`MEMORY.md` index 与按需 topic memory 模式。
