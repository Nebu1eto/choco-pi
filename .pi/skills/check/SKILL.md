---
name: check
description: Validate environment readiness before implementation or for explicit /check requests.
---

# choco-pi Environment Check

Use a capability-relevant check before `task-inline`, `task`, or `task-hotfix`. A user-requested `/check` always runs the complete check. Project instructions may add checks but do not replace it.

## Scan

1. Prefer the host-native `harness_check` tool when it is available. It validates the active host without consulting an unrelated PATH launcher. Its inputs are only `mode` and `required_capabilities`; never substitute a caller-provided runtime version.
2. For an explicit `/check`, call `harness_check` with `mode: "full"`. This checks core readiness and every harness capability; report every genuine failure. A launcher warning is diagnostic only.
3. For automatic workflow readiness, call `harness_check` with `mode: "automatic"` and the capabilities the work needs. Supported capabilities are `tui`, `subagents`, `resources`, and `lsp`. For example, parallel semantic code work requires `subagents` and `lsp`; simple code or prose work requires none. Automatic checks do not probe the PATH launcher. Do not infer that an unlisted capability is ready.
4. If `harness_check` is unavailable, resolve `scripts/check-harness.ts` relative to this `SKILL.md` and execute it with Node. Use no arguments for a full check or `--automatic`, followed by one `--require <capability>` per required capability. This standalone fallback reports `imported-sdk` identity, not `active-host`; state that active-host identity was unavailable. Inside the host tool, the SDK import is host-mapped and therefore confirms the loaded host SDK again; it is not an independent inspection of another checkout installation.
5. Interpret `fail` as blocking core readiness or a requested capability, `warn` as nonblocking diagnostic evidence or an unavailable unrequested capability, and `pass` as ready for the reported scope. Shared instructions and mutation-ownership resources always block when missing. The JSON `mode` and `requiredCapabilities` fields define that scope.
6. Confirm separately that the current choco-pi session exposes the live tools needed by the selected workflow; installed manifests do not establish live availability. For parallel work, confirm that the `planner`, `implementer`, `reviewer`, and `handoff` agents are discoverable.
7. If resources changed after the session started, ask the user to run `/reload`, then repeat only the affected checks.

Never read or print `auth.json`, API keys, OAuth tokens, environment secrets, or credential-bearing configuration.

Core readiness requires Node `>=24` and the actual runtime source exactly Pi `0.86.1`, matching the repository's SDK contracts. In-host checks name `active-host`; standalone checks name `imported-sdk`. Older, newer, prerelease, missing, or malformed actual runtime versions fail. A different or unavailable direct PATH launcher does not override a verified runtime and warns only in a full diagnostic.

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
