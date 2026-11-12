# choco-pi

[한국어](README.ko.md)

choco-pi is a project-aware profile for the [Pi](https://pi.dev/) coding agent. It adds operating rules, implementation and review workflows, subagents, code intelligence, research and automation tools, and a Nord terminal interface. Its packages, skills, and agent definitions load from this checkout; optional tools such as the `agent-browser` CLI, MCP servers, and search backends are external.

Keep OAuth tokens, API keys, and machine-local configuration outside Git.

## Requirements

- Node.js 24 or later
- pnpm `11.11.0` exactly
- Pi `1.5.x` from `1.5.2` (`>=1.5.2 <1.6.0`), matching the `~1.5.2` SDK range of this checkout
- Git
- Optional: [`agent-browser`](https://github.com/vercel-labs/agent-browser) for browser automation. Versions 0.34.0, 0.35.2, 0.36.0, 0.37.1, and 0.38.1 are tested; other versions run with an advisory warning.
- Optional: macOS 14 or later for computer use (see [Set up computer use](#set-up-computer-use-macos))

If `pnpm --version` does not print `11.11.0`, install the required version with
`npm install --global pnpm@11.11.0`, then check again. The vendored-package
installer refuses a different pnpm version before changing package trees.

## Initial installation

Clone the repository to a stable path. The profile installer records absolute
paths into Pi's user configuration, so moving the checkout later requires
running it again from the new location. First follow
[Install Pi without Homebrew](#install-pi-without-homebrew), then install the
profile:

```sh
git clone https://github.com/Nebu1eto/choco-pi.git
cd choco-pi

npm install --global pnpm@11.11.0
pnpm --version

pnpm install --frozen-lockfile
npm run install:profile
pi
```

The checkout ships no `.pi/settings.json`. The installer reads the profile
policy from `~/.pi/agent/settings.json`. On a new machine, where that file is
missing or lists no bundled packages, the installer writes the bundled package
list and built-in policy itself; add the other keys from
[Example global settings](#example-global-settings) afterward if you want them.

### Install Pi without Homebrew

Homebrew is not supported for choco-pi because its `pi-coding-agent` formula
lags the pinned release. Install Pi with the official installer:

```sh
curl -fsSL https://pi.dev/install.sh | sh
```

The installer creates the managed launcher `~/.pi/agent/bin/pi` and links it
from `~/.local/bin/pi`. Put `~/.local/bin` before `/opt/homebrew/bin` in your
shell configuration, then confirm the version:

```sh
export PATH="$HOME/.local/bin:$PATH"
pi --version
```

The command must print a `1.5.x` release of `1.5.2` or later. Later 1.5 patch
releases are accepted without a checkout change. The installer installs Pi's
current release; if it prints a version outside that range, such as `1.6.0`,
`/check` fails and the profile installer does not record that launcher until
this checkout's range is reviewed and moved to it.

Pi 1.5's `cli.js` launcher enables Node's compile cache. When diagnosing
unusual module-load errors, set `NODE_DISABLE_COMPILE_CACHE=1` to disable it.

When Pi opens, run `/login` and select a provider. The installation scripts do
not authenticate, open a login flow, or copy credentials into the repository.

The root install and all seven vendored-package installs use their committed
lockfiles. The root `postinstall` script runs `npm run install:vendored`, which
installs each package in its isolated workspace and attempts to restore that
package's previous dependency tree if its install fails. A vendored failure
fails the root install; rerunning the root install retries it. An interrupted
process can leave a
`node_modules.bootstrap-lock` claim directory and a
`node_modules.bootstrap-backup*` dependency backup. The installer does not
automatically prune this recoverable state or guarantee rollback after an
interrupt such as SIGINT; inspect and preserve it before retrying rather than
deleting it blindly.

Run `npm run install:vendored` directly to repair the vendored trees. A root
install that reports `Already up to date` does not run `postinstall`, even when
a vendored `node_modules` is missing or damaged, and `--ignore-scripts` (or
`ignore-scripts=true` in an npmrc) skips it entirely.

`npm run install:profile` preserves existing runtime and authentication state
plus user-added packages, writes absolute checkout paths, and links tracked
profile resources into `~/.pi/agent` (or `PI_CODING_AGENT_DIR` / `--agent-dir`).
After installation succeeds, it atomically writes `choco-pi/profile.json` in
that agent directory with the checkout path, Git revision (null if unavailable),
observed Pi version, launcher path, and host-bridge schema. The installer selects
`--pi-launcher <path>`, then `CHOCO_PI_LAUNCHER`, or the first `pi` on `PATH` that
reports a version in `>=1.5.2 <1.6.0`; missing launchers are recorded as null with a warning.
External hosts such as Waku use this marker to identify the profile;
`harness_check` warns about a missing marker, checkout mismatch, or incompatible
launcher. It does not link MCP configuration. If a target already contains
unrelated content, the installer stops; review the
conflict, then use `npm run install:profile -- --backup` to preserve and replace
it when appropriate.

## Updating and reloading

Stop active Pi sessions before replacing their dependency trees. Every root
install that is not a no-op, including `pnpm add` and `pnpm remove`, replaces
all seven vendored trees through `postinstall`. After pulling repository
changes, keep the same Node and pnpm versions, then rerun the frozen root
install, which also restores the vendored packages, and the profile install:

```sh
pnpm install --frozen-lockfile
npm run install:profile
```

Restart Pi after an update. For edits under `.pi` during an existing Pi session,
run `/reload` to reload extensions, skills, prompts, themes, and linked profile
files.

### Built-in extensions

Pi 1.5 ships built-in `codemode`, `tool-search`, `mcp`, and `llama.cpp` extensions. choco-pi uses Pi's built-in tool search and MCP and disables only `codemode` with `"extensions": ["-builtin:codemode"]` because it keeps its own `exec` code-mode bridge. The profile installer carries this policy into global settings and removes other built-in exclusions.

MCP servers are configured in Pi's `~/.pi/agent/mcp.json` format. To convert a file written for the retired `pi-mcp-adapter` fork, run `node scripts/translate-mcp-config.ts`; it prints a redacted dry-run diff and writes only with `--apply`, keeping a timestamped backup.

## Authentication

Authenticate from a Pi session:

```text
/login openai
/login anthropic
/login synthetic
/login xai
```

Pi stores credentials outside the repository; do not copy credential files into Git.

`/login openai` is Pi's "Sign in with ChatGPT" on provider `openai` (api.openai.com). The legacy `openai-codex` provider (chatgpt.com backend) stays available as an opt-in: `/login openai-codex`. On `openai` sign-in, Fast mode is accepted but not honored and never sent, Daybreak is unavailable, server-side compaction is never attempted (local compaction runs), and native `web_run` search is unavailable (web search goes through `choco-pi-web-access`). `imagegen` and `view_image` resolve `openai` credentials but are unverified live. Pi's built-in `xai` provider (Grok) signs in with `/login xai` (SuperGrok or X Premium) or reads `XAI_API_KEY`; Fast mode applies only to `xai/grok-4.7` on api.x.ai. Besides Pi's built-in Anthropic, OpenAI, and xAI logins, choco-pi adds a Synthetic provider and discovers Callstack Apex models from [`apex-provider.json`](.pi/extensions/apex-provider.json).

## Set up computer use (macOS)

The computer-use tools (`observe_ui`, `act_ui`, and related tools) work through
a native helper app, `pi-computer-use.app`. The helper reads accessibility
trees, captures windows, and delivers input. No helper binary is committed: the
setup script compiles the Swift sources in
`.pi/packages/choco-pi-computer-use/native/macos` for your Mac's architecture on
every install, and downloads nothing. Other operating systems cannot install the
helper.

### Requirements

- macOS 14 or later
- An interactive Pi session for the first permission grant
- Xcode or the Command Line Tools, which provide `xcrun swiftc` (`xcode-select --install`)

### 1. Install the helper

When an interactive Pi session starts and `pi-computer-use.app` is missing, Pi
builds and installs it, which takes tens of seconds. To install it ahead of
time, or to reinstall it, run this from the checkout:

```sh
node .pi/packages/choco-pi-computer-use/scripts/setup-helper.mjs
```

The script prints the path it installed to. It does the following:

- Installs to `~/Applications/pi-computer-use.app`. An existing `/Applications/pi-computer-use.app` is updated in place when `/Applications` is writable. Set `PI_COMPUTER_USE_HELPER_APP_PATH` to use another location, and set the same variable for Pi.
- Wraps the binary in an app bundle with the identifier `com.injaneity.pi-computer-use`, code-signs it, and registers it with LaunchServices.
- Signs with the first identity available: `PI_COMPUTER_USE_CODESIGN_IDENTITY`; a "Developer ID Application" identity in your keychain; a self-signed identity named `pi-computer-use Local Signing (com.injaneity.pi-computer-use)`, which the script creates with `openssl` and imports into your login keychain; or an ad-hoc signature. macOS may drop permission grants after an ad-hoc-signed update. `PI_COMPUTER_USE_NO_SIGN=1` skips signing.
- Leaves an installed helper that is already current unchanged and only registers it again.

### 2. Grant permissions

The helper needs two macOS permissions. Screen Recording lets the agent see
windows; Accessibility lets it act on them. When either is missing, Pi shows
the current status and this menu:

- **Open Accessibility Settings (missing)**
- **Open Screen Recording Settings (missing)**
- **Recheck (restarts helper)**
- **Cancel**

Open each pane and turn on `pi-computer-use.app` under System Settings →
Privacy & Security → Accessibility and Screen Recording. Then choose
**Recheck**. Pi restarts the helper, because a running process can keep a stale
permission answer, and reports `pi-computer-use is ready.` when both are
granted.

Grant the permissions to `pi-computer-use.app`, not to your terminal. If Pi
warns that the helper is not running as the installed `pi-computer-use.app`,
restart Pi before granting; grants made then would attach to the launching
app. In a non-interactive run, such as print mode, setup stops with
instructions instead of a menu, so grant the permissions once from an
interactive session.

### 3. Verify

Run `/computer-use` to see the effective configuration and which configuration
files were loaded. Pi checks the permissions again when a session starts and
before each computer-use tool call, so a missing grant appears as the menu above.

### Update the helper

- Pi installs the helper only when the app is missing; it never replaces an existing one. After pulling a change under `native/macos`, run the setup script again. The script skips the build when the installed helper was built from the same sources.
- The helper daemon outlives Pi. When Pi connects, it compares the daemon's protocol version (currently 7), executable path, and start time with the installed app; a daemon that is older than the installed binary is relaunched once, so a reinstalled helper takes effect on the next tool call without restarting Pi. If the relaunched daemon still does not match, Pi stops with a "helper mismatch after relaunch" error that names the reason. Run the setup script again.
- Replacing the helper re-signs the app, and macOS may invalidate earlier grants. If Pi reports a missing permission while the toggle is on, turn the toggle off and on again.
- When only ad-hoc signing is available, the script refuses to replace an installed helper, because macOS may reset its permissions. Install a Developer ID identity, or set `PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1` and grant the permissions again.

### Build from source

The script always compiles the helper with `xcrun swiftc` for the host
architecture; compiler warnings are printed and do not stop it. Pass
`--arch arm64` or `--arch x64` to cross-compile (untested), or
`--build-only --out <dir>` to write `<dir>/bridge` without installing or
signing anything.

### Configure computer use

Settings come from `~/.pi/agent/extensions/pi-computer-use.json`, then the
projects `.pi/computer-use.json`, then environment variables; later sources
win. Neither file is created for you. This example shows the defaults:

```json
{
  "browser_use": true,
  "managed_browser": "chrome",
  "headless": false,
  "cursor_overlay": true,
  "foreground_grant": [],
  "foreground_prompt": "ask",
  "restore_focus": true
}
```

| Key                 | Environment variable                                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_use`       | `PI_COMPUTER_USE_BROWSER_USE`                        | Allows the agent to control browser windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `managed_browser`   | `PI_COMPUTER_USE_MANAGED_BROWSER`                    | Browser Pi starts when it needs a managed browser: `chrome` or `helium`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `headless`          | `PI_COMPUTER_USE_HEADLESS`                           | Delivers actions through Accessibility only, without pointer or keyboard events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cursor_overlay`    | `PI_COMPUTER_USE_CURSOR_OVERLAY`                     | Shows the agents cursor on screen while it acts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `foreground_grant`  | `PI_COMPUTER_USE_FOREGROUND_GRANT` (comma-separated) | Bundle IDs, or `"*"`, that the agent may activate, raise, and send keyboard and mouse events to. Without a grant, input goes to the app in the background. Pointer input with no accessibility route is first attempted in the background: it is sent to the app's process without taking focus, and the helper watches the app and the window's pixels for a short settle window. If nothing visibly changes, the action is refused with `foreground_required` and is not sent again in that call. For a granted app, such pointer input goes to the foreground directly. No tool call can change this list.                                                                                                                                                                                  |
| `foreground_prompt` | `PI_COMPUTER_USE_FOREGROUND_PROMPT`                  | What happens when an app needs focus and no grant covers it. If the helper proved nothing was delivered, a grant retries the action once in the foreground. If the input was already attempted in the background with no visible change, a grant applies to the next call only, and the agent is told to observe the app before trying again. `ask` (default): in an interactive TUI session, Pi asks once per app per session with **Allow for this session**, **Always allow** (adds the bundle ID to `foreground_grant` in the user file), or **Not now**. `always`: an explicit opt-in that lets the agent activate and send input to any app without asking; each such app is granted for the rest of the session, in every host mode. `off`: never ask; only `foreground_grant` applies. |
| `restore_focus`     | `PI_COMPUTER_USE_RESTORE_FOCUS`                      | After granted foreground input takes focus, gives focus back to the app you had in front, unless you switched to another app meanwhile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

File edits apply on the next tool call; environment variables are read when Pi starts. `/computer-use` shows the active settings and this session's grants. `/computer-use grant ask|always|off` sets `foreground_prompt` for the current session and saves it to the user file.

### Remove the helper

1. Quit Pi. If the helper is still running, stop it with `pkill -f pi-computer-use.app/Contents/MacOS/bridge`.
2. Delete `~/Applications/pi-computer-use.app` (or `/Applications/pi-computer-use.app`).
3. Remove `pi-computer-use` from the Accessibility and Screen Recording lists in System Settings.
4. Optionally, delete the `pi-computer-use Local Signing` identity from your login keychain in Keychain Access.

## Features

The [RPC host bridge](docs/rpc-host-bridge.md) lets Waku identify the installed choco-pi profile and consume durable background-work and goal entries. RPC mode streams bridge progress when `CHOCO_PI_HOST=waku`; `/host-bridge` provides snapshots and background-work controls without starting a model turn. Pi's RPC UI carries user dialogs.

### Operating rules and workflows

- [`.pi/SYSTEM.md`](.pi/SYSTEM.md) sets shared rules for scope, authority, evidence, and completion. [`.pi/model-guidance.md`](.pi/model-guidance.md) adds per-model guidance and [`.pi/writing-policy.md`](.pi/writing-policy.md) governs response prose.
- Root and path-scoped `AGENTS.md` files are loaded as the agent works in subdirectories.
- Workflow skills cover direct implementation (`task-inline`), parallel units (`task`), dynamically decomposed work (`task-dynamic`), urgent fixes (`task-hotfix`), adversarial review (`review`), reproducing review claims (`verify`), TLA+ model checking (`formal-verify`), environment readiness (`check`), signed local commits (`commit`), and prose (`effective-writing`). Implementation workflows hold a checkout mutation lease, validate against acceptance criteria, and never push. [Review and verification](#review-and-verification) describes the review and evidence skills.
- `/preferences` sets the response language, response style (`balanced`, the default, which keeps final answers short and gives a few sentences of status during long work; `concise`, which keeps every update to one line; or `explanatory`), and agent persona (`unset`, `critical`, or the default `pessimistic`), which controls how strictly the agent tests its own claims and plans.
- `/preferences` → Agent → On usage limit (`agentOnUsageLimit`) decides what happens when the active provider reports a usage quota: `none` (default) leaves the run settled with the error; `fallback` switches to a similar-tier model on another provider from [`.pi/model-fallbacks.json`](.pi/model-fallbacks.json), or, when no tier candidate is open, to the last-resort `xai/grok-4.7`, then `synthetic/hf:moonshotai/Kimi-K3.1-Pro` (preferred over Kimi K3), then `synthetic/hf:moonshotai/Kimi-K3`, and continues; `auto-resume` waits for the quota reset, then continues. Sub-agents report a limit to their parent with the reset estimate and a suggested in-scope model; under `auto-resume` they are parked and resumed after the reset. When a `/goal` is active or paused, the goal runtime keeps ownership of recovery.

### Agents and orchestration

- Specialist roles in [`.pi/agents`](.pi/agents) (`advisor`, `explore`, `general`, `handoff`, `implementer`, `planner`, `reviewer`, `verifier`) run as background subagents, as scheduled runs, in isolated Git worktrees, or as dependency-ordered workflows through `workflow_run`. `/agents` manages them.
- `max_turns` also limits resumed runs, and an agent with a token budget is told to conclude before the budget stops it.
- A fleet panel shows running subagents and managed background shells together. A click on a row selects it as the arrow keys do, and a double click opens a shell's output. Selecting a subagent focuses its transcript, which streams text, tool progress, and custom messages; the thinking toggle there affects only the focused view. Shells are owner-scoped and managed with `shell_start` and `/shells`; a completion that arrives while its owning session is inactive is delivered when that session becomes active again.
- `/btw` opens a parallel read-only side conversation on the main session's model and thinking level. It runs as the internal `side-chat` agent, named `side-chat`, `side-chat-2`, and so on; other callers cannot spawn that role.
- The blocking `advisor` tool gives root or child agents a fresh, read-only second opinion from a configured higher-intelligence model using a bounded excerpt of the live session. It is disabled by default and skips consults when the advisor and session models match. Configure it in `/preferences` under Agent → Advisor Agent or in [`advisor.json`](#advisor-settings).

### Review and verification

- `/review [target]` runs the agent's own adversarial review. The `review` skill freezes the target (by default, staged and unstaged changes against `HEAD`) into an immutable bundle and gives it to one fresh, read-only `reviewer`. [`.pi/review-policy.md`](.pi/review-policy.md) makes every review cover three angles: changed behavior that callers, tests, or documentation still rely on; callers of every changed contract; and a last pass for what the earlier passes missed. The reviewer reports findings and, separately, candidates: concerns whose traced path to a violation has a missing or assumed link. A violation traced completely is a finding even when the reviewer ran nothing. Both stay advisory until the agent or a verifier checks them.
- Reviewers and verifiers end their reply with a structured block (`choco-pi-review` or `choco-pi-verdict`). When one runs under a work task, the subagents package records the block and adds a `Verdict record:` line to the result; a review whose block is missing or invalid is unrecorded and is never reported as clean. Review and verification rounds are capped per work task. `/review-continue <work_task>` and `/verify-continue <work_task>` allow more.
- In the terminal, a block that parses is shown as a short summary (verdict, counts, one line per finding or claim) in the result card, the completion notification and transcript Markdown; expand the card to see the raw block. A block that does not parse is shown as it is, after one line giving the parser's reason. Only the display changes: the stored message, what the model receives and the recorded verdict stay as they were.
- The `verifier` role follows the `verify` skill: it tries to reproduce a reviewer's claim against an exact checkout snapshot. It writes only to scratch, never fixes code, and reports `UNPROVEN` as it is; a failed reproduction does not refute a claim. Small work gets no verifier.
- The `formal-verify` skill checks ordering and state promises in the projects the agent works on, such as a run that must settle exactly once or a lease that must never be held twice. The agent writes a small TLA+ model, checks it with TLC through the skill's wrapper, and shows that each rule fails under a deliberate mutation. A pass covers the model within its bounds, not the code; a drift check reports when code a model covers has changed. Models can describe code in any language, but the drift check hashes individual symbols only in TypeScript and JavaScript and hashes other files whole. TLC needs Java 11 or newer and a one-time `tlc-setup.ts` run, which downloads the pinned `tla2tools.jar` into `${XDG_CACHE_HOME:-~/.cache}/choco-pi/formal`. See the [skill](.pi/skills/formal-verify/SKILL.md); [`formal/tla/subagent-run`](formal/tla/subagent-run) is a worked example that models this repository's subagent run lifecycle.
- `/diff` docks a pane beside the transcript that lists changed files with their diffs and refreshes as the agent works. By default it shows the changes made since the session began: the working tree against the session's first file checkpoint, including changes committed since. `/diff source uncommitted` compares `HEAD` with the working tree, `/diff source turn [<n>]` compares the working tree with a turn's checkpoint, and `/diff source branch [<base>]` compares from the merge base with a branch (by default the remote's default branch, else `main`, else `master`); a chosen source applies until the pane closes, and `/diff source session` returns to the default. From the pane you can put a reference to a file, a hunk or selected lines into the editor, keep notes on hunks with `c` and ask about all of them at once with `a`, which puts them into the editor as one message and clears them from the pane (with no notes, `a` puts the cursor's file, hunk or lines there), step through findings recorded by reviewers and verifiers, and put a `/review` instruction into the editor (`/diff review`); nothing is sent until you press Enter. Sensitive files are listed by name, and their contents stay hidden until you press `v` on one; nothing is saved, and the file is hidden again when the pane reopens. Ctrl+Alt+P toggles the pane, Ctrl+Alt+F moves focus into and out of it, and `?` inside it lists its keys. Inside the pane `j`/`k` step through files and ↑/↓ through the lines of open files; Shift+↑/↓ or a mouse drag selects a range of lines, a click puts the cursor on a line or hunk, and a click on a file's row expands or collapses it. Cmd+C on macOS (Ctrl+C elsewhere) copies the selected lines as plain code (the whole hunk as a diff when the cursor is on its header), provided the terminal passes Cmd+C on to Pi; Pi's own select-and-copy with the mouse is off inside the pane and on the review's diff, where the mouse selects diff lines. ← and → show one turn's changes alone: ← steps back from the newest turn, → steps forward and, after the newest, returns to every change of the session. A turn's changes run from its file checkpoint to the next one (to the working tree for the newest), so edits you make between two prompts count toward the earlier turn, and a prompt that started from unchanged files is shown together with the turn before it. Shift+→ moves focus from the editor into the open pane when the cursor is at the end of the text and nothing is selected (elsewhere it extends the editor's selection), and Tab, Esc, `q`, Shift+←, a click beside the pane or a click in the prompt editor gives it back, and a click in the editor's text also puts the cursor on the clicked character. A drag over the editor's text, or Shift with the arrow keys, selects it: Backspace or Delete removes the selection, typing or pasting replaces it, and Escape drops it; completion after `/diff ` lists the subcommands. The pane needs the fullscreen TUI and a terminal at least 65 columns wide; otherwise `/diff` prints the list of changes. In Zed it sends bounded native diffs instead, each preceded by its file name and status, with sensitive files listed by name only; when the session has changed nothing yet but the working tree has, it says that `/diff source uncommitted` shows those changes ([details](docs/zed-command-parity.md#diff-in-zed)).
- `/review-assist [target]` is where you review changes yourself, without adding anything to the model's context. The target is the current session or one of its turns, a branch range, uncommitted changes, a saved review, or a GitHub pull request; you can comment, approve or reject, and submit the review to the pull request. It is the `/diff` pane's view at full screen, with the pane's keys for what both do (`n`/`N` or `[`/`]` for hunks, Enter or Space to fold, `g`/`G`, `r`, `f`/`F`, `v`, `?`) and a line cursor, moved with `j`/`k` or ↑/↓, for the review's own work: Shift+↑/↓ or a mouse drag selects lines, a click puts the cursor on a line or opens and closes a file, Cmd+C (Ctrl+C off macOS) copies the selected lines as plain code (a folded hunk as a diff), `c` comments, `m` marks a hunk reviewed, `a` opens a side chat, `/` searches changed lines (`>`/`<` for the next match), `+`/`-` show more or less context, `|` switches to a split view, `e`/`E` open the editor, `S` finishes and `q` or Esc saves and leaves. `session` lists the same files as `/diff`, from the session's first checkpoint, and `session turn <n>` counts checkpointed turns from 1. When the changes end at the working tree, `r` reads them again, as does each finished side-chat tool call, and `f`/`F` step through findings recorded by reviewers; reviewed marks and comments stay with hunks whose content is unchanged. Sensitive files such as `.env`, private keys, and paths containing `secret` or `credential` are listed with their contents hidden until you press `v` on the file, for this view only. The side chat is told which files are hidden, and until you press `v` on one, any of its tool calls with an argument that names that file is refused: as a path, resolved the way Pi's file tools resolve it and more broadly (surrounding spaces, `@`, `~`, `file://`, `..`, trailing slashes, symbolic and hard links, Unicode forms, and letter case where the file system ignores it), or anywhere in the argument's text as the path or base name, also when written quoted or escaped in a POSIX shell, fish, PowerShell, or cmd, or percent-encoded (`cat .e"n"v`, `cat o\'key.txt`, `type .e^nv`), which also refuses a different file whose name differs from a hidden one only by quote or escape characters; text that `write` and `edit` put into a file is checked as a path only. This is a second line of defence, not a sandbox: a name is refused when every character of it appears in the text as itself or percent-encoded, and a command that writes a character by its code or reaches the file without naming it (a glob such as `cat .e*` or `cat *`, brace expansion, a variable, an escape such as `$'\x2e'`, a recursive search, an environment dump, a script written earlier) is not stopped, and neither is anything the chat already read. Messages, warnings, and errors appear on the review's own message line; errors are also left in Pi's notifications, to read after the review closes. File names, diffs, and other untrusted text are stripped of terminal control sequences before display, large changes are read within limits and the view says how many files it left out, and comments whose code has changed since are shown as outdated. Saved reviews live in `choco-pi/reviews` under Pi's agent directory and are deleted seven days after their file was last modified, including reviews with unsent comments. Outside the terminal UI it prints a read-only summary; in Zed the summary is Markdown with each file's changes as a unified diff in a code block.

### Sessions, context, and goals

- Project conversations can be listed, created, read, steered, and awaited from another session (`/sessions`, `/session-new`, `/session-read`, `/session-send`, `/session-wait`).
- `/goal` keeps a persistent objective across turns and compaction.
- `/checkpoint` rewinds, rolls back files, or forks at a checkpointed turn, or forks the current state. `/rewind` only rewinds the conversation; `/fork` only forks, from an earlier turn or the current state.
- Context limits are presets in `/preferences`: the soft cap under Session → Context and the compaction point under Session → Compaction. **Context soft cap** caps usable context: strictest 250K, strict 400K, standard 600K, permissive 800K, or unlimited. **Auto-compaction point** sets where compaction starts: strictest 200K, strict 300K, standard 450K, permissive 600K, or unlimited. The soft cap defaults to permissive and the compaction point to standard. Each preset is fitted to the model's native window: the cap never exceeds it, and the compaction point stays a headroom of `min(100K, 15% of the cap)`, at least the host reserve plus 8K, below the cap. A model with a native window under 64K is left to Pi's own trigger, and an OpenAI native-compaction budget, when published, also bounds the compaction point. These two presets are the only configuration; the headroom is fixed.
- Compaction modes are set in `/preferences` under Session → Compaction. **OpenAI compaction** uses OpenAI's remote compaction for the Codex transport and configured Responses providers; this profile's [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json) sets it to server-side. **Anthropic compaction** defaults to server-side and uses Anthropic's on-demand compaction only with OAuth on `api.anthropic.com` for Fable 5+, Mythos 5+ and Preview, Opus 4.6+, Sonnet 4.6+, and Haiku 5.5+. **xAI compaction** defaults to server-side and uses xAI's `/responses/compact` for `grok-*` models on `api.x.ai`, with OAuth or an API key; it covers foreground compaction only. Any failure falls back to choco-pi's local summary, which is reconciled with retained messages. Background compaction is on by default; when on, it always runs the text lane and runs each native lane (OpenAI and Anthropic) only while its vendor row is server-side.
- New sessions are named automatically. `sessionAutoNameModel` selects the naming model (default `openai/gpt-6-luna`); set `sessionAutoName` to `false` to disable naming.
- After each completed agent turn, choco-pi predicts your next prompt with `openai/gpt-6-luna` (falling back to `anthropic/claude-haiku-5-5`) and shows it as dim text in the empty editor. Tab fills it in; nothing is sent until you press Enter. Suggestions are conservative: one appears only when the agent's last reply needs your input, never while a queued message, running sub-agent or background shell, or active `/goal` will resume the agent on its own. A suggestion written in a script that neither your own prompts nor `agentLanguage` use is dropped. Each turn sends recent conversation text to the suggestion model in one small request; set `promptSuggestion` to `false` to disable it.

### Code intelligence and Code Mode

- choco-pi-lsp provides LSP navigation and diagnostics, lint integration, ast-grep and tree-sitter search and rules, and semantic tools such as `symbol_search`, `module_report`, and `read_symbol`. `/lsp on|off|status` and the `/lens-*` commands control it at runtime.
- Code Mode's `exec` tool runs restricted JavaScript that composes several tool calls in one step; its notebook mode keeps persistent Deno TypeScript state. choco-pi-codex also supplies Codex-style tools such as `apply_patch` and `exec_command`, and Responses compaction. `/codex` opens its settings.
- Most tools are deferred and found through `tool_search`, keeping the always-loaded tool list small. Pi's built-in `grep` tool is disabled; source discovery goes through `symbol_search`, `module_report`, targeted symbol reads, navigation, and AST search.

### Research and integrations

- Web research uses one deferred `web_search` tool regardless of the conversation model. Search credentials and billing come from the selected search backend (OpenAI, Exa, Kagi, Synthetic, Brave, or xAI), not from the conversation provider. The xAI (Grok) backend runs only when a request or routing configuration names `xai`, and only while xAI is signed in; each call is billed. See [Web search](docs/web-search.md) for providers, routing, privacy, and fallback behavior.
- `fetch_content` extracts page content and `source_check` verifies claims against cited passages. `/search` browses stored results; `/websearch` and `/curator` drive the search curator workflow.
- Pi's built-in MCP owns server configuration, authentication, and execution; agents find MCP tools with `tool_search` and call them by their `mcp__<server>__<tool>` names. Native Figma tools are separate and read files, components, variables, and renders.
- `agent_browser` automates web pages through the optional `agent-browser` CLI.
- On macOS, computer-use tools inspect and operate desktop applications through a native helper that requires Accessibility and Screen Recording permissions. [Set up computer use](#set-up-computer-use-macos) covers installation, permissions, and configuration.
- Claude Code-compatible lifecycle hooks run from Pi settings. `/hooks` browses them and `/add-dir` adds a working directory and runs `DirectoryAdded` hooks.

### Models and usage

- `/effort` sets reasoning effort and `/fast` sets the session Fast mode preference. OpenAI models send it as the priority service tier; on `xai/grok-4.7` (api.x.ai) it sends the Grok 4.7 Fast variant `grok-4.7-build-fast` and records its turns at twice the base price. Other Grok models keep the saved preference inactive and `/fast status` names why. `modelThinkingLevels` in settings assigns a default thinking level per model.
- choco-pi defaults `PI_CACHE_RETENTION` to `long`, requesting one-hour prompt-cache retention from providers that support it. An explicit value wins.
- `/usage` (alias `/quota`) shows provider usage and reset times for Claude, ChatGPT, Synthetic, and Grok; `/synthetic:quotas` shows Synthetic quotas. Grok shows its subscription credit window with an OAuth sign-in and a status-only row with an API key. Providers without credentials are omitted and listed on one dim `Not signed in: …` line.

### Interface

- Fullscreen TUI with Nord themes, a status line, and a `/status` dialog with Status, Context, Usage, Preferences, and Statistics tabs.
- `/stats` opens the Statistics tab: token usage and metered list-price cost over the rolling last 24 hours, the last 3, 7, or 30 days, or all time (`r` cycles), for all projects or this one (`p` toggles), computed from every session log with fork and rewind copies counted once. Below its header, ←/→ switches between five sections, as in Preferences, each 25 rows tall (fewer in a short terminal; a section longer than that scrolls): Summary (totals and a token chart per day, or per hour for the last 24 hours, fitted to the section), By Model and By Feature (as many top rows as fit; By Feature covers MCP servers, code mode, subagents, built-in tools, browser, web, compaction), Context & Compaction (context sizes, compactions by method and trigger, and by provider), and Throughput: tok/s (generation speed, output tokens over the request time after the first token) and time to first token per model, with a chart of the busiest models' tok/s per day. Ctrl+O expands every row with details and throughput by provider. A scan of the logs, and every period and scope computed from it, is reused for five minutes; Ctrl+O and section changes never scan again. Time to first token is recorded per response by this profile; older sessions get both figures fitted from request duration against output, marked est.
- Mermaid diagrams render in the terminal. When a response draws a diagram with box or arrow characters, the next request carries a hidden reminder to use Mermaid instead.
- Fuzzy `@` file mentions, slash-command completion anywhere in the prompt, and inline image support that respects terminal multiplexers.

## Common commands

| Command                                           | Purpose                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `/status`                                         | Show session, cost, model, context, MCP, and environment state     |
| `/preferences` (`/pref`)                          | Configure agent, advisor, language, style, persona, and interface  |
| `/context all`                                    | Inspect prompt, tools, MCP, agents, files, skills, and token use   |
| `/usage` (`/quota`)                               | Show supported provider usage and reset information                |
| `/stats`                                          | Show token usage, cost, feature and model breakdown, and speed     |
| `/effort [level]`, `/fast [on\|off\|status]`      | Set reasoning effort or the session Fast mode preference           |
| `/check`                                          | Validate the installed profile and required resources              |
| `/task-inline <task>`                             | Implement one ordinary change directly                             |
| `/task <task>`                                    | Run independent implementation units in parallel                   |
| `/task-dynamic <task>`                            | Explicitly enable dynamically decomposed nested work               |
| `/task-hotfix <task>`                             | Apply an urgent production fix directly                            |
| `/review [target]`                                | Run a fresh, report-only adversarial agent review                  |
| `/review-assist [target]`                         | Review session, branch, or pull request changes yourself           |
| `/diff [subcommand]`                              | Toggle or control the live diff pane beside the transcript         |
| `/review-continue`, `/verify-continue`            | Show or raise a work task's review or verification round cap       |
| `/commit [guidance]`                              | Create a verified local commit without pushing                     |
| `/checkpoint`                                     | Rewind, roll back, or fork at a turn, or fork the current state    |
| `/rewind`, `/fork`                                | Rewind only, or fork only from a turn or the current state         |
| `/agents`, `/btw`                                 | Manage agents or open a read-only side conversation                |
| `/shells`                                         | List, read, or stop managed shells                                 |
| `/sessions`, `/session-new`                       | List project conversations or start an independent one             |
| `/session-read`, `/session-send`, `/session-wait` | Read, steer, or wait on another conversation                       |
| `/goal [objective]`                               | Create, inspect, or manage a persistent goal                       |
| `/hooks`, `/add-dir`                              | Browse hooks or add a working directory                            |
| `/mcp`                                            | Inspect MCP servers, sign in or out, reconnect, or change exposure |
| `/search`, `/websearch`, `/curator`               | Browse stored search results or run the search curator             |
| `/lsp`                                            | Turn LSP usage on or off, or show its state                        |
| `/codex`, `/computer-use`                         | Configure the Codex adapter or show computer-use configuration     |
| `/apex-refresh`                                   | Refresh Callstack Apex models                                      |
| `/clear`, `/exit`, `/delete`                      | Start a fresh session, quit, or permanently delete this session    |

## Installed packages

The profile loads these 17 local packages, listed by absolute path under `packages` in `~/.pi/agent/settings.json`. An eighteenth package, [`choco-pi-acp`](.pi/packages/choco-pi-acp) 0.0.33, is not loaded by Pi; it runs as a separate ACP process for editors (see [Use choco-pi in Zed](#use-choco-pi-in-zed)).

| Package                                                                   |        Version | Purpose                                                      |
| ------------------------------------------------------------------------- | -------------: | ------------------------------------------------------------ |
| [`choco-pi-web-search`](.pi/packages/choco-pi-web-search)                 |          0.1.0 | Session-scoped routing for the canonical web search tool     |
| [`choco-pi-web-access`](.pi/packages/choco-pi-web-access)                 | 0.24.1-choco.0 | Web search, source checks, and content extraction            |
| [`choco-pi-provider-synthetic`](.pi/packages/choco-pi-provider-synthetic) |          0.1.0 | Synthetic provider, authentication, usage, and search        |
| [`choco-pi-ui`](.pi/packages/choco-pi-ui)                                 |          0.1.0 | TUI, status line, preferences, and Nord themes               |
| [`choco-pi-shells`](.pi/packages/choco-pi-shells)                         |          0.1.0 | Owner-scoped background shell processes                      |
| [`choco-pi-hooks`](.pi/packages/choco-pi-hooks)                           |          0.1.0 | Claude Code-compatible lifecycle hooks                       |
| [`choco-pi-subagents`](.pi/packages/choco-pi-subagents)                   |          0.1.0 | Sub-agents, workflows, sessions, and fleet UI                |
| [`choco-pi-advisor`](.pi/packages/choco-pi-advisor)                       |          0.1.0 | Read-only advisor consults through sub-agents                |
| [`choco-pi-editor-context`](.pi/packages/choco-pi-editor-context)         |          0.1.0 | Editor-context protocol, storage, and injection              |
| [`choco-pi-goal`](.pi/packages/choco-pi-goal)                             |          0.1.0 | Persistent Codex-style goals                                 |
| [`choco-pi-mcp`](.pi/packages/choco-pi-mcp)                               |          0.1.0 | Native Figma tools; MCP itself is Pi's built-in              |
| [`choco-pi-lsp`](.pi/packages/choco-pi-lsp)                               |          0.1.0 | LSP, lint, structural analysis, and semantic tools           |
| [`choco-pi-compaction`](.pi/packages/choco-pi-compaction)                 |          0.1.0 | Local compaction summaries reconciled with retained messages |
| [`choco-pi-codex`](.pi/packages/choco-pi-codex)                           |          0.1.0 | Codex tools, Code Mode, and Responses compaction             |
| [`choco-pi-agents-md`](.pi/packages/choco-pi-agents-md)                   |          0.1.0 | Descendant `AGENTS.md` instruction loading                   |
| [`choco-pi-agent-browser`](.pi/packages/choco-pi-agent-browser)           |  0.5.0-choco.0 | Native browser automation tools                              |
| [`choco-pi-computer-use`](.pi/packages/choco-pi-computer-use)             |  0.5.0-choco.0 | macOS desktop inspection and interaction                     |

## Configuration and customization

| File or directory                                                                                                                               | Purpose                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Global `~/.pi/agent/settings.json`; the checkout ships no `.pi/settings.json`                                                                   | Loaded packages, theme, TUI mode, per-model thinking levels, and compaction |
| [`.pi/SYSTEM.md`](.pi/SYSTEM.md)                                                                                                                | Profile-wide agent behavior and authority rules                             |
| [`.pi/model-guidance.md`](.pi/model-guidance.md)                                                                                                | Model routing and model-specific policy                                     |
| [`.pi/writing-policy.md`](.pi/writing-policy.md) and [`.pi/review-policy.md`](.pi/review-policy.md)                                             | Response prose and review policy                                            |
| [`AGENTS.md`](AGENTS.md) and [package example](.pi/packages/choco-pi-subagents/AGENTS.md)                                                       | Root and path-scoped repository rules                                       |
| [`.pi/agents`](.pi/agents), [`.pi/skills`](.pi/skills), and [`.pi/prompts`](.pi/prompts)                                                        | Agent roles, workflow skills, and slash-command prompts                     |
| [`.pi/subagents.json`](.pi/subagents.json)                                                                                                      | Subagent concurrency, depth, fleet view, and worktree isolation             |
| [`.pi/choco-pi-codex.json`](.pi/choco-pi-codex.json)                                                                                            | Code Mode, Codex tools, notebook, and compaction settings                   |
| [`.pi/zentui.json`](.pi/zentui.json)                                                                                                            | TUI colors, components, and icons                                           |
| [`.pi/models.json`](.pi/models.json) and [`.pi/keybindings.json`](.pi/keybindings.json)                                                         | Provider model overrides and key bindings                                   |
| [`apex-provider.json`](.pi/extensions/apex-provider.json)                                                                                       | Callstack Apex provider discovery defaults                                  |
| [`review.json`](.pi/extensions/review.json)                                                                                                     | Local review interface configuration                                        |
| Global `~/.pi/agent/advisor.json` with project override `.pi/advisor.json`                                                                      | Advisor enablement, model, effort, and per-turn cap                         |
| `~/.pi/agent/mcp.json` from [`.pi/mcp.example.json`](.pi/mcp.example.json)                                                                      | Untracked MCP server configuration in Pi's built-in format                  |
| Package [`AGENTS.md`](.pi/packages/choco-pi-agent-browser/AGENTS.md) and [`VENDORED.md`](.pi/packages/choco-pi-agent-browser/VENDORED.md) files | Package policy and recorded upstream differences                            |

Pi 1.0.3 changed `Home`/`End` to move the editor cursor. Use `Ctrl+Home`/`Ctrl+End` to jump to the transcript top/bottom.

`npm run install:profile` links the policy files, `subagents.json`, `choco-pi-codex.json`, `models.json`, `keybindings.json`, the agent definitions, and the three extension JSON files into `~/.pi/agent`; `zentui.json` is linked as `choco-pi-ui.json`.
It also migrates an existing `~/.pi/agent/extensions/background-compaction.json` to the current layout: the backend switches are rederived from the OpenAI and Anthropic compaction modes, while `enabled` and other keys are kept, and a missing file is not created.

### Example global settings

`npm run install:profile` rewrites `~/.pi/agent/settings.json` and keeps any
keys it does not manage. The checkout ships no `.pi/settings.json`, so the
profile policy comes from this global file itself: its `packages` entries under
the checkout's `.pi/packages` and its `extensions` built-in policy. When it
lists no bundled packages, the installer starts from the profile defaults in
`scripts/install-profile.ts`, which include the maintainer's model scope
(`enabledModels`) and per-model thinking levels (`modelThinkingLevels`). Such a
first install keeps an `enabledModels` you already set and merges the thinking
levels under yours. Each run:

- Writes `packages`, `skills`, and `prompts` as absolute checkout paths; `extensions` also gets the [built-in policy](#built-in-extensions). Entries you added are kept after the choco-pi entries, except packages a bundled package supersedes.
- Keeps `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`, and `modelThinkingLevels` as set in the global file. Change them there or through `/preferences`.
- Leaves the remaining keys alone. Set them yourself or through `/preferences`.

A checkout that adds a `.pi/settings.json` takes precedence: the installer and
`/check` read it instead, copy its `theme`, `tuiMode`, `fullscreenExitOutput`,
`fuzzyFileMentions`, and `compaction` over the global values, and merge its
`modelThinkingLevels` under your global entries.

A complete global file looks like this. Replace `/path/to/choco-pi` with your
checkout path. The `defaultModel`, `modelThinkingLevels`, and `enabledModels`
values are the maintainer's current settings. Secrets never belong in this file.

```json
{
  "packages": [
    "/path/to/choco-pi/.pi/packages/choco-pi-web-search",
    "/path/to/choco-pi/.pi/packages/choco-pi-web-access",
    "/path/to/choco-pi/.pi/packages/choco-pi-provider-synthetic",
    "/path/to/choco-pi/.pi/packages/choco-pi-ui",
    "/path/to/choco-pi/.pi/packages/choco-pi-shells",
    "/path/to/choco-pi/.pi/packages/choco-pi-hooks",
    "/path/to/choco-pi/.pi/packages/choco-pi-subagents",
    "/path/to/choco-pi/.pi/packages/choco-pi-advisor",
    "/path/to/choco-pi/.pi/packages/choco-pi-goal",
    "/path/to/choco-pi/.pi/packages/choco-pi-mcp",
    "/path/to/choco-pi/.pi/packages/choco-pi-lsp",
    "/path/to/choco-pi/.pi/packages/choco-pi-compaction",
    "/path/to/choco-pi/.pi/packages/choco-pi-codex",
    "/path/to/choco-pi/.pi/packages/choco-pi-agents-md",
    "/path/to/choco-pi/.pi/packages/choco-pi-agent-browser",
    "/path/to/choco-pi/.pi/packages/choco-pi-computer-use",
    "/path/to/choco-pi/.pi/packages/choco-pi-editor-context"
  ],
  "extensions": ["/path/to/choco-pi/.pi/extensions", "-builtin:codemode"],
  "skills": ["/path/to/choco-pi/.pi/skills"],
  "prompts": ["/path/to/choco-pi/.pi/prompts"],

  "theme": "nord-dark",
  "tuiMode": "fullscreen",
  "fullscreenExitOutput": "resume-hint",
  "fuzzyFileMentions": true,
  "modelThinkingLevels": {
    "anthropic/claude-fable-5": "high",
    "anthropic/claude-opus-5": "medium",
    "anthropic/claude-opus-4-6": "high",
    "anthropic/claude-sonnet-5": "xhigh",
    "openai/gpt-6-astra": "low",
    "openai-codex/gpt-6-astra": "low",
    "openai/gpt-5.6-sol": "low",
    "openai-codex/gpt-5.6-sol": "low",
    "openai/gpt-daybreak-blue-latest": "high",
    "openai/gpt-5.6-terra": "high",
    "openai-codex/gpt-5.6-terra": "high",
    "openai/gpt-5.6-luna": "xhigh",
    "openai-codex/gpt-5.6-luna": "xhigh",
    "synthetic/hf:moonshotai/Kimi-K3": "high",
    "anthropic/claude-fable-5-1": "low",
    "anthropic/claude-opus-5-5": "medium",
    "anthropic/claude-sonnet-5-5": "medium",
    "anthropic/claude-haiku-5-5": "medium",
    "openai/gpt-6-sol": "low",
    "openai-codex/gpt-6-sol": "low",
    "openai/gpt-6.1-sol": "low",
    "openai-codex/gpt-6.1-sol": "low",
    "openai/gpt-6.1-terra": "high",
    "openai-codex/gpt-6.1-terra": "high",
    "openai/gpt-6-luna": "high",
    "openai-codex/gpt-6-luna": "high",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash": "low",
    "synthetic/hf:zai-org/GLM-5.3": "high",
    "synthetic/hf:zai-org/GLM-5.3-Flash": "high",
    "anthropic/claude-mythos-5-1": "low",
    "anthropic/claude-fable-5-2": "high",
    "anthropic/claude-mythos-5-2": "high",
    "synthetic/hf:moonshotai/Kimi-K3.1-Pro": "high",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017": "high"
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },

  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5-5",
  "defaultThinkingLevel": "low",
  "enabledModels": [
    "anthropic/claude-mythos-5-2",
    "anthropic/claude-fable-5-2",
    "anthropic/claude-mythos-5-1",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
    "openai-codex/gpt-6-astra",
    "openai-codex/gpt-6.1-sol",
    "openai-codex/gpt-6.1-terra",
    "openai-codex/gpt-6-sol",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-6-luna",
    "synthetic/hf:moonshotai/Kimi-K3.1-Pro",
    "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
    "synthetic/hf:zai-org/GLM-5.3",
    "synthetic/hf:zai-org/GLM-5.3-Flash",
    "xai/grok-4.6",
    "xai/grok-4.7"
  ],
  "cacheWarming": "streaming",
  "transport": "auto",
  "httpIdleTimeoutMs": 300000,
  "quietStartup": true,
  "enableInstallTelemetry": false,
  "markdown": { "mermaid": "streaming" },
  "terminal": { "showTerminalProgress": true, "imageWidthCells": 60 },

  "agentLanguage": "English",
  "agentStyle": "balanced",
  "agentPersona": "pessimistic",
  "agentOnUsageLimit": "none",
  "sessionAutoName": true,
  "sessionAutoNameModel": "openai/gpt-6-luna",

  "hooks": {
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "$HOME/bin/notify-done.sh", "timeout": 5 }]
      }
    ]
  }
}
```

| Keys                                                                                                                              | Set by                | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages`, `extensions`, `skills`, `prompts`                                                                                     | Installer             | Absolute checkout paths; rerun the installer after moving the checkout.                                                                                                                                                                                                                                                                                               |
| `theme`, `tuiMode`, `fullscreenExitOutput`, `fuzzyFileMentions`, `compaction`                                                     | You                   | `compaction.reserveTokens` sets how far below the context window compaction starts (summaries use the model's output limit) and `compaction.keepRecentTokens` is kept without summarizing. Context limits are `/preferences` presets.                                                                                                                                 |
| `modelThinkingLevels`                                                                                                             | You                   | Keyed by exact `provider/modelId`. A checkout `.pi/settings.json`, when present, only adds entries for models you have not set.                                                                                                                                                                                                                                       |
| `defaultProvider`, `defaultModel`, `defaultThinkingLevel`, `enabledModels`                                                        | You                   | Startup model and thinking level; `enabledModels` limits model cycling.                                                                                                                                                                                                                                                                                               |
| `cacheWarming`, `transport`, `httpIdleTimeoutMs`, `quietStartup`, `enableInstallTelemetry`, `markdown`, `terminal`                | You                   | Pi runtime settings. `cacheWarming` is read only from the global file and accepts `off`, `streaming`, or `idle` (default).                                                                                                                                                                                                                                            |
| `agentLanguage`, `agentStyle`, `agentPersona`, `agentOnUsageLimit`, `sessionAutoName`, `sessionAutoNameModel`, `promptSuggestion` | You or `/preferences` | choco-pi reads these only from the global file. `agentStyle` is `balanced` (the default), `concise`, `explanatory`, or the name of a style file in `~/.pi/agent/agent-styles/`. `agentPersona` defaults to `pessimistic`, `agentOnUsageLimit` to `none` (`fallback`, `auto-resume`), `sessionAutoNameModel` to `openai/gpt-6-luna`, and `promptSuggestion` to `true`. |
| `hooks`                                                                                                                           | You                   | Claude Code hook format. choco-pi-hooks also reads hooks from `.claude` and `.agents` settings files, as described in its [README](.pi/packages/choco-pi-hooks/README.md).                                                                                                                                                                                            |

### Advisor settings

The advisor has its own file, `~/.pi/agent/advisor.json`, which a project
`.pi/advisor.json` overrides key by key:

```json
{
  "enabled": true,
  "model": "anthropic/claude-fable-5-2",
  "effort": "low",
  "maxUses": 3
}
```

`effort` accepts `off` through `max`, and `maxUses` must be at least 1. Without
the file the advisor is disabled. The [advisor README](.pi/packages/choco-pi-advisor/README.md)
lists defaults and limits.

## Use choco-pi in Zed

`.pi/packages/choco-pi-acp` connects Zed to choco-pi over the Agent Client Protocol,
and `.pi/packages/choco-pi-editor-context` syncs the focused file, cursor, and
selection into the targeted Pi session through Zed Tasks. Start with the
[Zed setup guide](docs/zed-setup.md); the
[compatibility baseline](docs/zed-acp-compatibility.md),
[command parity inventory](docs/zed-command-parity.md), and
[runtime E2E evidence](docs/zed-e2e-evidence.md) record what was verified.

## Development verification

Run the root verification gates. From a shell that Pi started, including any agent tool call, unset the session variables Pi exports before `pnpm test`, or a subagent scratch-directory test fails:

```sh
pnpm lint
pnpm fmt:check
pnpm typecheck
env -u PI_ROOT_SESSION_ID -u PI_SCRATCH_DIR -u PI_SESSION_ID -u PI_CODING_AGENT -u PI_MANAGED_INSTALL_ROOT pnpm test
```

`pnpm test` leaves out the formal validation tests in `tests/formal/`, which start Java and TLC; `pnpm test --formal` adds them and is needed only when `formal/`, the `formal-verify` skill, or those tests change.

Runtime and TUI changes also require verification in a fresh Pi process. The [verification map](docs/verification-map.md) lists what to run for each area, how to run a test Pi without credentials, the ACP real-Pi suites, and the formal model and drift checks. Package policies may require additional checks.

## Security and authority

Credentials and local overrides must remain untracked. Remote writes, deployments, pull requests, publication, and other external mutations require explicit approval.

## License status

Every local package manifest except `choco-pi-web-search` declares the MIT license; `choco-pi-web-search` declares none. The repository has no root license file, so this README does not assign a license to the repository as a whole.

## References

- [Pi](https://pi.dev/)
- [OpenAI Codex Code Mode](https://github.com/openai/codex/tree/main/codex-rs/code-mode)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [`agent-browser`](https://github.com/vercel-labs/agent-browser)
- [`pi-computer-use`](https://github.com/injaneity/pi-computer-use)
