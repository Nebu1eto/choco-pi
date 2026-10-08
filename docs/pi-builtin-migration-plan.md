# Plan: migrate tool search and MCP to Pi built-ins

Status: proposed; implementation and live validation have not started.

Baseline: choco-pi `2566b0789e40090e0cfad72de6f96feb3791dd0d`, Pi SDK and active host `1.0.4`. Recheck these assumptions before implementation. This document records the inspected behavior and the migration plan; it does not authorize configuration changes, authentication, or server connections.

## Objective and boundaries

Remove the `builtin:tool-search` and `builtin:mcp` registration warnings without losing discovery, execution, permissions, subagent isolation, or Figma tools. Then replace the custom search and MCP adapter with Pi's built-ins where required capabilities have a tested replacement.

Use two distinct milestones:

1. **Containment:** explicitly disable the conflicting built-ins while preserving the custom implementations.
2. **Migration:** prepare replacement behavior, switch ownership, and validate every affected session type before retiring the old implementation.

Do not rename the custom `/mcp` command to run both MCP clients. Do not remove the entire MCP package before preserving its independent Figma extension. Keep replacement of custom `exec` with built-in `codemode` outside scope unless an identified compatibility requirement makes it necessary; decide and authorize that expansion separately.

## Verified baseline and uncertainty

| Finding                                                                            | Evidence and limitation                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| These warnings report registration collisions, not MCP connection failures.        | Installed Pi `dist/core/resource-loader.js`, `omitReplacedExtensions`, keeps the custom registration and omits the replaceable built-in. This does not establish whether any MCP server is healthy. |
| The project disables the three competing built-ins.                                | [`.pi/settings.json`](../.pi/settings.json) contains `-builtin:codemode`, `-builtin:tool-search`, and `-builtin:mcp`.                                                                               |
| The inspected global profile loads the custom extensions without those exclusions. | Observed in the active global settings during diagnosis. Reinspect only relevant fields before applying changes; this machine-specific observation is not a repository invariant.                   |
| The warning proves a conflicting built-in was attempted during that startup.       | Effective exclusion would filter it before collision detection. The exact startup was not reproduced: working directory, project trust, settings state, and explicit overrides remain unresolved.   |
| Active-host and shell-launcher versions differ.                                    | The host readiness check reported `1.0.4`; the shell's `pi` resolved to a Homebrew `0.87.1` installation. Verify the intended executable before any restart or CLI operation.                       |
| These features predate `1.0.0`.                                                    | The installed Pi changelog records built-in codemode, tool search, MCP, and replacement warnings under `0.99.0`. This plan targets the inspected `1.0.4` behavior.                                  |

The prior Fable 5.1 review agreed with the plan after corrections. Its suggestion that subagents do not consume the custom search policy was rejected: [`agent-runner.ts`](../.pi/packages/choco-pi-subagents/src/agent-runner.ts) reads `Symbol.for("choco-pi.tool-search.lean-surface")` in `leanSurfaceNames()` and applies it during tool narrowing. Review conclusions are not substitutes for the source checks below.

## Compatibility decisions required before cutover

| Area                    | Current behavior or gap                                                                                                                                                                                                                                 | Required disposition                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search and declarations | Custom [`tool-search.ts`](../.pi/extensions/tool-search.ts) provides `exec` call guidance and preserves the locked tool declarations. Built-in search activates matching deferred/codemode tools for subsequent model calls and is inactive by default. | Separate discovery from permissions and lean-tool policy. Explicitly activate built-in search and test the intended declaration changes rather than assuming prefix behavior is unchanged.                                                                                                                                       |
| Execution               | Custom `exec` discovery and dispatch are not automatically equivalent to native MCP discovery and execution.                                                                                                                                            | Adapt discovery and calls through supported host APIs; preserve denial checks, result handling, cancellation, and session ownership. Do not bypass the host permission pipeline.                                                                                                                                                 |
| Subagents               | The runner consumes the custom lean-tool policy and narrows tools again at turn end.                                                                                                                                                                    | Preserve the policy independently of custom search. Newly discovered tools must remain usable only within the child's allowed scope; removing the policy must not widen that scope.                                                                                                                                              |
| SDK sessions            | Pi's SDK does not automatically supply CLI built-ins. [`session-bridge.ts`](../.pi/extensions/session-bridge.ts) creates sessions without explicit built-in factories; the subagent loader currently supplies other factories.                          | Add the required `createMcpExtension()` and `createToolSearchExtension()` factories to each supported SDK loader. Include `createCodemodeExtension()` only if the chosen execution design requires it. Preserve extension filtering, binding, and disposal. Audit any other SDK entry points before declaring coverage complete. |
| MCP configuration       | The adapter reads more configuration sources than built-in MCP, which reads global and trusted-project Pi `mcp.json`. Field names, units, merge behavior, tool exposure, and tool naming differ.                                                        | Inventory effective definitions and translate them deliberately. Test duplicate names, project overrides, disabled servers, tool filters, and invalid entries without connecting servers.                                                                                                                                        |
| Authentication          | The adapter's credential storage and OAuth options differ from built-in MCP's `mcp-auth.json`, keyed by server name and URL.                                                                                                                            | Do not copy credentials blindly or assume portability. Determine supported flows and obtain approval for any reauthentication or credential-store change.                                                                                                                                                                        |
| MCP scripts and hooks   | Adapter `mcp`/`mcpScript` helpers, tool names, result shapes, and private hook events are not native equivalents.                                                                                                                                       | Port actual callers and approval/event handling; test error and binary/image results as well as text. Update the MCP scripting skill and other instructions with executable examples.                                                                                                                                            |
| Optional capabilities   | Built-in MCP rejects SSE and does not render MCP Apps. Adapter-specific sampling, elicitation, prompt commands, request signing, OAuth options, and lifecycle controls need usage and parity checks.                                                    | For each used feature, record a supported replacement or an explicitly approved retirement. An unresolved required feature blocks migration. Do not infer absence or parity from documentation silence.                                                                                                                          |
| Figma                   | [`choco-pi-mcp/package.json`](../.pi/packages/choco-pi-mcp/package.json) separately loads native Figma REST/PAT tools. They are not merely adapter MCP clients.                                                                                         | Preserve or extract the Figma extension, skill, authentication path, and dependencies before removing the package.                                                                                                                                                                                                               |

Keeping built-in `codemode` disabled requires an explicit reachability decision. Built-in MCP defaults to `codemode` exposure and can auto-activate that tool. Either prove the retained `exec` bridge supports native MCP tools, or choose tested deferred/direct exposure and activation settings. Do not leave connected tools unreachable or accidentally introduce a second execution interface.

## Implementation sequence

### 1. Contain the warning

- Identify the intended Pi `1.0.4` executable, active agent directory, working directory, project trust, and effective built-in selection.
- With approval to write the global profile, merge the exclusions into its existing extension list. Preserve unrelated entries and user settings.
- Prefer a targeted settings change when only containment is authorized. [`scripts/install-profile.mjs`](../scripts/install-profile.mjs) propagates the policy but also updates other profile settings and links; inspect that broader scope before using it.
- Have the user restart/reload with the intended runtime, or obtain explicit permission to launch a separate Pi process. Verify startup both in this checkout and outside it.

**Exit gate:** neither collision warning appears, each custom interface remains available, and existing operations still work. A readiness-check pass alone is insufficient: that tool cannot inspect startup warning history.

### 2. Inventory requirements and establish regression coverage

- Record configured server names and non-secret field names, configuration sources, transports, exposure requirements, and used capabilities. Do not put tokens, headers, credential values, or private configuration copies in this repository.
- Inventory callers of `mcp`, `mcpScript`, adapter tool names, private hook events, and Figma tools. Include SDK loaders and provider-specific tool handling.
- Add regression coverage at real production boundaries for discovery, permission denial, child narrowing, script results, and late tool registration.
- Mark every compatibility row above as **supported**, **replacement required**, or **retirement approved**. Record evidence and the owner of each unresolved decision.

**Exit gate:** no required behavior has an unknown disposition; failing tests describe the remaining implementation work rather than merely duplicating fixture constants.

### 3. Prepare replacements while custom ownership remains active

- Extract the lean-tool and permission policy; adapt `exec` discovery and execution to native metadata and supported host APIs.
- Update subagent narrowing and SDK factory wiring together. Respect disabled extensions and read-only/denied child scopes; bind extensions so MCP startup handlers run.
- Preserve Figma before changing package loading. Port scripts, hooks, result rendering, and adapter-specific context reporting.
- Prepare translated MCP configuration without applying it to live profiles or connecting servers. Translate fields such as `disabled` to `enabled`, timeout units, and tool selectors only after schema validation.
- Implement lifecycle handling with synchronous invalidation, owner/generation checks after awaits, and exactly-once settlement. Unrelated failures must not be swallowed as stale-context errors.
- Update touched vendored packages' `VENDORED.md` records. Never edit generated dependencies.

**Exit gate:** focused offline tests cover the replacement paths, permissions remain enforced, Figma is preserved, and required capability gaps are resolved. No duplicate live MCP client is introduced during preparation.

### 4. Cut over code and profile policy coherently

- Stop loading the custom search registration and MCP adapter entry point. Enable the built-in replacements and make `tool_search` active in every supported session type.
- Apply approved configuration changes while sessions are stopped; start the replacement only after the former client has shut down.
- Remove obsolete exclusions from both project and global settings. Simply deleting them from the project file is insufficient: the installer retains prior global exclusions for built-ins no longer named by project policy.
- Update the installer and its tests, readiness checks, README, MCP scripting instructions, tool renderers, and affected provider tests. Revise checks that currently require built-in MCP and search to be disabled.
- If modifying installer logic, migrate the changed JavaScript logic to Node-erasable TypeScript and update its callers/tests as required by [`AGENTS.md`](../AGENTS.md). Do not add new logic to the legacy JavaScript file.
- If adding a package to `.pi/settings.json`, run the repository-required `pnpm install:profile` after its broader write scope is authorized. Preserve load-bearing vendored dependency trees.

**Exit gate:** code, global/project configuration, SDK loaders, and documentation agree on one owner per interface. Keep the prior code and settings checkpoint available until validation passes.

### 5. Validate, then retire obsolete implementation

All rows below are **pending**. The documentation change itself does not satisfy them.

| Gate                                        | Required evidence                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offline configuration and installer tests   | Correct merge precedence, field translation, exclusion removal, disabled-server handling, and preservation of unrelated settings. No live server connections.                                             |
| Search/execution regression tests           | First-turn availability; successful, repeated, and no-result search; late registration; direct/deferred/codemode/hidden tools; result/error handling; supported `exec` calls.                             |
| Isolation and permissions                   | Denied and read-only child operations stay denied, including indirect calls. Search cannot escape scope. Approval hooks still run on native MCP paths.                                                    |
| Repository gates                            | `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck`, and `pnpm test` finish successfully on the implementation revision, plus each changed package's required checks. No suppression or weakening of gates.   |
| Authorized live session coverage            | Root CLI, a subagent, and an independently bridged SDK session have the intended tools and can perform an approved operation. Check any additional supported SDK/ACP entry points found during inventory. |
| Lifecycle and provider behavior             | Reload, resume, tree/fork, compaction, cancellation, shutdown, provider declarations, and resource disposal preserve the intended behavior. No stale-session calls or duplicate clients.                  |
| Startup and user-facing behavior            | Zero collision warnings inside and outside the checkout; exactly one provider for each interface; Figma and required MCP features still work.                                                             |
| Authorized authentication/server validation | Required transports and OAuth flows work against explicitly approved servers. `pi mcp list` may connect servers; it is not an offline inventory command.                                                  |

Run runtime checks against the exact implementation checkpoint and repeat affected evidence after corrective changes. A separate live Pi process requires explicit user authorization. If authorization or required infrastructure is unavailable, leave the corresponding row blocked, not passed.

Retire obsolete code, dependencies, and compatibility helpers only after these gates pass. Do not delete credential stores or session history as migration cleanup.

## Rollback and stop conditions

Before cutover, record the implementation revision and obtain approval for private settings backups in a user-approved location outside the repository. Preserve pre-existing backups and avoid writing credentials into task artifacts.

Stop the cutover if required tools are unreachable, a denied operation becomes callable, approval hooks stop firing, Figma disappears, a required capability is unsupported, or a live client cannot shut down cleanly.

Rollback restores the previous code/profile selection, custom entry points, and explicit built-in exclusions as one coordinated change. Stop the replacement client before starting the former one, and rerun the containment checks. Use reviewed corrective/revert changes; do not discard unrelated work with a reset. Coordinate restoration of external settings with the user, and do not silently overwrite newly issued credentials or revoke them as part of rollback.

## Source map

Repository evidence is linked above. Installed upstream evidence is under `node_modules/@earendil-works/pi-coding-agent/` at version `1.0.4`:

- `CHANGELOG.md`, `0.99.0`: feature introduction and collision warnings.
- `docs/configuration.md` and `docs/packages.md`: settings scope, project trust, and built-in selection.
- `docs/mcp.md`: server configuration, authentication, exposure, resources, permissions, replacement behavior, and SDK requirements.
- `docs/sdk.md`, **Codemode and MCP**: explicit factories, activation, and extension binding.
- `dist/core/resource-loader.js`, `omitReplacedExtensions`: conflict ownership and warning construction.
- `dist/extensions/tool-search/tool.js`, `searchAndLoad`: searchable exposure and activation behavior.

Refresh these references when changing the target Pi version. No live MCP compatibility or successful warning-free restart was established during the planning audit.
