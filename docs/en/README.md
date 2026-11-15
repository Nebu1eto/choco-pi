# choco-pi documentation

[한국어](../ko/README.md)

These guides explain how to install, configure, and use choco-pi. For an overview, go back to the [project README](../../README.md).

## Guides

- [Install and update](installation.md): requirements, the two install methods, updating, and reloading.
- [Authentication](authentication.md): `/login` providers and credential handling.
- [Set up computer use (macOS)](computer-use.md): installing the helper, permissions, configuration, and removal.
- [Features](features.md): what each group of features does.
- [Common commands](commands.md): the main slash commands and what they do.
- [Installed packages](packages.md): the bundled packages and what each provides.
- [Configuration and customization](configuration.md): profile files, global settings, advisor settings, built-in extensions, and MCP configuration.
- [Use choco-pi in Zed](zed-setup.md): running choco-pi as a Zed ACP agent from a checkout or a standalone install.
- [Web search](web-search.md): `web_search` routing, backends, privacy, and billing.
- [Development](development.md): the pinned toolchain and the verification gates.

## Project records (English only)

These contributor records live in `docs/` and have no Korean version.

- [RPC host bridge](../rpc-host-bridge.md): the contract Waku uses to identify the installed profile and read background-work and goal entries.
- [Verification map](../verification-map.md): what to run before trusting a change to each area of choco-pi.
- [Model-guidance history](../model-guidance-history.md): the sources and decisions behind past model-guidance edits; a historical record that does not affect model routing.
- [Zed ACP compatibility baseline](../zed-acp-compatibility.md): the component versions recorded as the baseline for the Zed integration.
- [Zed command parity](../zed-command-parity.md): each command, classified by whether it completes in Zed without the terminal UI.
- [Zed runtime E2E evidence](../zed-e2e-evidence.md): what was observed, attempt by attempt, when choco-pi ran inside a real Zed.
- [Computer-use E2E validation](../computer-use-e2e.md): the isolated end-to-end harness for computer use and how to run it.
- [On usage limit plan](../on-usage-limit-plan.md): the design plan for the `agentOnUsageLimit` preference.
- [Pi built-in migration plan](../pi-builtin-migration-plan.md): the audit and plan for moving tool search and MCP to Pi's built-ins.
