# choco-pi-agent-browser

Vendored choco-pi fork of [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) 0.5.0. Pi loads `extensions/agent-browser/index.ts` directly; this package has no compilation or publication workflow.

The extension keeps the upstream tool names, including `agent_browser` and the optional `agent_browser_web_search` companion. It requires `agent-browser` 0.34.0 as a separate executable on `PATH`; the CLI is not included in this package. The extension checks the installed CLI against `scripts/agent-browser-target.mjs`.

Host-provided Pi packages and `typebox` are peer dependencies. See `VENDORED.md` for provenance and fork differences, and `AGENTS.md` before changing the fork.
