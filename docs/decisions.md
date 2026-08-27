# Design Decisions

## Native model protocols

The project implements its own provider-neutral message and tool loop. Provider clients only translate requests and responses for OpenAI Chat, OpenAI Responses, and Anthropic Messages. This keeps tool-result pairing, persistence, budgets, and cancellation in host code and avoids an agent framework.

## JSONL sessions

Sessions use append-only JSONL because entries are inspectable, easy to recover after a process interruption, and suitable for future summary or branch entries. The TUI treats the session store as the source of truth and reads recent history through a bounded cursor API.

## Ink TUI

Ink is limited to interactive rendering and input ownership. `runPrompt` and `AgentRunner` remain independent of React so text, print, JSON, and tests retain direct output contracts. The TUI uses a visible software cursor and semantic transcript states, with tool output intentionally compact.

## Progressive context

Project instructions are labeled data, Skills are catalog-first, and full Skill text is loaded only by exact registered name. Compaction is bounded and preserves the original session log; the model receives a summary while the UI can still page through the full local history.

## MCP boundary

MCP is a transport and discovery mechanism, not an authorization layer. stdio JSON-RPC tools are normalized into the host registry and inherit host schema validation, risk metadata, timeout, error normalization, and redaction. External descriptions cannot grant permission.
