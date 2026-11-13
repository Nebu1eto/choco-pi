# Vendored: choco-pi-acp (pi-acp baseline)

This directory is a vendored, renamed snapshot of the upstream `pi-acp` ACP
adapter.

- Upstream: <https://github.com/svkozak/pi-acp>
- Version: `0.0.33`
- Revision: `d1cffc047ab37a096ee70ca39cfc1de463db8d12`
- License: MIT (see `LICENSE`)
- Import method: files copied from the pinned Git checkout

## Imported files

- `src/`
- `test/`, flattened into `tests/` as described below
- `LICENSE`
- `README.md`, renamed to `README.upstream.md`
- `tsconfig.json`, adapted rather than copied verbatim

## Excluded files

The snapshot excludes generated, installed, repository, release, and upstream
development files that the local source-only package does not use:

- `.git/`
- `.github/`
- `.gitignore`
- `dist/`
- `node_modules/`
- `package-lock.json`
- `.prettierignore`
- `.prettierrc.mjs`
- `eslint.config.js`
- `tsup.config.ts`
- `AGENTS.md`
- `CLAUDE.md`
- `scripts/`, including the upstream smoke scripts
- the upstream `package.json`, replaced by the local package manifest

The `zod` dependency is retained solely to fulfill the `@agentclientprotocol/sdk` peer dependency; first-party source, bin, and tests have zero zod imports.

## Divergences from `pi-acp@0.0.33`

1. **Package manifest:** the package is named `choco-pi-acp`, marked private,
   requires Node 24 or newer, exposes `bin/choco-pi-acp.ts`, and keeps only the
   plain-Node test and typecheck scripts plus the two upstream runtime
   dependencies. Upstream publishing, build, lint, format, development, and
   smoke metadata is omitted. The package intentionally has no `pi` or
   `pi.extensions` field because it is an executable adapter, not a Pi-loaded
   extension.
2. **TypeScript configuration:** `tsconfig.json` uses the repository's
   `NodeNext`, ES2024, strict, no-emit configuration, enables explicit TypeScript
   import extensions and `erasableSyntaxOnly`, and includes `bin/`, `src/`, and
   `tests/`.
3. **Executable entry:** `bin/choco-pi-acp.ts` is a thin executable that imports
   `src/index.ts`; no compiled output or build step is required.
4. **Relative imports:** relative `.js` specifiers in source and tests are
   mechanically changed to explicit `.ts` specifiers. Flattened test imports
   are adjusted only to preserve their original targets.
5. **Erasable TypeScript:** eight test-only constructor parameter properties are
   mechanically expanded into explicit private readonly fields and constructor
   assignments. Runtime behavior is unchanged. No enums or namespaces were
   present, and no source runtime construct required conversion.
6. **Test runner and layout:** the 32 upstream `test/**/*.test.ts` files are
   flattened to top-level `tests/*.test.ts` files with `unit-` and `component-`
   prefixes. `test/helpers/fakes.ts` becomes `tests/helpers-fakes.ts`. The test
   command changes from `node --import tsx --test test/**/*.test.ts` to
   `node --test tests/*.test.ts`. All 95 assertions are retained; none are
   adapted or dropped beyond import paths and the parameter-property conversion
   in item 5.
7. **Upstream README name:** upstream documentation is retained verbatim as
   `README.upstream.md` so it is not mistaken for package-specific choco-pi
   documentation.
8. **Repository lint conformance:** the package carries no lint bypass. Every
   source and test file is linted under the repository's custom `anti-slop`
   rules with no `oxlint-disable` directive. Untrusted Pi RPC and ACP values
   are decoded once at the process boundary (`src/boundary.ts`,
   `src/pi-rpc/protocol.ts`) into named domain types; `any`, `unknown`
   parameters and returns, runtime `typeof` narrowing, dictionary types, and
   unjustified type assertions from the upstream baseline were replaced by
   schema-checked decoders and structural interfaces. Upstream behaviour is
   unchanged; the divergence is confined to typing and value decoding.
9. **Repository formatting:** imported TypeScript, JSON, and Markdown are
   formatted with the repository's `oxfmt` configuration. This is a mechanical
   formatting-only divergence.
10. **Pi-RPC lifecycle:** Pi executable lookup now resolves an exact
    shell-free command and argument vector, including supported Windows npm
    shims, and launches RPC mode with the requested working directory,
    separated standard streams, and an unchanged copied environment. Adapter
    disconnect invalidates ownership synchronously and disposes each Pi child
    exactly once with bounded `SIGTERM` then `SIGKILL` escalation; prompt
    cancellation remains the distinct RPC `abort` command. Session startup
    probes state, available models, and commands, omits unsupported embedded
    context advertising, and reports executable/trust setup failures without
    echoing environment values or silently passing `--approve`. A reusable
    fake ACP-to-adapter-to-Pi-RPC component harness and lazy real-Pi variant
    scaffold cover this boundary.
11. **Command discovery and dispatch:** ACP command advertisement now
    consumes Pi RPC discovery for extension, prompt-template, and skill
    commands, preserves their source classification, and canonically merges
    collisions with adapter builtins. Per-session catalogs refresh after
    extension command execution and session replacement; unknown, removed, and
    stale commands fail directly. Extension commands use Pi's immediate RPC
    semantics, while prompt templates and skills stay attached to the full Pi
    turn. The then-TUI-only `/review` command (the interactive review, since
    renamed `/review-assist`) reported that limitation explicitly; divergence
    26 supersedes that behavior.
12. **Extension UI translation:** Pi select, confirm, input, and editor
    requests map to ACP elicitation with legacy permission fallback where
    appropriate. Notifications and best-effort status, widget, and title
    updates map to ACP session updates; unsupported custom UI points users to a
    Terminal Thread. Pending dialogs have one bounded settlement path across
    acceptance, decline, cancellation, timeout, disconnect, and shutdown.
    Sensitive authentication is excluded from form content and remains a
    terminal flow.
13. **Extension UI shutdown isolation:** closing extension UI now invalidates
    ownership, tombstones pending IDs, and clears timers synchronously before
    cancellation responses are delivered best-effort without awaiting transport.
    A stalled Pi RPC response therefore cannot prevent subprocess shutdown, while
    local request settlement remains exactly once.
14. **Exact bounded extension UI tombstones:** settled request IDs now use an
    insertion-ordered exact set capped at 8,192 entries with FIFO eviction. This
    preserves bounded memory without probabilistic false positives rejecting fresh
    request IDs.
15. **Zed setup command:** the source-executed adapter bin now routes the
    explicit `zed setup`, `zed doctor`, and `zed remove` subcommands before ACP
    startup. The setup implementation detects supported settings and task paths,
    edits JSONC while preserving unrelated content where practical, installs or
    removes the five context tasks, refuses agent or task conflicts unless
    `--replace` is supplied, writes fixture-tested backups only in apply mode, and
    reports local versus remote execution without printing environment values.
    Maintained Zed settings, task, and keymap examples live in the repository-level
    `editors/zed/` directory.
16. **Embedded ACP context:** capability advertisement and resource-content
    translation are enabled only by the exact
    `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` setting. Explicit resource blocks are
    deduplicated and rendered as a UTF-8-safe, 64 KiB bounded, clearly delimited
    untrusted editor-context section; disabled clients cannot inject or expose
    resource text. Metadata and truncation identity are retained without logging
    selection content, and explicit attached context is marked as newer than stale
    ambient context for the current prompt.
17. **Generic tool presentation:** live Pi tool events retain arbitrary tool
    names while a bounded per-`toolCallId` tracker supplies optional normalized
    editor metadata for file locations, structured edit and apply-patch diffs, and
    terminal command, cwd, output, and exit state. Locations are one-based at the
    ACP boundary, streamed text and terminal tombstones are bounded, custom tools
    may provide validated presentation details, duplicate terminal events are
    suppressed, and Pi errors remain failed ACP tool states.
18. **Explicit Zed context targeting:** the editor-context CLI persists an
    owner-bound target per canonical worktree, revalidates liveness before every
    publish, clears stale targets, and retains explicit command-line targeting as
    the highest-precedence choice. Zed's non-interactive session-list task prints
    copy-ready selection commands, and the selection task directs users to run the
    chosen command in Zed's terminal when a worktree has multiple live sessions.
19. **Child-exit turn settlement:** ACP sessions subscribe to the owned Pi
    child's canonical exit notification and route prompt acknowledgement failures,
    `agent_settled`, cancellation-aware child exits, and queued-turn draining
    through one idempotent settlement helper. A child that exits after
    acknowledging a prompt now settles the active turn as cancelled when
    cancellation was requested or error otherwise, settles every queued turn with
    the same reason, and rejects later prompts instead of leaving callers waiting.
20. **Bounded ACP turn queue:** each active session accepts at most 64
    queued prompts in addition to its running turn. The sixty-fifth queued prompt
    is rejected explicitly with `Pi ACP turn queue is full (maximum 64 queued
prompts). Wait for a queued prompt to complete before sending another.`;
    queued prompts are never silently dropped.
21. **Elicitation release and raw-input bounds:** extension select,
    confirm, input, editor, and legacy permission waits race the ACP client
    request against an owner-generation cancellation signal that is released on
    timeout, settlement, session close, or child disconnect, while cancellation
    delivery remains best-effort and nonblocking. Tool-call `rawInput` whose
    serialized form exceeds 10,000 characters is replaced by a 10,000-character
    truncation-marked preview with `piAcp.rawInputTruncation` metadata containing
    the original and limit character counts.
22. **Selection-text opt-out:** editor-context publish accepts
    `--no-selection-text` and the exact `CHOCO_PI_EDITOR_CONTEXT_NO_SELECTION=1`
    environment setting. Either privacy opt-out overrides selection-file and
    selection-environment capture before those sources are read, while preserving
    path, cursor, language, symbol, and worktree metadata. Zed setup and the
    maintained Task example add a dedicated no-selection focused-context Task
    whose arguments and environment contain no selection text.
23. **Isolated Zed configuration:** `zed setup`, `zed doctor`, and
    `zed remove` accept `--zed-config-dir <dir>` to target resolved,
    containment-checked `settings.json` and `tasks.json` paths. Dry runs and
    doctor do not create the directory, apply creates it as needed, output names
    the alternate target explicitly, replacement and removal stay scoped, and
    omitting the flag preserves platform-default path selection.
24. **Bounded Pi RPC prelude and malformed-frame isolation:** Pi RPC
    stdout retains at most 64 KiB across at most 256 human-readable prelude lines
    before the first JSON frame. A later malformed stdout line records only its
    byte count, fails pending RPCs with a clear protocol error, and stops only
    that child through the existing bounded shutdown path; canonical child-exit
    notification then settles active and queued turns and releases pending
    dialogs.
25. **Bounded inbound ACP frames:** adapter stdin validates framing before
    delegating valid messages to the SDK's `ndJsonStream`, limits each inbound
    NDJSON frame to 1,048,576 bytes excluding its newline, and returns a JSON-RPC
    parse error before closing the affected connection on malformed or oversized
    input. Diagnostics contain only the violation reason, observed byte length,
    and configured cap; offending editor content is neither echoed nor logged.
26. **Headless ACP review (supersedes divergence 11's `/review`
    limitation):** the interactive review extension command, now `/review-assist`
    (registered as `review` when this divergence was recorded; `/review` is now
    the reviewer prompt template), dispatches through Pi RPC like other
    extension commands. Branch and session reviews use Pi's
    bounded, display-only headless presenter; the no-argument picker uses ACP
    elicitation, and `Review:` notifications reach the ACP client without
    model-turn events or additions to Pi's model context. Pull request review
    remains TUI-only.
27. **Extension UI text sanitization:** `src/acp/session.ts` sanitizes
    every Pi extension-UI string before it becomes ACP content, elicitation text,
    tool metadata, or session information. The bounded linear sanitizer removes
    7-bit and 8-bit ANSI CSI sequences, OSC and remaining escape-introduced
    sequences, and C0/C1 controls while preserving newlines, tabs, and portable
    Unicode. TUI block, box-drawing, and bar-glyph runs collapse to bounded plain
    `#` bars, so a client that renders text verbatim no longer shows raw escapes
    such as `[38;2;212;212;212m` or missing-glyph boxes.
28. **Code-mode apply-patch presentation:**
    `src/translate/tool-presentation.ts` and `src/acp/session.ts` detect bounded
    apply-patch envelopes embedded in `exec`, `shell`, and `bash` string
    arguments, including multiple envelopes and escaped JavaScript strings.
    Parsed file units carry reconstructed old and new text plus one-based
    changed-line locations; successful completion emits bounded ACP diff content,
    while result echoes may add verified changed-file locations without
    fabricating diff text. Ordinary terminal tools and failed patch calls retain
    their previous generic or failed rendering.
29. **Symlink-safe Zed configuration validation:** explicit Zed
    configuration directories are synchronously inspected before use in
    `src/zed/setup.ts`. An existing configuration path must be a real directory
    without symbolic-link traversal, and existing `settings.json` and
    `tasks.json` entries must be regular files whose canonical paths remain
    inside that directory. Missing directories and files remain valid for initial
    setup, and filesystem errors produce bounded diagnostics. This replaces a
    containment loop that could never reject anything.
30. **True-prefix Pi RPC prelude retention:** `src/pi-rpc/process.ts`
    stops retaining human-readable prelude lines after the first line that would
    exceed either the 64 KiB byte cap or the 256-line cap, so the retained text
    is always a prefix of what Pi emitted. `consumePreludeLines()` returns the
    retained lines in order together with an explicit `truncated` flag instead of
    silently accepting later shorter lines.
31. **Bounded concurrent ACP session retention:** each ACP connection
    retains up to eight recently active Pi subprocesses instead of closing every
    previous thread whenever a session is created or loaded.
    `src/acp/session.ts` replaces `closeAllExcept` with least-recently-used
    `retainRecent` eviction, and `PI_ACP_MAX_LIVE_SESSIONS` accepts an integer
    clamped to 1–32 with invalid values falling back to eight. Multiple client
    threads can therefore stay live at once, each publishing its own live session
    and owner identifiers for editor-context targeting, while subprocess growth
    stays bounded.
32. **Project-scoped main-session discovery:** ACP `session/list`
    resolves the explicit client cwd, then the last active session cwd, then the
    adapter process cwd, and compares project roots only when `fs.realpath`
    resolves both sides to exactly equal strings. Symlinked and realpath forms of
    one worktree match, while an unresolvable path on either side is rejected.
    `src/acp/pi-sessions.ts` scans Pi's encoded project session directory
    directly when it exists instead of walking every project, excludes nested
    JSONL artifacts and persisted subagent sidechains identified by a header
    `parentSession` combined with an early `<alias>#<hex>` session name, and
    retains ordinary parent-linked continuations and branches. Entries keep Pi's
    recorded title, an absolute cwd, and the last activity timestamp, newest
    first, with the existing 50-item cursor pagination.
33. **Zed 1.18 elicitation selection compatibility:** `src/acp/session.ts`
    presents Pi `select` options as titled `oneOf` entries with stable
    `choice-<index>` values and accepts selected values from standard ACP form
    content plus Zed-compatible content or response metadata option IDs. Invalid,
    declined, and selection-free responses still use the existing exactly-once
    cancellation path; confirm and text fields share the compatible accepted-form
    value extraction.
34. **Bounded idle Pi child reaping:** ACP v1 cannot report a Zed thread-pane
    close, so `src/acp/session.ts` gives every managed session a ten-minute idle
    timer. `PI_ACP_SESSION_IDLE_MS` is clamped to one through 120 minutes. The
    timer is cancelled by prompt activity and never reaps active or queued turns;
    on expiry it unregisters the session, cancels pending dialogs through their
    exactly-once path, and performs bounded Pi shutdown. The existing persisted
    session restore path transparently spawns a replacement child for a later
    prompt, while ACP disconnect retains immediate shutdown. Zed's installed and
    maintained context Task definitions now state that editor-dependent Tasks
    require editor focus before opening the picker.
35. **One-based Zed focused context:** Zed supplies `$ZED_ROW` and `$ZED_COLUMN`
    as one-based values. The generated and maintained focused-context Tasks pass
    both values directly to the editor-context CLI without its optional
    `--zero-based-position` conversion flag, while that flag remains available
    for editors whose cursor coordinates are zero-based.

## Updating

Checkout the desired upstream revision, reproduce its tests, copy the imported
file set, reapply every divergence above, and diff the result against both the
old vendored snapshot and the new upstream revision. Record any new exclusion
or divergence here in the same change.

## Upstream contribution candidates

Upstreaming these fixes is optional and is not a constraint on the choco-pi
fork. The following recorded divergences are generic to a Pi-to-ACP adapter and
can be separated from choco-pi-specific setup, context targeting, and command
policy:

1. **Shell-free Pi lifecycle and trust diagnostics (divergence 10).**
   `src/pi-rpc/command.ts`, `src/pi-rpc/process.ts`, `src/acp/session.ts`, and
   `src/index.ts` resolve Pi without shell interpolation, keep cancellation
   separate from owned-process shutdown, bound termination, and report missing
   executables or project trust without leaking environment values or silently
   passing `--approve`. These behaviors apply to any ACP client launching Pi;
   none depends on choco-pi extensions.
2. **Pi RPC command discovery and dispatch (divergence 11).**
   `src/acp/pi-commands.ts`, `src/acp/slash-commands.ts`, `src/acp/agent.ts`,
   `src/acp/session.ts`, and `src/pi-rpc/process.ts` consume `get_commands`,
   preserve Pi's extension, prompt-template, and skill classifications, merge
   canonical names, refresh catalogs, and fail stale commands directly. The
   discovery and refresh mechanics are useful to upstream. The adapter applies
   no command-specific policy: `/review-assist` dispatches through the same
   generic extension-command path as every other discovered command, and the
   `/review` prompt template through the same session-turn path as every other
   template.
3. **Generic extension UI translation (divergence 12).**
   `src/acp/session.ts` maps Pi select, confirm, input, editor, notification,
   status, widget, and title requests to available ACP operations or bounded
   fallbacks, while excluding sensitive authentication from form content.
   These are Pi RPC UI primitives rather than choco-pi-specific dialogs.
4. **Nonblocking, exact-once extension UI shutdown (divergences 13 and 14).**
   `src/acp/session.ts` synchronously invalidates pending UI ownership, clears
   timers, delivers cancellation best-effort, and tracks settled request IDs in
   an exact FIFO-bounded set. This generically prevents a stalled transport
   from blocking subprocess shutdown without probabilistic rejection of a new
   request ID.
5. **Bounded embedded ACP resource translation (divergence 16).**
   `src/acp/translate/prompt.ts` and `src/acp/agent.ts` gate capability
   advertisement on an exact environment value, deduplicate resources, retain
   metadata, omit binary bodies safely, and render UTF-8-safe context within a
   64 KiB cap. Resource handling is ACP/Pi translation independent of the
   choco-pi editor-context Task flow.
6. **Arbitrary tool presentation and bounded terminal state (divergence 17).**
   `src/acp/session.ts`, `src/acp/translate/bash.ts`, and
   `src/translate/tool-presentation.ts` preserve arbitrary Pi tool names,
   correlate events by `toolCallId`, normalize optional locations, diffs, and
   terminal metadata, bound retained output and tombstones, suppress duplicate
   terminal events, and preserve failed states. This applies to stock and
   third-party Pi tools, not only choco-pi tools.

The source-only package manifest, repository TypeScript/lint/test adaptations,
README rename, `choco-pi` Zed setup generator, and explicit editor-context
targeting remain repository-specific divergences rather than upstream
candidates.

## 2026-10-07 choco-pi patch: Pi SDK 1.0.4

The repository Pi SDK target moves from `0.87.1` to `1.0.4`. This package
declares no Pi SDK pin and has no package-local lockfile, so its files are
unchanged.

## 2026-10-07 choco-pi patch: Pi 1.0.4 RPC prompt disposition

Pi 1.0.4 behavior requires source changes, so the "files are unchanged"
statement above covers only the manifest and lockfile.

- `src/pi-rpc/protocol.ts` and `src/pi-rpc/process.ts`: `prompt()` decodes and
  returns the success response's `data.disposition` (`started`, `queued`, or
  `handled`). A missing or unknown disposition is a protocol error and is
  never defaulted.
- `src/acp/session.ts`: `startTurn()` settles the ACP turn as `end_turn` (or
  `cancelled`) on `handled`, because Pi emits no `agent_settled` for consumed
  input. `started` and `queued` still settle from `agent_settled`. A prompt
  acknowledgement or failure acts only while its own turn is pending and not
  already settling, so a late reply cannot settle a later turn or its queue.
- `src/acp/pi-settings.ts`: `quietStartup: "header"` hides Pi's startup
  details, so it suppresses the adapter's startup block like `true`.
- Tests: `tests/component-prompt-disposition.test.ts` covers real RPC response
  frames, malformed payloads, and stale acknowledgements. Test fakes and stub
  executables now return a disposition.

## 2026-10-08 choco-pi patch: bounded child-exit notification draining

- `src/acp/session.ts`: child exit gives serialized ACP notifications a 100 ms
  best-effort drain window, then releases local prompt settlement even when a
  client update never resolves. This also releases settlement already in progress;
  abandoned notifications cannot resume delivery after a late client reply.
  Responsive connections still drain pending updates before active-turn settlement,
  and queued turns retain their independent exactly-once exit settlement.
- `tests/phase5-pi-rpc-exit-stalled-updates.test.ts`: real `PiAcpSession` tests
  cover stalled delivery, cancellation, an already-draining turn, late replies,
  duplicate terminal events, and responsive-client notification ordering without
  spawning a Pi child.

## 2026-10-27 choco-pi patch: frozen package-local install

The root install never provided `@agentclientprotocol/sdk`, so a fresh checkout
could neither typecheck, test, nor run the adapter. The package now joins the
isolated vendored installs that `npm run install:vendored` restores.

- `package.json`: adds `"packageManager": "pnpm@11.11.0"` and declares the
  `typebox` dependency (`^1.3.29`) that `src/boundary.ts` imports. The adapter
  runs outside Pi, so no host supplies it. This supersedes divergence 1's "two
  upstream runtime dependencies"; `zod` remains only for the SDK peer.
- `pnpm-workspace.yaml`: the shared one-package workspace used by the other
  vendored packages.
- `pnpm-lock.yaml`: new. Generated with `pnpm install --lockfile-only
--ignore-scripts`; `typebox` is locked at `1.3.29` to match the repository
  root. Locked: `@agentclientprotocol/sdk@0.26.0`, `typebox@1.3.29`,
  `zod@3.25.76`. This replaces the 2026-10-07 note that the package has no
  package-local lockfile; it still declares no Pi SDK pin.

## 2026-11-03 choco-pi patch: Pi SDK target 1.5.0 + pi-schema dependency

Pi SDK pins move from `1.4.0` to exactly `1.5.0`. The package-local `minimumReleaseAgeExclude` entries move to `@1.5.0` and gain `pi-schema`.

## 2026-11-04 choco-pi patch: drop TypeBox from boundary.ts

`src/boundary.ts` no longer imports `typebox`. `BoundaryValue` is an explicit recursive TypeScript type (the JavaScript value universe, not JSON) and `BoundaryRecord` is a string-keyed dictionary of it. `isString`, `isNumber`, `isFiniteNumber` and `isBoolean` use coercion-free primitive checks with the same accept/reject behaviour (boxed values rejected; `isNumber` still admits NaN and ±Infinity). The package no longer imports `typebox` anywhere; the `typebox` dependency in `package.json` and its lockfile entry are now unused and await removal. `tests/unit-boundary.test.ts` covers the guards.

## 2026-11-03 note: unused typebox dependency removed (C26 follow-up)

No first-party file imports `typebox` any more. `dependencies.typebox` was removed from `package.json`, the `typebox@1.3.29` entry from `pnpm-lock.yaml` (regenerated with `pnpm install --lockfile-only`); the `minimumReleaseAgeExclude` line in `pnpm-workspace.yaml` stays because the vendored-install policy test requires one common workspace file. The vendored `node_modules` tree still contains the stale `typebox` copy until the next `pnpm install:profile` on the live checkout; nothing resolves it.

## 2026-11-10 choco-pi patch: Pi SDK target 1.5.1

Pi SDK pins move from `1.5.0` to exactly `1.5.1`; version references in comments, tests, and docs follow. The package-local `minimumReleaseAgeExclude` entries move to `@1.5.1`.

## 2026-11-11 choco-pi patch: Pi SDK range ~1.5.2

Pi SDK release-age exclusions collapse from per-version `1.5.1` entries to the `"@earendil-works/pi-*"` name pattern, following the root `~1.5.2` SDK range, so new Pi releases install without waiting for the minimum release age. The lock was regenerated with pnpm 11.11.0 (`pnpm install --ignore-scripts`).

## 2026-11-12 choco-pi patch: turn ownership by stdout order

Pi's `agent_settled` carries no run identity (`{ type, aborted }`), and a run that an extension starts with `sendCustomMessage(..., { triggerTurn: true })` (a subagent completion, a goal continuation) emits one too. Before this patch, such a settle arriving while a prompt was sent but not yet answered ended that prompt's ACP turn early. `tests/component-turn-ownership.test.ts` reproduced it with the fake process and with a stub Pi over real stdio (the turn ended before its own run's events arrived).

Fix: `PendingTurn.acknowledged` is set when the prompt's response frame is read (`PiRpcProcess.prompt` gains an `onResponseFrame` hook that runs synchronously in the stdout line handler, before later frames in the same chunk dispatch), and `agent_settled` is ignored while the pending turn is unacknowledged. Assumed ordering, from Pi 1.5.1 `rpc-mode.js` and `agent-session.js`: Pi writes a `started` prompt's response only after its run is active, and a prompt that arrives while an earlier run's `agent_settled` is being emitted waits for it, so a settle read before the response belongs to an earlier run. After the response the prompt's run is active, and Pi folds a `triggerTurn` message sent during it into that run as a steer or follow-up, so the next settle is the turn's own. Out of scope: a prompt that reaches Pi while an extension-triggered run is still active is rejected by Pi ("Agent is already processing") because the adapter sends no `streamingBehavior`; that fails the turn rather than ending it early. `FakePiRpcProcess` acknowledges at send time by default; `acknowledgeImmediately = false` defers it.

## 2026-11-12 choco-pi patch: native /diff presentation

`src/acp/native-diff.ts` (new) and `emitNativeDiff` in `src/acp/session.ts` render choco-pi's `/diff` notification (first line `choco-pi-native-diff/v1`) as one completed, display-only `tool_call` with ACP `diff` content, re-enforcing 30 files, 1 MiB of text, and a sensitive-path filter; malformed payloads become a one-line error. The check runs before the credential-prompt guard because diffs of ordinary code contain words such as `token`. `PiRpcProcess.spawn` adds `CHOCO_PI_ACP_NATIVE_DIFF=1` to Pi's environment so the extension knows the client renders it. Tests: `tests/component-native-diff.test.ts`; see `docs/zed-command-parity.md` (/diff in Zed).

## 2026-11-12 choco-pi patch: credential guard inspects only requests that collect a reply

The credential-prompt guard (`SENSITIVE_UI_REQUEST` in `src/acp/session.ts`) is the only keyword check in the adapter and applies only to Pi extension UI requests; tool output, assistant text, and custom messages never passed through it. It inspected every method, so a display-only `notify` whose text quoted code, a file name such as `auth.ts`, or a diff (the `/review-assist` headless summary, the `/diff` inline list, subagent messages) was replaced by the terminal-authentication warning. `isSensitiveUiRequest` now skips `notify`, `setStatus`, `setWidget`, and `setTitle`, which cannot collect input; `select`, `confirm`, `input`, `editor`, and unknown methods are inspected as before. The adapter's own warning now carries `_meta.piAcp.sensitiveUiRequest: true` so it is distinguishable from extension text repeating its words. The native-diff envelope moves into the `notify` branch after the guard: it selects a rendering and no longer needs to precede the guard (this supersedes that part of the native /diff entry above). Tests: `tests/component-sensitive-ui.test.ts` and the opt-in `tests/component-real-pi-sensitive-content.test.ts`; `tests/component-rpc-lifecycle.test.ts`'s real-Pi `/review-assist` check now passes from a repository whose diff contains such words.

## 2026-11-12 choco-pi patch: distinct outputs start a new paragraph

Zed appends consecutive `agent_message_chunk` updates to one rendered block until another thread entry (a user message or a new tool call) intervenes, so two outputs of one turn ran together ("...not sent through ACP.u27-cred: no value (cancelled)"). Every update now passes through `TextBoundary` (`src/acp/text-boundary.ts`, new), owned per session by `PiAcpSession` and applied in `emit` and the new `sendUpdate`, so it sees updates in delivery order. A text chunk whose source differs from the text it would be appended to, on the same channel (`agent_message_chunk` or `agent_thought_chunk`), is prefixed with the newlines still missing for a Markdown paragraph break (none if the previous text already ends with a blank line or the new text starts with one). Streamed deltas of one Pi assistant message share a source, `assistant:<n>`, where `n` changes at each Pi `message_start`/`message_end` (decoded as `unknown_event`); they are never altered. Every other text (notifications, the credential warning, retry and compaction notices, queue notices, command output, replayed messages) is a distinct source. `user_message_chunk` and `tool_call` reset the state; `tool_call_update` does not. `PiAcpAgent.promptActive` calls `beginClientPrompt` so the first output of each prompt carries no separator. Builtin command output and session replay go through `session.sendUpdate`, which queues behind pending notifications and still rejects on client failure. ACP SDK 0.26 also defines `ContentChunk.messageId` ("a change in messageId indicates a new message has started"); it is not used because Zed 1.27's handling of it is unverified and the paragraph break is needed for clients that ignore it. Tests: `tests/component-message-separation.test.ts`; the retry ordering test in `tests/component-session-events.test.ts` and one `tests/component-sensitive-ui.test.ts` lookup now expect the separators.

## 2026-11-12 choco-pi patch: native /diff names each file

Zed 1.27 draws an ACP `diff` item without its path, so a reader of the `/diff` card could not tell which file a block was. `src/acp/native-diff.ts` now accepts optional `status` (one of choco-pi's change kinds) and `additions`/`deletions` (null or a non-negative integer) on each payload file; anything else makes the payload malformed, and a payload without them still decodes. The summary text is Markdown built by the adapter: the files in diff order with status and line counts, then the skipped files, and a text item `File n of m: <name>` now precedes each `diff` item. Names are sanitised once by `visibleText` (every C0 control, newline and tab included, becomes its Control Picture; DEL, C1 and bidirectional controls become U+FFFD) and wrapped in a code span longer than any backtick run in them; the title and skip reasons are backslash-escaped, so no file name or reason forms Markdown structure. The title still passes through `sanitizeExtensionUiText` first, as the tool-call title does; the composed summary is no longer passed through it a second time. Caps, the sensitive-path filter and the display-only marking are unchanged. Tests: `tests/component-native-diff.test.ts`.

## 2026-11-12 choco-pi patch: a form's title is shown once

Zed 1.27 draws an elicitation's `message` and then its field's `title`; `handleExtensionSelect`, `handleExtensionConfirm` and `handleExtensionText` (`src/acp/session.ts`) put the request's title in both, so `/review-assist`'s picker read "Review target" twice. `message` is the one text ACP requires and already carries the title (`extensionUiMessage`), so the field's title is now a generic label for its kind (`Choose one`, `Confirm`, `Your answer`, `Edit text`), omitted when it equals the message. The credential check is unchanged. Test: `tests/component-extension-ui.test.ts`.

## 2026-11-12 choco-pi patch: native /diff judges both sides of a rename

Review finding F2: `decodeNativeDiff` (`src/acp/native-diff.ts`) tested a rename's combined display label (`.env -> public.txt`) as one path, so a sensitive rename source went unnoticed and its old text was forwarded. A file may now carry `oldPath` (absolute, allowed only with status `renamed` or `copied`; anything else makes the payload malformed). Contents are withheld, and the file listed by name, when `path` or `oldPath` is sensitive, when a rename or copy has no `oldPath` (an older extension), or when a file with old text has no change kind. `displayPath` is never tested as a path: it only shortens `path` when it is literally its end, and the adapter builds the shown names (`old → new`) from the validated paths. The sensitive-name patterns still duplicate choco-pi's `lib/changes/sensitive.ts`; the root test `tests/diff-sensitive-parity.test.ts` fails when the two lists diverge. Tests: `tests/component-native-diff.test.ts`.
