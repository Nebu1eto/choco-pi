# Vendored source record

## Provenance

- Upstream package: `pi-mcp-adapter`
- Upstream version: `2.26.1`
- Registry tarball SHA-1: `8c1a9259aaf18de05fdab71c10ae7c0fdb0d4ff6`
- Vendored on: `2026-08-20`
- Acquisition: `npm pack pi-mcp-adapter`

All shipped root TypeScript sources, runtime helper files, assets, `skills/mcp-scripting`, and `LICENSE` came from the registry tarball. The fork changes package identity and local development metadata, replaces the upstream README with local integration documentation, and adds this record and `tsconfig.json`. Protocol IDs, OAuth credential keys, environment variables, and extension behavior retain their upstream values for compatibility.

## MCP specification compliance

The upstream checks passed without protocol code changes:

- **Latest revision:** `package.json` pins `@modelcontextprotocol/client` and `@modelcontextprotocol/core` 2.0.0. Their modern protocol implementation supports revision `2026-07-28`. The adapter exposes `"2026-07-28"` and `"auto"` in `types.ts:433-439`, and maps them to SDK pin and automatic negotiation modes in `server-manager.ts:82-93`.
- **Backward-compatible negotiation:** `protocolVersion: "auto"` selects SDK `{ mode: "auto" }`, which probes the modern `server/discover` path and falls back to the SDK's pre-2026 initialize flow when the server is definitively legacy. An omitted value or `"legacy"` preserves the legacy SDK behavior. See `types.ts:433-439` and `server-manager.ts:82-93,691-700`.
- **Transports:** stdio uses `StdioClientTransport` in `server-manager.ts:16,477-505`. HTTP first uses `StreamableHTTPClientTransport`, and compatible endpoint failures fall back to legacy `SSEClientTransport`; explicit Agent Plugin transport choices remain fixed. See `server-manager.ts:77-80,826-962`.
- **OAuth:** authorization discovery and completion remain in `mcp-auth-flow.ts`; provider and token behavior remain in `mcp-oauth-provider.ts` and `mcp-auth.ts`; the local callback listener remains in `mcp-callback-server.ts`; server connection challenges remain wired in `server-manager.ts:826-962`; lifecycle setup and shutdown remain wired in `index.ts:16,346-460`. The public `./oauth` export still points to `oauth.ts`.

The npm tarball contains no tests or conformance fixtures, so there was no upstream protocol-negotiation unit test to run.

## Runtime dependencies

All upstream direct dependencies were installed into this package's `node_modules`, including their registry-resolved transitive dependencies and platform-specific optional binaries. Resolved direct versions are:

- `@modelcontextprotocol/client@2.0.0`
- `@modelcontextprotocol/core@2.0.0`
- `@modelcontextprotocol/ext-apps@1.7.5`
- `@napi-rs/keyring@1.3.0`
- `ajv@8.20.0`
- `ajv-formats@3.0.1`
- `cross-spawn@7.0.6`
- `open@10.2.0`
- `recheck@4.5.0`
- `smol-toml@1.8.0`
- `strip-json-comments@5.0.3`
- `zod@4.4.3`

The installed peer closure also contains `@modelcontextprotocol/sdk@1.30.0`, required by `@modelcontextprotocol/ext-apps`. The source import audit found direct runtime imports of client/core, keyring, AJV and AJV formats, cross-spawn, open, recheck, smol-toml, strip-json-comments, and zod. `@modelcontextprotocol/ext-apps` has no direct import in the shipped TypeScript or helper scripts; it remains vendored because it is an upstream direct runtime dependency. Host-provided `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` resolve from the parent choco-pi installation and were typechecked against version 0.84.2 packages.

## Source changes relative to upstream 2.26.1

### Owned-UI fence (`owned-ui.ts`, `runtime-owner.ts`)

Upstream keeps the fence in `runtime-owner.ts` and resolves each member with
`Reflect.get(target, property, receiver)`. The fork moved it to `owned-ui.ts`
so the tests load it under Node's strip-only TypeScript mode, and replaced
`Reflect.get` with a prototype-chain descriptor walk to satisfy the harness
`anti-slop/no-reflect-get` rule.

A descriptor walk is not equivalent to `[[Get]]`. Pi exports its global theme
as `new Proxy({}, { get })` over an empty target, so it reports no own
property descriptor for any member and no prototype carries one. Every read
through the fence therefore resolved to `undefined`, and `ui.theme.fg(...)` in
`init.ts` threw `ui.theme.fg is not a function` in every TUI session. The trap
now falls back to an ordinary member read on the target when the walk finds no
descriptor at all, which restores exotic `[[Get]]` behavior without
`Reflect.get`. The fence is unchanged: a stored value is still replayed at any
time, a live read still happens only while the owner is active, and a method
fetched before deactivation still no-ops.

### Footer status text (`status-text.ts`, `init.ts`)

Upstream `init.ts` writes
`ui.setStatus("mcp", ui.theme ? ui.theme.fg("accent", status) : status)`. That
guard tests `theme` for truthiness and then calls `.fg` on it, so it cannot
catch a theme whose `fg` is missing or unreachable. `updateStatusBar` now
calls `formatAccentStatusText` from the added `status-text.ts`, which returns
the plain text whenever the host cannot colour it. The module is separate so
it loads under Node's strip-only mode for `tests/mcp-status-text.test.ts`.

### Initialization failure boundary (`index.ts`)

Upstream calls `updateStatusBar(nextState)` directly in the initialization
`then` handler, where any throw lands in the `catch` that reports
`MCP initialization failed` and, when it runs before the state is published,
stops the whole extension runtime. The status-bar update now has its own
boundary and logs a warning instead. Genuine initialization failures still
reach the original `catch` unchanged.

## Configuration reads

`config.ts:389-456` automatically merges these files in increasing precedence:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. the Pi global override, normally `~/.pi/agent/mcp.json`
5. `<project>/.mcp.json`
6. `<project>/.pi/mcp.json`

`agent-dir.ts:6-31` applies host `piConfig.name`, `piConfig.configDir`, and `<APP_NAME>_CODING_AGENT_DIR` overrides to the Pi-owned paths. `config.ts:64-82,526-617` conditionally reads host-specific files selected through `imports` or enabled fallback discovery. `agent-plugin-loader.ts:34-103` conditionally reads `plugin.json` and `mcp.json` under each configured Agent Plugin path. The package README lists the conditional host paths.
