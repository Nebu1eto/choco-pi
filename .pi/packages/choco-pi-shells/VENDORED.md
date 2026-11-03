# Divergences

## 2026-07 — TypeBox to pi-schema migration (unit C11)

First-party package; this file records only the migration.

- Tool parameter schemas (`src/index.ts`) use `@earendil-works/pi-schema` builders (closed objects, same names, descriptions, min/max) wrapped by `hostParams` in `src/schema-bridge.ts`, the only file importing `typebox` (`Type.Unsafe`), because `registerTool` still requires a TypeBox schema.
- `src/notification-gate.ts`: persisted pending-entry validation uses a compiled pi-schema validator. Numbers keep finite bounds (TypeBox rejected NaN/Infinity); the entry stays open at the top level and closed for `data` and shells, as before.
- `src/child-session.ts`: the registry check is a plain predicate (object, not array/function, with a callable `isChildSessionId`).
