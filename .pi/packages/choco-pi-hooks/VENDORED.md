# Package provenance

## 2026-10-08 choco-pi patch: truthful MCP elicitation coverage

Labels `Elicitation` and `ElicitationResult` as having no producer, matching
`COMPATIBILITY.md`. Pi's built-in MCP handles elicitation; this package does
not bridge its requests or responses.

`choco-pi-hooks` is a first-party choco-pi package. It is not vendored from an external project.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4

Pi SDK peer and development pins move from `0.87.1` to exactly `1.0.4`,
matching the harness target. Other dependency contracts are unchanged.

## 2026-10-08 choco-pi patch: MCP hook backend retired

Removes the custom `choco-pi-hooks:mcp-call` request and response event and
the dead `choco-pi-hooks:elicitation` consumer. MCP hook configuration still
parses, but the executor fails closed with a command-hook migration message:
the public Pi SDK offers approved `executeTool` only inside `tool.execute`,
not from lifecycle hooks. This is an intentional user-visible removal, not an
approval bypass.

## 2026-10-08 choco-pi patch: shared Stop continuation budget

Applies `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` to both blocking reasons and
additional-context follow-ups. Preserves the existing default of 8 and the
blocking branch's exclusive threshold (at most 7 follow-ups by default).
Non-extension `input` starts a fresh user-task budget; extension-generated
continuations retain `stop_hook_active`. Pending Stop results are discarded
when a new user task or lifecycle generation supersedes their owner.
