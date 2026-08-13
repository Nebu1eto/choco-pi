---
name: check
description: Verify the base environment required by choco-pi before implementation or when the user invokes /check. Checks Pi and Node versions, configured packages, harness resources, command aliases, and optional scoped capabilities without relying on Claude Code, Codex, or Compound Engineering.
---

# choco-pi Environment Check

Run this baseline before `task-inline`, `task`, or `task-hotfix`. Project instructions may add checks but do not replace this baseline.

## Scan

1. Resolve `scripts/check-harness.ts` relative to this `SKILL.md` and execute it with Node.
2. Interpret `fail` as a blocking harness requirement, `warn` as an optional capability, and `pass` as ready.
3. Confirm that the current choco-pi session exposes the tools needed by the selected workflow. For parallel work, confirm that the `planner`, `implementer`, `reviewer`, and `handoff` agents are discoverable.
4. If resources changed after the session started, ask the user to run `/reload`, then repeat only the affected checks.

Never read or print `auth.json`, API keys, OAuth tokens, environment secrets, or credential-bearing configuration.

## Scope additions

Run only additions required by the current task:

- Browser work: run `agent-browser --version` and the repository-documented browser doctor. Its absence blocks only browser work.
- MCP work: validate `.pi/mcp.json` syntax and inspect `/mcp` status without starting unrelated servers.
- Provider setup: use Pi's status or model-listing commands for the named provider without displaying credentials.
- Repository work: run any additional environment gate explicitly required by applicable `AGENTS.md`.

## Consent and repair

Report all missing items together. Do not install packages, copy skills, modify project files, change authentication, or trust a directory without explicit user approval. After approval, apply only the requested repairs, then rerun the affected checks.

Finish with a compact `pass`/`warn`/`fail` report and state whether the selected workflow may proceed.
