# choco-pi-agents-md

Recursive subdirectory `AGENTS.md` context injection for choco-pi, as a
minimal local pi package (`pi.extensions: ["./index.ts"]`, loaded from
TypeScript source, no build step).

## What it does

When a direct or Pi code-mode nested tool call touches a path (`read`, `grep`,
`find`, `ls`, or a recognized shell discovery command), the extension walks
the directory chain from the session's working directory down to the touched
path's directory and injects any `AGENTS.md` files found along the way into the
tool result, ordered root-first / leaf-last (closest-to-the-file guidance
appears last, right before the model reads it).

The injected block looks like:

```
<subdirectory_agents_context>
AGENTS.md context relevant to this tool result.
<agents_file path="packages/foo/AGENTS.md">
...file content, XML-escaped...
</agents_file>
</subdirectory_agents_context>
```

appended as an extra text content item on the tool result.

- The session root's own `AGENTS.md` is never re-injected here; the host
  already includes it in the base system prompt.
- Each `AGENTS.md` is injected at most once per session (tracked in memory,
  keyed by resolved absolute path). Touching the same subdirectory again
  in the same session does not re-inject its `AGENTS.md`.
- Missing `AGENTS.md` files at any level are skipped silently.
- Individual files are capped at `MAX_FILE_CHARS` (12,000 characters); the
  total appendix per tool result is capped at `MAX_TOTAL_APPENDIX_CHARS`
  (40,000 characters), dropping the root-most files first if the chain is
  large. See `src/appendix.ts`.

## What it deliberately does not do

This package replaces `@howaboua/pi-markdown-workflows`'s AGENTS.md-loading
half only. It does **not** port that package's "workflows" tools, skill
discovery/creation commands, or `/workflows`, `/skills`, `/learn` commands —
those belong to a separate, unrelated system in this fork and are out of
scope here.

## Behavior reference and credit

The subdirectory-AGENTS.md-chain concept and the `tool_result`-hook +
`<subdirectory_agents_context>` wire format are behavior-compatible with
`@howaboua/pi-markdown-workflows` (MIT licensed), which originated this
mechanism. This package is a from-scratch reimplementation, not a copy of
that package's source; see `VENDORED.md` for what was reused conceptually,
what was simplified, and what was deliberately dropped or changed.
