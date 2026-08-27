# Threat Model and Limits

## Untrusted inputs

Model output, repository files, project instructions, Skill text, tool output, and MCP server descriptions are untrusted. They may contain prompt injection or requests to disclose secrets. They are never allowed to override host policy, path guards, tool schemas, or protocol pairing.

## Host protections

File tools resolve paths inside the workspace and protect sensitive locations. Shell execution uses an explicit working directory, bounded output, timeout, cancellation, and `shell: false`. Tool arguments, errors, telemetry, and session-visible output are redacted before persistence where applicable. Strict/confirm modes deny write and shell operations without an approval callback.

Skills and project resources are only scanned from trusted project directories. The normal prompt receives Skill metadata, not every Skill body. `load_skill` accepts registered names rather than arbitrary model-provided paths. MCP tools are external-risk by default and are still routed through host schema and policy checks.

## Known limits

This is not an operating-system sandbox. Tools run with the permissions of the user who starts nju-agent. Path checks and command filters cannot prove that every shell composition is safe. Strong isolation requires a container, VM, remote sandbox, or least-privilege account.

Session JSONL is local and append-only, but it can contain user and model conversation data. Telemetry is local and can be disabled with `--telemetry off`; it must not be treated as a remote analytics service. Context summaries are lossy for the model, while original session history remains available for inspection and resume.
