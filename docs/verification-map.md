# Verification map

This guide is for people changing choco-pi itself. It answers one question: I changed X; what must I run before I trust it? The `verify` skill also reads this file as the repository's verification map when a `verifier` agent reproduces review claims here.

## Required gates

Every root code change runs all four gates before completion (`AGENTS.md`):

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT pnpm test
```

Run `pnpm test` with that prefix whenever the shell was started by Pi, which is the case for every agent tool call. A Pi session exports those five variables to the commands it runs. `.pi/packages/choco-pi-subagents/tests/scratch-lineage.test.ts` starts child sessions from its own fixture session and expects their system prompt to name the fixture's scratch directory. The runner builds that line with `scratchPromptLine`, which takes the lineage root from an inherited `PI_ROOT_SESSION_ID` before anything else (`.pi/extensions/lib/scratch-path.ts`), so under a Pi session the child names the outer session's directory and the test fails. The other variables are unset for the same reason: they describe the outer session, not the one under test.

`pnpm fmt:check` covers Markdown too. To run one test file while working, bound it (see [Hazards](#hazards)):

```sh
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT \
  NODE_OPTIONS=--max-old-space-size=512 node --test --test-timeout=60000 tests/<file>.test.ts
```

## By area

Unit tests cover logic. They cannot show that an extension loads in a real Pi, that a command reaches its handler, or what the terminal draws. The right column lists what has to be observed in a separate Pi process or another real run.

| You changed                                                                                          | Focused tests                                                                                                        | Also needed                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict blocks (`.pi/extensions/lib/verdict-blocks.ts`)                                              | `tests/verdict-blocks.test.ts`                                                                                       | Nothing beyond the focused tests.                                                                                                                                                                                    |
| Subagent runs, review and verification rounds, verdict recording (`.pi/packages/choco-pi-subagents`) | The package's `tests/`, including `verdict-record*.test.ts`, `review-rounds*.test.ts`, `verification-rounds.test.ts` | A test Pi with a scripted model and the package entry: launch a reviewer or verifier and read the `Verdict record:` line in its result. The [formal check](#formal-model-and-drift-check) when covered code changed. |
| `/diff` pane (`.pi/extensions/diff`, `.pi/extensions/lib/changes`)                                   | `tests/diff-*.test.ts`                                                                                               | A fullscreen test Pi driven through Rex: open the pane, capture the screen at several widths, including one too narrow for the pane.                                                                                 |
| `/review-assist` (`.pi/extensions/review`)                                                           | `tests/review-*.test.ts`                                                                                             | The same, with `/review-assist` on a scratch repository; check that records land in the scratch agent directory.                                                                                                     |
| ACP adapter (`.pi/packages/choco-pi-acp`)                                                            | `pnpm --dir .pi/packages/choco-pi-acp test`                                                                          | The [real-Pi suites](#acp-real-pi-suites).                                                                                                                                                                           |
| Workflow skills, review policy, agent roles (`.pi/skills`, `.pi/review-policy.md`, `.pi/agents`)     | `tests/workflow-policy.test.ts` (frontmatter rules and the example `choco-pi-review` and `choco-pi-verdict` blocks)  | None beyond the tests.                                                                                                                                                                                               |
| Code covered by a `formal/**/coverage.json`                                                          | The model or property test the record names                                                                          | The [drift check](#formal-model-and-drift-check).                                                                                                                                                                    |

## Running a test Pi without credentials

Extension-host and TUI checks use a separate Pi process that cannot touch your own configuration and needs no model account.

1. **Scratch directories.** Make a scratch `HOME`, a scratch agent directory for `PI_CODING_AGENT_DIR`, a scratch `TMPDIR`, and a small Git repository to use as the working directory. In the agent directory, a `settings.json` with `"tuiMode": "fullscreen"` gives the fullscreen interface the diff pane needs, and `"lastChangelogVersion"` set to the Pi version marks that version as already seen, so Pi neither treats the start as a new install nor shows its changelog.
2. **A scripted model.** Write an extension that registers a provider with `pi.registerProvider` whose `streamSimple` comes from `createFauxCore` in `@earendil-works/pi-ai`, and answer each turn with scripted assistant messages and tool calls. `.pi/packages/choco-pi-subagents/tests/e2e-revival/faux-extension.ts` is a committed example. Nothing leaves the machine and nothing is billed.
3. **Explicit extensions.** Start Pi with `-ne` (no discovered or built-in extensions) and load only what the check needs with `-e <path>`: the scripted model and the worktree's own extension or package entry files. Add `-ns`, `-np`, and `-nc` to drop skills, prompt templates, and `AGENTS.md` files when the check does not need them, `--offline` to skip startup network calls, and `--no-session` when nothing should persist. Unset the five session variables from [Required gates](#required-gates) unless the check sets them on purpose.
4. **Drive it through Rex.** Start the command in a new Rex window (`rex window new -s <session> <name> -c <repo> --json -- sh -c '<command>'`), set the terminal size with `rex block call -s <session> -b <block> resize '{"columns":170,"rows":50}'`, type with `rex send`, press keys with `rex send-key`, and read the screen with `rex capture --trim`. Save every capture to a file and cite the file for each observation.
5. **Clean up.** Close every Rex window you opened and stop every Pi process you started.

A launch command has this shape:

```sh
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT \
  HOME=<scratch>/home TMPDIR=<scratch>/tmp PI_CODING_AGENT_DIR=<scratch>/agent \
  pi -ne -e <scratch>/scripted-model.ts -e <worktree>/.pi/extensions/diff/index.ts --offline --no-session
```

## ACP real-Pi suites

`pnpm --dir .pi/packages/choco-pi-acp test` uses a fake Pi. Two cases spawn a real one and are skipped unless `PI_ACP_REAL_PI=1` is set: one in `tests/component-rpc-lifecycle.test.ts` and one in `tests/phase4-command-parity.test.ts`, which checks that `/status`, `/preferences`, `/agents`, `/btw`, and `/review-assist` settle against real Pi.

```sh
PI_ACP_REAL_PI=1 pnpm --dir .pi/packages/choco-pi-acp test
```

They need a working `pi` on `PATH`, or its path in `PI_ACP_PI_COMMAND`. The adapter starts Pi in RPC mode with the inherited environment, so set the scratch `HOME` and `PI_CODING_AGENT_DIR` here as for any test Pi. [Zed command parity](zed-command-parity.md) records what these runs observed.

## Formal model and drift check

`formal/tla/subagent-run` models the subagent run lifecycle in `AgentManager` and is checked with TLC through the `formal-verify` skill's wrapper. `formal/property/*` record which code the property tests `tests/prop-*.test.ts` cover. The first check applies when you change code a model covers; the second tells you whether you did.

```sh
node .pi/skills/formal-verify/scripts/drift.ts affected --base <review base>
node .pi/skills/formal-verify/scripts/drift.ts check
```

`affected` exits 3 when the changed files are covered, and `check` exits 3 when any covered entry changed since its record. Either way, re-run the artifact the record's `command` names, and only after it passes record the new hashes with `drift.ts update --file <coverage.json>`. The drift check compares text, so a pass says nothing about behaviour.

The model check needs Java 11 or newer and the pinned TLA+ tools, downloaded once and never by the checker itself:

```sh
node .pi/skills/formal-verify/scripts/tlc-setup.ts --dir formal/.tools
node .pi/skills/formal-verify/scripts/check-all.ts --only subagent-run --tools-dir formal/.tools
```

`formal/.tools/` is ignored by Git. `check-all.ts` runs the base model and every mutation and exits 0 only when each expectation holds. A pass covers the model within its bounds, not the code. `tests/tlc-run.test.ts` skips its real-TLC cases when the jar or Java is missing, so a green `pnpm test` does not prove the model was checked.

## Hazards

- **Redirect `HOME`, not only `PI_CODING_AGENT_DIR`.** Some code resolves paths from the home directory regardless of the agent directory: the usage cache is always `~/.pi/agent/choco-pi/usage-cache.json`, and the hooks package reads `~/.claude/settings.json`. A test Pi with only the agent directory redirected still reads your hooks and writes into your real home.
- **Never pass a large object to `assert.equal`, `strictEqual`, or `deepEqual`.** When such an assertion fails, Node renders and diffs both whole object graphs; on this branch one such failure cost minutes of CPU and about 2.5 GB of memory. Compare a small derived value (an id, a count, a status) instead.
- **Bound every `node --test` run.** A test process can fail and then never exit, for example when a timer, child process, or session it opened outlives the failure. `--test-timeout` fails a stuck test but does not end the process, so run it under an outside time limit that kills the process and its children.
- **A test Pi writes to your clipboard.** Pi's fullscreen interface copies any mouse selection to the system clipboard (the `fullscreenCopyOnSelect` setting, on by default), so clicking or dragging in its window replaces what you had copied. Set it to `false` in the scratch `settings.json` or keep the mouse out of the window.
