# Vendored: pi-choco-agents-md

This directory is **not** a vendored copy of any upstream package. It is a
from-scratch reimplementation written for choco-pi.

- Status: from-scratch, MIT licensed (see `LICENSE`).
- Behavior reference (read-only, not copied): the installed tree of
  `@howaboua/pi-markdown-workflows@0.2.20` (MIT licensed) at
  `dist/src/core/subdir/{agents-chain,paths,appendix,branch-state,shell-targets,tool-events,details}.js`
  and `dist/src/core/subdir.js` (the `registerSubdirContextAutoload`
  registration function), plus `dist/src/hooks/before-agent-start.js` for
  contrast (that hook is unrelated workflow-prompt logic, not subdir
  context — it was read to confirm it is *not* the injection mechanism).
- Reference source: https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-markdown-workflows
- Written on: 2026-08-20.

## Why this exists

choco-pi retires its dependency on `@howaboua/pi-markdown-workflows`. That
package bundled two unrelated features: (1) subdirectory `AGENTS.md` context
autoloading, and (2) a "workflows" markdown-SOP tool/command system. Feature
(2) is superseded by a different, unrelated workflow system elsewhere in this
fork and is not ported here. Feature (1) — the AGENTS.md chain injection — is
still wanted, so it is reimplemented here as its own minimal package with no
external runtime dependency beyond the pi host's peer packages.

## Behavior parity with the reference

Reproduced faithfully:

- Root-to-leaf `AGENTS.md` chain resolution bounded by the nearest ancestor
  `.git` directory (or the highest ancestor containing an `AGENTS.md` if no
  `.git` is found) — `contentRootForTarget` / `findAgentsFiles`.
- The session root's own `AGENTS.md` is excluded from injection (it is
  already part of the base system prompt).
- The `<subdirectory_agents_context>` / `<agents_file path="...">` wire
  format, including the same XML-escaping rules, so downstream consumers of
  the tool-result text see an identical shape.
- `tool_result` hook registration; `read`, `grep`, `find`, `ls` tool inputs
  drive target-path resolution; grep-formatted `path:line:` output lines are
  parsed back into path candidates from tool text output.
- Per-session, per-absolute-path dedup: an `AGENTS.md` already injected once
  this session is not injected again on a later matching tool call.
- `session_start` / `session_tree` reset the dedup state (new session, or
  navigating the session tree, gets a fresh injection pass).

## Deliberate deviations

- **No total-size cap in the reference; this package adds one.** The
  reference injects every applicable `AGENTS.md` at full size on every
  first-touch. This package adds `MAX_FILE_CHARS` (12,000 chars/file) and
  `MAX_TOTAL_APPENDIX_CHARS` (40,000 chars/tool-result) caps, dropping the
  root-most files first when the chain is large, because uncapped injection
  of an accidentally huge `AGENTS.md` is a latent context-blowup risk. See
  `src/appendix.ts`.
- **No cross-fork/branch dedup persistence.** The reference persists which
  `AGENTS.md` files were injected into `message.details[subdirContextAutoload]`
  so that forking or resuming a session restores prior dedup state
  (`core/subdir/branch-state.js`, `core/subdir/details.js`). This package
  only tracks dedup state in an in-memory `Set` for the lifetime of the
  extension process; forking or resuming a session re-injects previously
  seen files once. This trades a minor amount of redundant injection after
  a fork/resume for a much smaller, dependency-free implementation.
- **No `codeMode`/batched-trace event unwrapping.** The reference inspects
  `event.details.traces` to also process tool calls nested inside a single
  batched "code mode" tool result (`core/subdir/tool-events.js`). This
  harness's `ToolResultEvent` shape was not observed to carry that field, so
  it is not ported; each `tool_result` event is processed as one target set.
- **Simplified shell-command target parsing.** The reference
  (`core/subdir/shell-targets.js`) has a full tokenizer plus `git`
  subcommand/flag grammar (`git -C dir ls-files`, `git --git-dir=`, etc.) and
  distinguishes `ls`/`find`/`rg`/`grep`/`fd`/`tree`/`git ls-files`/`git grep`
  as both "discovery" and "path-output" commands with different handling.
  This package (`src/shell-targets.ts`) recognizes a smaller, no-`git`
  command set (`ls find rg grep fd tree cat sed head tail`), tracks `cd`
  across `;`/`|`/`&` separated segments, and skips the first non-flag
  argument after `rg`/`grep` (the search pattern, not a path) but does not
  special-case `git` subcommands, `--git-dir=`, or `-C`.
- **Tool name set matches this host's `ToolResultEvent`, not the reference's
  wider guess list.** The reference also matches `exec`, `exec_command`, and
  `shell` as shell-tool names (defensive coverage for hosts with different
  tool names). This host's installed `@earendil-works/pi-coding-agent@0.84.2`
  types only define `bash` as the shell tool name, so only `bash` is matched.
  If a future host version adds another shell tool name, extend
  `SHELL_TOOLS` in `src/subdir.ts`.
- **`write`/`edit` tool calls are not treated as touched-path targets.**
  Matches the reference: it also does not treat `write`/`edit` as
  AGENTS.md-triggering events, only `read`/`grep`/`find`/`ls`/shell.

## What was read but not reused

`dist/src/hooks/before-agent-start.js` (workflow-prompt system-prompt suffix)
and everything under `dist/src/core/workflow*`, `dist/src/core/skill*`,
`dist/src/tools/workflows-create.js`, `dist/src/commands/*`, and
`dist/src/ui/*` — all workflows/skills-command machinery, out of scope for
this package.
