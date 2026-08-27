# Two-Minute Demo Script

## Before recording

1. Use a clean clone, create `.env` locally, and confirm `git status --porcelain` is empty.
2. Run `npm ci`, `npm run typecheck`, `npm test -- --run`, and `npm run build`.
3. Confirm no credential appears in terminal history, the prompt, or recorded panes.
4. Use `examples/buggy-todo-cli/` as the task workspace. Its committed fixture is passing; before recording, intentionally change `!item.completed` back to `item.completed` locally so the initial test fails. Do not commit that preparation change.

## Timeline (about 105 seconds)

- 0–10s: Show the repository and state that nju-agent is a TypeScript local coding agent using its own loop and native model tool calling.
- 10–20s: Show `.env.example`, then start the TUI or run a single prompt. Do not reveal `.env`.
- 20–65s: Prompt: `Read examples/buggy-todo-cli, fix the implementation without changing tests, and run its tests.` Show file inspection, a focused edit, the first failing test, and the passing test after repair.
- 65–82s: Show `/session`, `/name demo`, and `/resume` with restored transcript history. Optionally show the compact tool card and status line.
- 82–97s: Show `docs/architecture.md` briefly: ModelClient -> AgentRunner -> ToolExecutor/session/telemetry. Mention workspace guards, output bounds, redaction, and that this is not an OS sandbox.
- 97–105s: Show `npm test -- --run`, the run report under `.nju-agent/logs/runs/`, and the repository URL after publication.

## Fallbacks

- If the remote model is rate-limited, use the prerecorded successful terminal run only if the final video still clearly identifies it as a real prior run and shows the repository code.
- If the TUI terminal is unavailable, use `npm run dev -- --print "..."`; the coding loop, tool results, session, and test verification remain demonstrable.
- The local mock MCP server is optional and should not displace the core bug-fix flow.
