---
name: check
description: Run choco-pi's baseline environment check before implementation or for explicit /check requests, covering versions, packages, harness resources, aliases, and optional capabilities.
---

# choco-pi Environment Check

Use a capability-relevant check before `task-inline`, `task`, or `task-hotfix`. A user-requested `/check` always runs the complete check. Project instructions may add checks but do not replace it.

## Scan

1. Resolve `scripts/check-harness.ts` relative to this `SKILL.md`.
2. For an explicit `/check`, execute it with Node and no arguments. This checks core readiness and every harness capability; report every genuine failure.
3. For automatic workflow readiness, execute it with `--automatic`, followed by one `--require <capability>` for each capability the work needs. Supported capabilities are `tui`, `subagents`, `resources`, and `lsp`. For example, parallel semantic code work uses `--automatic --require subagents --require lsp`; simple code or prose work uses `--automatic`. Do not infer that an unlisted capability is ready.
4. Interpret `fail` as blocking core readiness or a requested capability, `warn` as an unavailable unrequested capability, and `pass` as ready for the reported scope. Shared instructions and mutation-ownership resources always block when missing. The JSON `mode` and `requiredCapabilities` fields define that scope.
5. Confirm separately that the current choco-pi session exposes the live tools needed by the selected workflow; installed manifests do not establish live availability. For parallel work, confirm that the `planner`, `implementer`, `reviewer`, and `handoff` agents are discoverable.
6. If resources changed after the session started, ask the user to run `/reload`, then repeat only the affected checks.

Never read or print `auth.json`, API keys, OAuth tokens, environment secrets, or credential-bearing configuration.

A successful automatic check may be reused within the same session only while its relevant runtime, configuration, resources, and required live tools remain unchanged. Always rerun a fresh explicit `/check`.

## Scope additions

Run only additions required by the current task:

- Browser work: run `agent-browser --version` and the repository-documented browser doctor. Its absence blocks only browser work.
- MCP work: validate `~/.pi/agent/mcp.json` syntax and inspect `/mcp` status without starting unrelated servers. Report a project `.pi/mcp.json` as a duplicate configuration source rather than treating it as the expected location.
- Provider setup: use Pi's status or model-listing commands for the named provider without displaying credentials.
- Repository work: run any additional environment gate explicitly required by applicable `AGENTS.md`.

## Consent and repair

Report all missing items together. Do not install packages, copy skills, modify project files, change authentication, or trust a directory without explicit user approval. After approval, apply only the requested repairs, then rerun the affected checks.

Finish with a compact `pass`/`warn`/`fail` report and state whether the selected workflow may proceed.
