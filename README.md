<h1>
  <img src="assets/choco-pi-logo.svg" alt="choco-pi logo" width="40" height="40" align="absmiddle" />
  choco-pi
</h1>

[한국어](README.ko.md)

choco-pi is a project-aware profile for the [Pi](https://pi.dev/) coding agent. It adds operating rules, implementation and review workflows, subagents, code intelligence, research and automation tools, and a Nord terminal interface. Its packages, skills, and agent definitions load from the repository checkout. Optional tools, such as the `agent-browser` CLI, MCP servers, and search backends, are not part of the repository.

## Highlights

- [Operating rules and workflows](docs/en/features.md#operating-rules-and-workflows): shared rules for scope, authority, and evidence, with skills for implementation, review, verification, and signed local commits.
- [Agents and orchestration](docs/en/features.md#agents-and-orchestration): specialist subagents that run in the background, in isolated Git worktrees, or as dependency-ordered workflows.
- [Review and verification](docs/en/features.md#review-and-verification): `/review` hands a frozen diff to a fresh, read-only reviewer, and `/diff` and `/review-assist` show the changes in the terminal.
- [Sessions, context, and goals](docs/en/features.md#sessions-context-and-goals): persistent goals, checkpoints, context-limit presets, and server-side or local compaction.
- [Code intelligence and Code Mode](docs/en/features.md#code-intelligence-and-code-mode): LSP, ast-grep, and symbol tools, and an `exec` tool that runs several tool calls in one step.
- [Research and integrations](docs/en/features.md#research-and-integrations): one `web_search` tool over several search backends, Pi's built-in MCP, browser automation, and macOS computer use.
- [Models and usage](docs/en/features.md#models-and-usage): controls for reasoning effort and Fast mode, and provider usage and reset times in `/usage`.
- [Interface](docs/en/features.md#interface): a fullscreen TUI with Nord themes, a `/status` dialog, usage statistics, and Mermaid diagrams in the terminal.

## Quick start

You can install choco-pi in two ways: as a standalone `choco-pi` command, which runs its own pinned Pi and keeps its state in `~/.choco-pi`, or as a profile in a Pi you installed yourself, which shares `~/.pi/agent` with `pi`.

To install the standalone command:

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
sh choco-pi/install.sh
choco-pi
```

When `choco-pi` opens, run `/login`.

To install the profile into your own Pi instead, first [install Pi without Homebrew](docs/en/installation.md#install-pi-without-homebrew) and install [mise](https://mise.jdx.dev/), then run:

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

mise install
pnpm --version

pnpm install --frozen-lockfile
npm run install:profile
pi
```

- [Requirements](docs/en/installation.md#requirements) lists the platforms and tools each method needs.
- [Install and update](docs/en/installation.md) covers installer flags, first-run settings, the runtime choice, updates, and removal.
- [Authentication](docs/en/authentication.md) lists the `/login` providers.

## Documentation

| Page                                                        | Covers                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Install and update](docs/en/installation.md)               | Requirements, the two install methods, updating, and reloading                               |
| [Authentication](docs/en/authentication.md)                 | `/login` providers and credential handling                                                   |
| [Set up computer use (macOS)](docs/en/computer-use.md)      | Installing the helper, permissions, configuration, and removal                               |
| [Features](docs/en/features.md)                             | What each group of features does                                                             |
| [Common commands](docs/en/commands.md)                      | The main slash commands and what they do                                                     |
| [Installed packages](docs/en/packages.md)                   | The bundled packages and what each provides                                                  |
| [Configuration and customization](docs/en/configuration.md) | Profile files, global settings, advisor settings, built-in extensions, and MCP configuration |
| [Use choco-pi in Zed](docs/en/zed-setup.md)                 | Running choco-pi as a Zed ACP agent from a checkout or a standalone install                  |
| [Web search](docs/en/web-search.md)                         | `web_search` routing, backends, privacy, and billing                                         |
| [Development](docs/en/development.md)                       | The pinned toolchain and the verification gates                                              |

Contributor records, such as the RPC host bridge contract and the verification map, are in English only; [docs/README.md](docs/README.md) lists them.

## Security and authority

Keep OAuth tokens, API keys, other credentials, machine-local configuration, and local overrides out of Git. choco-pi's operating rules require explicit approval for remote writes, deployments, pull requests, publication, and any other change outside the local machine.

## License status

Every local package manifest declares the MIT license. The repository has no root license file, so this README does not assign a license to the repository as a whole.

## References

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
