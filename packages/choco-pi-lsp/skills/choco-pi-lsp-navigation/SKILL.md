---
name: choco-pi-lsp-navigation
description: Navigate code and run proactive LSP diagnostics for files, folders, or batches.
---

# LSP Navigation and Diagnostics

Use `lsp_navigation` as **PRIMARY** for code intelligence. Use `lsp_diagnostics` as **PRIMARY** for proactive type/error checks. Do NOT use grep/glob/ast-grep first for code intelligence.

## Diagnostics

Use `lsp_diagnostics` before builds/tests or after touching several files:

| Need                      | Tool call                                                              |
| ------------------------- | ---------------------------------------------------------------------- |
| Check one file            | `lsp_diagnostics({ path: "src/file.ts" })`                             |
| Check a folder            | `lsp_diagnostics({ path: "src/", severity: "error" })`                 |
| Check exact touched files | `lsp_diagnostics({ paths: ["src/a.ts", "src/b.ts"], concurrency: 8 })` |
| Slow server (Rust, Java)  | `lsp_diagnostics({ paths: files, wait_ms: 2000 })`                     |
| Include warnings          | `lsp_diagnostics({ paths: files, severity: "all" })`                   |

Prefer explicit `paths` batches after multi-file edits — bounded concurrency, no unrelated directory noise.

## Navigation (Code Intelligence)

| Question                                     | Operation                                   | Parameters                                                 |
| -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Where is this defined?                       | `definition`                                | path, line, character                                      |
| Where is this symbol's _type_ defined?       | `type_definition`                           | path, line, character                                      |
| Where is this declared (vs defined)?         | `declaration`                               | path, line, character                                      |
| Find all usages                              | `references`                                | path, line, character                                      |
| What type is this?                           | `hover`                                     | path, line, character                                      |
| Call signature                               | `signature_help`                            | path, line, character (at arg position)                    |
| Symbols in this file                         | `document_symbol`                           | path                                                       |
| Find symbol across project                   | `workspace_symbol`                          | query + path (strongly recommended)                        |
| Quick fixes available                        | `code_action`                               | path, line, character, end_line, end_character             |
| Rename symbol safely                         | `rename`                                    | path, line, character, new_name                            |
| Who implements this?                         | `implementation`                            | path, line, character                                      |
| Who calls this function?                     | `prepare_call_hierarchy` → `incoming_calls` | path, line, character                                      |
| What does this call?                         | `prepare_call_hierarchy` → `outgoing_calls` | path, line, character                                      |
| What commands does the server offer?         | `capabilities`                              | (optional path) — lists advertised commands                |
| Run a server command (e.g. organize imports) | `execute_command`                           | command (+ command_arguments); dry-run unless `apply:true` |

## Call Hierarchy Pattern

```
// Step 1
lsp_navigation(operation="prepare_call_hierarchy", path="src/api.ts", line=42, character=10)
// → returns call_hierarchy_item

// Step 2
lsp_navigation(operation="incoming_calls", call_hierarchy_item=<item from step 1>)
lsp_navigation(operation="outgoing_calls", call_hierarchy_item=<item from step 1>)
```

## Operational Notes

- **`definition` returns nothing?** The file may not be open/indexed yet. Read it first, then retry.
- **`workspace_symbol` empty?** Always pass `path`. Unscoped queries are best-effort and frequently return nothing. If TypeScript returns "No Project", open the scoped file first.
- **`references`** — query from the _definition site_ for full cross-file coverage; usage-site queries can be partial.
- **`signature_help`** — only valid at call-site argument positions; declaration positions return empty.
- **`workspace_diagnostics`** — tracked push snapshot only, not an active check. Use `lsp_diagnostics` when you need fresh results.
- **`code_action`** — distinguish `quickfix` from generic refactors ("Move to new file"). Generic refactors are not error fixes.
- **`prepare_call_hierarchy`** — server-capability dependent; if unsupported, skip incoming/outgoing calls.

## When NOT to Use LSP Navigation

| Task                          | Use Instead       |
| ----------------------------- | ----------------- |
| Find patterns (`console.log`) | `ast_grep_search` |
| Find text / TODOs             | `grep`            |
| Find files by name            | `glob`            |
| Read file content             | `read`            |

## Golden Rule

**Code intelligence → `lsp_navigation` first. Type/error validation → `lsp_diagnostics` first. Text/pattern search → grep/ast-grep.**
