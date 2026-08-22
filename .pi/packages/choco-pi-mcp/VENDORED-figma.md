# Vendored Figma extension

## Provenance

- Upstream: https://github.com/emanuelcasco/pi-mono-extensions
- Upstream subdirectory: `extensions/figma`
- Base commit: `78e39a8d939276bde2459801df3b2e7bdceec62d` (`78e39a8`)
- Extension version: `0.2.2`
- Forked on: `2026-08-22`
- License: MIT (`LICENCE.md` copied verbatim to `figma/LICENSE`)

This package integrates the upstream Figma extension as a second Pi extension entry. The existing MCP entry remains first and unchanged, while `figma/index.ts` gives the Figma tools their own extension family. The package supersedes both `pi-mcp-adapter` and `pi-mono-figma`.

## What was taken

- `extensions/figma/index.ts` and all 11 modules under `extensions/figma/src/`
- `extensions/figma/skills/figma/SKILL.md`
- All six upstream tests and four JSON fixtures
- The required `extensions/common/src/` modules: `auth.ts`, `auth-config.ts`, `http-client.ts`, `rate-limiter.ts`, `cache.ts`, `tool-result.ts`, and `errors.ts`
- The repository-root MIT license

The `pi-common` barrel was omitted because the Figma sources import only the listed modules directly. Upstream package/build metadata, README, changelog, and docs were not copied; this package owns loading and provenance, and the native skill contains the user-facing workflow.

## Divergences from upstream

- Relative TypeScript imports use explicit `.ts` specifiers instead of upstream `.js` specifiers so jiti and Node strip-types resolve them without failed `.js` probes.
- Bare `pi-common/*` imports point to the vendored `figma/common/*.ts` modules.
- `@sinclair/typebox` imports in `figma-schemas.ts` and `auth-config.ts` use the host-provided `typebox` peer. Pi's extension loader aliases both names to host TypeBox v1 at runtime; matching that module during typecheck avoids hiding runtime incompatibilities behind a separately installed TypeBox 0.34. The schemas use only `Type.Object`, `Type.String`, `Type.Number`, `Type.Boolean`, `Type.Array`, `Type.Union`, `Type.Literal`, and `Type.Optional`, which TypeBox v1 provides, so no schema behavior was adapted.
- `MissingAuthTokenError`, `ApiError`, and `TtlCache` declare and assign their fields explicitly instead of using constructor parameter properties. This preserves behavior and makes the source valid for Node strip-only TypeScript.
- Tests live at `tests/figma-*.test.ts`; `code-connect.test.ts` was prefixed to fit that package test glob. Their imports target `figma/src/*.ts`, and fixture reads target `figma/fixtures/`.
- `package.json` adds the Figma entry, package supersession marker, keyword, shipped `figma` directory, and updated description. The existing `skills` files entry already includes `skills/figma/`.
- `tsconfig.json` includes the vendored source and Figma tests.

The Figma skill was copied without content changes. Its tool names, authentication paths, and instructions remain valid in the integrated location.

### Anti-slop type hardening

The vendored Figma source and tests are held to the repository's first-party anti-slop lint standard. The hardening is type-only and behavior-preserving: Figma REST JSON now enters through a named recursive value model, node-tree helpers consume that model instead of `unknown` dictionaries, and checked predicates retain concrete scalar and object evidence. Assertions remain only where a runtime invariant cannot be expressed in TypeScript, with the invariant documented at the site.

The 21 registered `figma_*` tool names and their TypeBox schemas are unchanged. The authentication resolution and write order, HTTP request serialization and response handling, retry/rate-limit behavior, cache TTL behavior, and conditional property omission semantics are also unchanged. In particular, the hardening does not replace proxy/property access mechanisms or convert omitted request properties into properties set to `undefined`.

## Authentication compatibility

The upstream resolution order is preserved: an in-memory override, then `FIGMA_TOKEN`, then `~/.pi/agent/auth.json` at `figma.token`. `/figma-auth` and `figma_configure_auth` write that JSON path and install an in-memory override for the current session. No token names, paths, commands, or storage behavior were changed.
