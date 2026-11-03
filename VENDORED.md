# Vendored and harness-wide divergences

Package-level divergences live in each package's `VENDORED.md`. This file records harness-wide notes.

## 2026-11-03: validation moves from TypeBox to pi-schema

Validation uses `@earendil-works/pi-schema`. `typebox` (host alias, `^1.3.29`) is imported only inside a package's `schema-bridge.ts`, where `Type.Unsafe` wraps a pi-schema object for `registerTool` / `defineTool` (Pi 1.5.0 still requires a TypeBox schema there). The root bridge is `.pi/extensions/lib/schema-bridge.ts`.

One-time prompt-prefix change: tool JSON schemas now serialize differently for the same tool, so the provider prompt cache misses once per tool after the upgrade, then is stable again.

- Literal unions (`StringEnum`, `Type.Union` of literals) serialize as `{ "enum": [...] }` without `type` instead of `anyOf` of `const`.
- Closed objects add `additionalProperties: false`; open objects (the TypeBox default) are built with `{ open: true }` and keep the previous behaviour.
- Numbers that carry finite bounds add `minimum` / `maximum` (`Number.MAX_VALUE`) because pi-schema `num()` accepts NaN and the infinities, which TypeBox rejected. In-process values use `.pi/extensions/lib/finite-number.ts` (`finiteNum`).
