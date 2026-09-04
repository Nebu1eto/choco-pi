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
    turn. The then-TUI-only `/review` command reported that limitation
    explicitly; divergence 26 supersedes that behavior.
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
    limitation):** discovered `/review` extension commands now dispatch through Pi
    RPC like other extension commands. Branch and session reviews use Pi's
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
   no command-specific policy: `/review` now dispatches through the same generic
   extension-command path as every other discovered command.
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
