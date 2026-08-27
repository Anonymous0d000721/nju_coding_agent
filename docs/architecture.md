# Architecture

nju-agent separates model transport, the agent loop, tools, persistence, and terminal UI.

```text
CLI/App
  -> context resources + tool registry + session store
  -> AgentRunner
      -> ModelClient (Chat / Responses / Anthropic)
      -> ToolExecutor (schema, policy, timeout, redaction)
      -> lifecycle hooks and stream events
  -> JSONL session + local telemetry
```

`AgentRunner` owns the deterministic loop: build a bounded message context, request a model turn, persist the assistant turn, execute tool calls, persist each tool result, and stop on completion, cancellation, or budgets. Every tool call receives exactly one normalized result.

The Ink TUI consumes runner events and delegates execution to `runPrompt`; it does not parse SSE or execute tools. A resumed TUI session hydrates its transcript from the same JSONL source used to restore model context. Recent history is loaded first and older pages are loaded through a cursor.

Project instructions are bounded and labeled as project-provided data. Skills use catalog-first disclosure: trusted directories expose names and descriptions, while `load_skill` reads one registered skill by name. Hooks are host callbacks around run, model, tool, turn, and stop boundaries.

Context compaction replaces old context with a bounded summary message for the model request. It never deletes the original append-only session entries. UI history and model context budgets are independent.

MCP support is opt-in through the `NJU_AGENT_MCP_SERVERS` JSON environment variable. With no configuration, no external process is started. Each configured stdio server is initialized, its tools are discovered, and the resulting definitions are registered once with the host registry; all discovered tools inherit host validation and policy. Transports are closed after the run or on setup failure.
