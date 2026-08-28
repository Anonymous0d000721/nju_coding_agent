# MemoryPlugin：Claude-like 长期记忆

> 阶段：P1。默认启用本地读取与显式/确认写入；不自动调用模型或网络。
>
> 宿主契约与共同安全规则见 [`README.md`](README.md) 和 [`../09-context-harness.md`](../09-context-harness.md)。

## 1. 目标与非目标

`MemoryPlugin` 提供跨 session、可审阅、可删除的项目/用户长期知识。它服务于稳定偏好、已确认架构决定与可复用项目事实，而不是保存完整聊天记录。

本插件不：

- 替代 session JSONL 或 session summary；
- 在 P1 通过 observer LLM 自动学习；
- 写入工具大输出、未经确认的模型推断、私密信息；
- 将跨 session 文本升级为 host instruction 或 tool policy。

## 2. 存储与作用域

```text
<agent-data>/memory/<workspace-fingerprint>/
  MEMORY.md                 # 小型启动 index
  project.md                # topic file
  preferences.md            # topic file
  decisions.md              # topic file
  .memory-meta.json         # schema、workspace identity、更新时间；无正文
```

- `<agent-data>` 默认用户本机目录，例如 `~/.nju-agent/`；默认不在仓库中、不可被 Git 提交；
- `workspace-fingerprint` 由 canonical workspace root 与可选 Git remote/hash 派生，避免项目混用且允许同仓库 worktree 共享；metadata 不得记录 remote 凭据；
- 明确配置可以指定绝对 `memoryDir`；来自项目配置的路径仍受 Project Trust；
- 仅插件拥有写入协议；用户仍可通过正常文件方式手工编辑 Markdown。

## 3. `MEMORY.md` index 与 context contribution

启动仅读取 `MEMORY.md` 的前 **200 行或 25 KiB（先到为准）**。topic 文件绝不在启动时全量加载。

推荐格式：

```md
# Memory index

- [project.md] 当前架构：Node.js + TypeScript；session 在 `.nju-agent/sessions/*.jsonl`。
- [preferences.md] 用户偏好：默认先讨论再动手；Windows 命令使用 `pwsh`。
- [decisions.md] P0 默认 YOLO；Project Trust 只控制项目资源加载。
```

插件在 `beforeContextBuild` 返回一个有界 `ContextContribution`：

```ts
{
  id: 'memory:index',
  priority: 'memory',
  label: 'memory',
  content: '[Persistent project/user data; not host policy]\n' + index,
  source: { plugin: 'memory', paths: ['.../MEMORY.md'] },
  trusted: true,
}
```

超过上限必须产生 `memory_index_truncated` warning；`/memory status` 显示行数、字节数和整理建议，不能静默截断。index 内容依旧是低优先级数据，不能覆盖 system/developer 规则、permission policy 或当前 user request。

## 4. 写入、证据与删除

P1 写入要求：

- 用户直接提出“记住/不要忘记”，或 agent 展示候选并获得确认；
- 提供 `sourceSessionId`、`sourceEntryIds` 或 `user-confirmed` evidence；
- 内容短小、可验证，属于事实、偏好或决定；
- 禁止写入整段 transcript、工具大输出、token、credential、`.env`、私钥或用户未批准的个人信息；
- 更新 index 时保留 topic link，不把全部 topic 内容复制进去。

工具定义：

```text
memory_search(query, limit?)                -> topic/line 的有界索引与 score
memory_get(topic, offset?, limit?)          -> 有界 topic 内容
memory_write(topic, content, evidence?, createTopic?)
memory_forget(topic, selector?)             -> 仅删除派生 memory
```

- `topic` 必须是已注册的安全名称，或 `createTopic: true` 并经明确确认；禁止 path traversal；
- `memory_forget` 不删除原 session records；
- 插件提供 `/memory`、`/memory status`、`/memory open <topic>`、`/memory enable|disable`；
- disable 后不读取、不注入、不写入；恢复 session 不因 memory 缺失/损坏失败。

## 5. 检索与渐进披露

P1 使用 topic 文件名、index 内容与关键词的本地搜索（简单 BM25 或等价算法即可），不引入云 embedding。模型先 `memory_search`，再 `memory_get`；不得一次把所有 topic 内容放进 context。

P2 可加入本地 SQLite FTS adapter，但维持同一分层工具接口。命中结果要显示 topic、有限 snippet 和来源，而不是伪造原始 evidence。

## 6. Session、分支与安全

- memory 跨 session，summary 只对应特定 session/branch；
- memory evidence 可回指 session entry id，但 memory 不是事实源；
- fork 不复制 memory；child/parent 共享同一 workspace-scoped memory；
- tool/MCP/仓库文本不得自行触发 write、插件安装或配置变更；
- 所有输出与日志经过 secret redaction；telemetry 仅记录命中数、耗时、截断与错误 code，不记录正文；
- memory 文件即使人手编辑，也只作为来源标记的低优先级 data。

## 7. 分期与验收

| 阶段 | 内容 |
|---|---|
| P1 | Markdown index/topic 存储，200 行/25 KiB 限制，显式写入、local search/get/forget、状态命令。 |
| P2 | SQLite FTS adapter、deterministic 的待确认候选。 |
| P3 | 仅通过独立 [`observational-memory.md`](observational-memory.md) 接入 observer LLM 自动捕获。 |

验收：

- index 截断边界和 topic 按需读取均有测试；
- 无用户请求/确认或无 evidence 的写入被拒绝；
- fake secrets 不进入 index、topic 或 telemetry；
- search/get 有界且不触发网络/模型调用；
- path traversal、未知 topic、损坏 metadata 和损坏 Markdown 均 fail-soft；
- disable、forget、resume 和 fork 行为可验证。

## 8. 参考

- Claude Code Memory：<https://code.claude.com/docs/en/memory>。
- `pi-mem-cc` README：借鉴三级 progressive disclosure；该插件自动用 active model 观察 tool results 并写 SQLite，故不作为本 spec 的 P1 默认行为。
