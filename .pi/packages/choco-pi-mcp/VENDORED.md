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

### Deferred runtime imports

The fork defers connection initialization, OAuth, proxy execution, MCP scripting, direct-tool execution, and command UI modules until their tool, command, or lifecycle handler runs. Registration still reads the effective config and metadata cache and emits the same tool schemas, command names, event channels, cached prompt commands, and direct-tool registrations. This is a load-time-only change; registered behavior and protocol identifiers are unchanged.

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

### Command lifecycle ownership (`index.ts`, `prompts.ts`)

The fork fences slash-command continuations against Pi session replacement and
reload. `/mcp` and `/mcp-auth` snapshot the current runtime owner and lifecycle
generation before their deferred command-module import, then stop if either is
stale before reading the command context. Later command awaits are checked
again before raw context actions such as `reload`, and command UI is owned by
the same runtime snapshot.

Cached MCP prompt commands likewise snapshot their state owner and signal
before lazy connection and prompt retrieval. An invalidated owner suppresses
all later context, UI, and `sendUserMessage` access while failures unrelated to
owner invalidation retain the existing notification behavior.

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

### Status write boundary (`status-text.ts`, `init.ts`, `proxy-modes.ts`, `index.ts`)

Upstream lets a footer status write fail whatever asked for it. `init.ts`
calls `ui.setStatus` unguarded, `updateStatusBar` has nineteen call sites
across initialization, lifecycle callbacks, slash commands, and tool calls,
and each one propagates a throw from the host UI. That is how the theme
defect above surfaced as `MCP initialization failed`.

`status-text.ts` now owns the boundary. `writeStatus` and `writeAccentStatus`
guard exactly the host interaction — resolving `theme` on the UI object and
the `setStatus` call — and hand any error to a reporter instead of the caller.
Deriving the status text from local state stays outside the guard: a throw
there is a defect in this package, and swallowing it would hide the class of
bug the guard exists to expose. `createStatusWriteFailureReporter` logs each
distinct failure once, because the status bar repaints on every server state
change and an unusable host UI would otherwise repeat one warning for the
whole session. `init.ts` binds it to `logger.warn` and `formatTerminalError`
and exports `writeMcpStatus`.

Every write to the `mcp` status key now goes through that boundary:
`updateStatusBar` itself, the startup `connecting to N servers...` status, the
footer clear when `mcpFooterStatus` is `off`, and the `connecting to X...`
status in `lazyConnect` and in the proxy `connect` and `call` modes. The last
three sat inside `try` blocks whose `catch` records a server failure, so a
refused status write was recorded upstream as a connection failure and put a
server into failure backoff it had never been asked to reach.

The `mcp-auth` writes in `commands.ts` are left unguarded. They report
progress inside an interactive OAuth flow that also drives `ui.confirm`,
`ui.input`, and `ui.notify`; a UI that cannot accept a status write cannot
carry that flow either, so fencing `setStatus` alone would not make the
command survivable, and the flow already reports its own failures.

The fork's earlier `try/catch` around `updateStatusBar(nextState)` in the
`index.ts` initialization handler is removed. The failures it caught can no
longer reach it, and the site is not otherwise special: `state` is assigned
before that line, so the rejection path no longer tears the runtime down.
Anything still escaping `updateStatusBar` is a defect in this package and
should stay loud rather than be demoted to a warning at one of nineteen
callers.

## Configuration reads

`config.ts:389-456` automatically merges these files in increasing precedence:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. the Pi global override, normally `~/.pi/agent/mcp.json`
5. `<project>/.mcp.json`
6. `<project>/.pi/mcp.json`

`agent-dir.ts:6-31` applies host `piConfig.name`, `piConfig.configDir`, and `<APP_NAME>_CODING_AGENT_DIR` overrides to the Pi-owned paths. `config.ts:64-82,526-617` conditionally reads host-specific files selected through `imports` or enabled fallback discovery. `agent-plugin-loader.ts:34-103` conditionally reads `plugin.json` and `mcp.json` under each configured Agent Plugin path. The package README lists the conditional host paths.

## Hook MCP-tool bridge (`index.ts`)

The choco-pi fork listens on the shared `choco-pi-hooks:mcp-call` event bus
channel. `choco-pi-hooks` uses this private cross-extension bridge to execute
Claude-compatible `type: "mcp_tool"` hook handlers through the adapter's
already-connected MCP clients. The bridge waits for initialization, converges
the requested server, forwards cancellation, and returns only text content in
the command-hook stdout shape. It never starts a separate OAuth or connection
flow, matching Claude Code's MCP hook behavior.
