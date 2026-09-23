# choco-pi-agent-browser

Vendored choco-pi fork of [`pi-agent-browser-native`](https://github.com/fitchmultz/pi-agent-browser-native) 0.5.0. Pi loads `extensions/agent-browser/index.ts` directly; this package has no compilation or publication workflow.

The extension keeps the upstream tool names, including `agent_browser` and the optional `agent_browser_web_search` companion. It requires `agent-browser` as a separate executable on `PATH`; the CLI is not included. Source-verified compatibility profiles cover 0.34.0, 0.35.2, 0.36.0, 0.37.1, and 0.38.1; the live binary matrix remains a separate validation gate. Older, intermediate, malformed, and newer versions produce bounded advisory warnings rather than a blanket version failure; operations still fail when a concrete required safety capability is unavailable.

Run the read-only doctor with `node scripts/doctor.ts`. It performs side-effect-free version probes and source checks; it does not install, upgrade, launch, or contact a browser.

The wrapper binds discovery, version probing, scripts, QA, cleanup, and normal commands to one resolved executable fingerprint per invocation. Snapshot delta baselines are bounded and scoped by namespace, session, wrapper-owned tab/document generation, URL, and snapshot options; incompatible deltas receive at most one read-only full refresh. WebMCP parameters and detached invocation ownership, and recording video/contact-sheet destinations, are validated before execution.

Host-provided Pi packages and `typebox` are peer dependencies. See `VENDORED.md` for provenance and fork differences, and `AGENTS.md` before changing the fork.
