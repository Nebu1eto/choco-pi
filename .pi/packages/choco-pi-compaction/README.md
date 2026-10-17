# choco-pi-compaction

Compaction summaries reconciled against the retained recent messages, plus an
optional background mode that prepares a checkpoint while the session keeps
working and adopts it at a safe point.

## Reconciled summaries (always on)

Pi's default summarizer sees only the messages it discards. This extension
answers `session_before_compact` for locally summarized models and gives the
summarizer the retained tail as current-state evidence. Codex-owned models are
left to the Codex package: a model is Codex-owned only when Codex's own
handler would summarize it, i.e. Codex `compaction.responsesCompaction` is on
and the model is a Codex transport or a responses model of a provider in
Codex `scope.additionalProviders`. With `responsesCompaction` off, a Codex
transport (`openai-codex`) is summarized here, and the background `text` lane
serves it.

## Anthropic server-side compaction (foreground)

The **Anthropic compaction** row (Preferences, Session → Compaction) stores
`compactionAnthropic` in `<agent dir>/settings.json`: `server-side` (default;
a missing or invalid value means the default) or `choco-pi`.

Eligibility is a static local decision with no network probe: provider
`anthropic` at `https://api.anthropic.com`, OAuth credentials (API keys are
refused), and a model at or above its family floor: Fable 5, Mythos 5 (and
`claude-mythos-preview`), Opus 4.6, Sonnet 4.6, Haiku 5.5. Failures put the
combination on a bounded cooldown (transient ones after three in a row).

In `server-side` mode the extension answers the host's own
`session_before_compact` (threshold, overflow or `/compact`) for an admitted
model with a signed `compaction` block from a separate lane, cut at the latest
legal wire position at or before the host's cut. When the native path cannot
answer, the handler returns nothing and the local reconciled summarizer answers
the same compaction; the first fallback in a session is reported once. That
covers an unconfigured or `choco-pi` mode, a model, endpoint or auth mode the
gate does not admit, a cooling-down gate, no usable capture or legal cut, and
provider refusals or outages (HTTP 4xx/5xx, 429/529, timeouts, malformed or
oversized results).

Two failures are not papered over by a local summary; they are reported as a
warning and the handler answers `{ cancel: true }`, so the host fails the
compaction ("Compaction cancelled") and emits `session_compact_failed`:

- **cancelled**: the host aborted the compaction (`abortCompaction`, Escape)
  before or during the native request;
- **auth**: the provider's credentials could not be resolved, or the native
  request was rejected with HTTP 401/403. The local summarizer would call the
  same provider with the same login.

The same rules apply to xAI server-side compaction (`compactionXai`).
Throwing would not surface either case: Pi contains handler errors and then
runs its own default summarizer.

The replay binding (provider-stream capture, session projection and replay
rewrite) is bound whenever the mode is `server-side`, and also when the
background `anthropic-native` lane is on. A replayed request the provider
rejects with HTTP 400 and a `compaction_*` error code (or the OAuth extra-usage
refusal) turns server-side compaction off for the rest of that session: later
requests send the checkpoint's summary text and later compactions are
summarized locally.

## Background compaction (on by default)

The feature runs unless a settings sidecar turns it off. With the feature off,
or with a malformed sidecar, provider requests, session entries and hook runs
are the same as with the reconciled summarizer alone.

### Settings

The sidecar is `background-compaction.json`. The first file found wins:

1. `<project>/.pi/extensions/background-compaction.json` (trusted projects only)
2. `<agent dir>/extensions/background-compaction.json`
3. the profile's own `.pi/extensions/background-compaction.json`

No file means the defaults below, except that the native lanes follow the
vendor rows as described for the Preferences row. Unknown keys, wrong types, out-of-range
values, `hysteresis >= prepareAt`, `maxOutputTokens > maxInputTokens`, or
`maxQueued < maxConcurrent` disable the feature and show one warning naming the
file and the problem. Settings are read at session start.

| Key                                                     | Default                        | Meaning                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                               | `true`                         | Master switch. Every backend switch is ignored while it is off.                                                                                                                                                                   |
| `text`                                                  | `true`                         | Text backend: summarizes the frozen prefix with the session model. Subagent children select backends exactly as the main session does.                                                                                            |
| `anthropicNative`                                       | `false`                        | Anthropic on-demand native compaction for combinations the foreground gate admits.                                                                                                                                                |
| `codexNative`                                           | `false`                        | Codex native lane, supplied by the Codex package through the backend registry.                                                                                                                                                    |
| `prepareAt`                                             | `0.7`                          | Start preparing when context tokens reach this fraction of the host trigger point (`contextWindow - reserveTokens`).                                                                                                              |
| `hysteresis`                                            | `0.1`                          | After a preparation, usage must fall below `prepareAt - hysteresis` before another starts.                                                                                                                                        |
| `reserveTokens`                                         | `8192`                         | Headroom subtracted from the context window to get the trigger point; also orders the shared preparation queue.                                                                                                                   |
| `maxConcurrent` / `maxQueued`                           | `2` / `32`                     | Process-wide preparation limits.                                                                                                                                                                                                  |
| `maxAttempts` / `retryBaseMs` / `cooldownMs`            | `2` / `1000` / `60000`         | Retries per candidate, backoff base, and cooldown after a failure before the same owner tries again.                                                                                                                              |
| `timeoutMs`                                             | `120000`                       | Deadline per candidate.                                                                                                                                                                                                           |
| `maxInputTokens` / `maxOutputTokens` / `maxResultBytes` | `1000000` / `8192` / `1048576` | Preparation budget. `maxInputTokens` is a ceiling; the effective input budget is `min(maxInputTokens, contextWindow - output cap - 512)` of the session model. Larger prefixes or results fail as `oversized` with a detail code. |
| `countTokens`                                           | `true`                         | Let a provider token counter, when one is wired for the model, size the prompt instead of the estimate.                                                                                                                           |
| `minReductionTokens`                                    | `1024`                         | Accepted for forward compatibility; usefulness is decided by each backend.                                                                                                                                                        |

Example that enables only the text backend:

```json
{ "enabled": true, "text": true }
```

The Preferences panel's Session → Compaction group has a **Background
compaction** row (`on` by default) that flips `enabled` in the
agent directory's sidecar, keeping its other keys, and applies the change to
the running session: switching on starts a coordinator, switching off discards
any prepared candidate before it can be adopted. It refuses to rewrite a file
that is not valid JSON or fails the schema. The backend switches are derived
from the vendor rows, not set by hand: `text` is always on, `codexNative`
follows **OpenAI compaction** = `server-side`, and `anthropicNative` follows
**Anthropic compaction** = `server-side`. The row writes them with `enabled`,
and session start rewrites them in an existing global sidecar (a missing one
stays missing). A trusted project's sidecar still wins.

### Admission and failure details

Admission sizes the summarization prompt actually sent, with tool results
truncated as the serializer renders them, not the raw prefix. The character
count is scaled by the tokens-per-character rate of the last valid assistant
usage in the prefix (prompt tokens over the characters sent, clamped to
1/6..1/2; usage before a later `compaction` or `context_edit` is ignored),
else by chars/4. With `countTokens` on, Synthetic and Anthropic (API-key auth)
owner models are counted by the provider's free `messages/count_tokens`
endpoint inside the preparation slot (10 s timeout); the count replaces the
estimate. Other providers are not counted. A failed count falls back to the
estimate and records `detail` such as `count-tokens: http 500`; a 5xx,
malformed, or auth failure suppresses further requests for that
`provider|baseUrl|model` for 10 minutes (`(cached)`), while timeouts, network
errors, and 429s are retried next time. The candidate record and status carry
`admission` (`promptTokens`, `budget`, `source`, `ratio`, `detail`).

An over-budget prefix fails `oversized` with `prompt N > budget M (source)`
(`(source; count-tokens: <code>)` after a failed count) and does not cool the scope. Text-backend `oversized` details are
`prefix-over-budget`, `no-pass-plan`, `second-pass-over-budget`,
`summary-truncated` (generation stopped at the output cap) and
`result-bytes`. A request refused during a cooldown reports `cooling` with
`cooling-down <n>s`, not `quota`.

On a reasoning model the summary output cap is `maxOutputTokens + 6553`
(0.8 x 8192), bounded by the model's own cap, because reasoning shares the
cap on OpenAI-compatible endpoints. The thinking level is left unchanged.

### How a checkpoint is prepared

Each main session gets one coordinator, registered in the process-wide
registry under `mainOwnerKey(sessionId)` = `main-session:<sessionId>` with a
process-unique generation. At each `turn_end`, `agent_before_settle` and
`agent_settled` the extension reads context usage; past the threshold it
freezes the prefix up to a legal cut and starts preparation in the background.
The foreground run never waits for it. Ready candidates are persisted as
`choco-compaction-candidate` custom entries, which are not model-visible.

On reload or a model change the coordinator is rebuilt for the current provider
scope (provider, endpoint, model, auth mode). A persisted ready candidate is
bound again only when its scope, prior checkpoint and prefix fingerprint still
match; recovery never starts a paid preparation. Anything else is discarded
with a reason.

The registry lives on `globalThis` under the versioned key
`Symbol.for("choco-pi:compaction-coordinator:v2")` so it survives `/reload`. A
slot an older build left under an earlier key is ignored and left untouched. If
the current key holds a slot this code cannot validate, nothing throws and the
slot is not modified: background compaction stays off for the rest of the
process, every compaction uses the host path, and one warning reads
`background compaction unavailable: registry conflict; restart pi`.

### How a checkpoint is adopted

A ready candidate is installed by exactly one of these routes. None forges a
host event.

- **Boundary (mid-run).** At `turn_end` or `agent_before_settle` the extension
  returns the checkpoint as a compaction draft. The next request of the same run
  uses it. The host emits no `session_compact`. Commit is confirmed by scanning
  the branch for the entry's candidate ID, fingerprint and owner key after the
  boundary settles; a dropped or replaced draft returns the candidate to ready.
- **Idle (before the next prompt).** When a prompt arrives while the session is
  idle (`input` with no streaming behavior and `ctx.isIdle()`), the extension
  calls `ctx.compact()` only as a trigger and answers the resulting
  `session_before_compact` with the ready checkpoint, so the host summarizer
  never runs and the first request of the new prompt already uses it. The host
  emits a real `session_compact` with `reason: "manual"`. If the host refuses
  ("Nothing to compact", "Already compacted", or another extension cancels),
  the route fails closed: no retry, no summarization, and the candidate stays
  available to a later boundary. `ctx.compact()` is never called while a run is
  active.
- **Host compaction.** When the host compacts on its own (threshold or a plain
  `/compact`), a ready, still-valid candidate answers `session_before_compact`
  instead of the summarizer. `/compact` with custom instructions discards the
  candidate and runs the normal summarizer. Overflow recovery with no ready
  candidate cancels any preparation and proceeds unchanged.
- **Manual (plain `/compact`, no ready candidate).** The extension starts a
  background preparation (or waits on the one already running); the
  subagents fleet view shows it as the shared "compacting..." status. In the TUI the typed command is taken
  over at `InteractiveMode.prototype.handleCompactCommand` (the same way the
  settings dialog takes over `/settings`), so no host compaction starts: no
  "Compaction cancelled" line, and a running agent is not aborted. A
  programmatic `compact()` (RPC `compact`, SDK, extension `ctx.compact()`)
  on an idle session is taken over at `AgentSession.prototype.compact` the
  same way: it resolves at once with no result, without aborting anything or
  starting a host compaction. On a busy session, or whenever the feature
  declines, the host's own `compact()` runs unchanged; its
  `session_before_compact` hook may still defer a plain request with
  `cancel` (the host reports `Compaction cancelled`). The Anthropic lane needs a wire capture
  of the session's latest request, so right after a reload or resume the
  request goes to the text lane instead; a lane that fails is retried once on
  the remaining lane before the failure is reported. The prepared checkpoint
  is adopted when the next prompt or turn end arrives; a session that is
  already idle when the checkpoint becomes ready adopts it then through the
  idle route, unless a cancelled host compaction is still unwinding; a failed
  preparation is reported and nothing is summarized. `/compact <instructions>`
  takes the same path on the text lane only (the native lanes cannot apply
  instructions); the candidate carries the instructions, a ready candidate
  answers a later request only when its instructions match, and a request
  with different instructions supersedes the one in flight. Consumers see the
  deferred request as answered by the feature (`willAdopt` is true), so no
  compaction hook runs for it or for its later adoption.
- **Paths that stay foreground, and why.** Threshold compaction runs inside
  request preparation: the host blocks the request until compaction ends and
  cancelling it would abort the user's turn, so the background feature
  prepares ahead (`prepareAt`) and adopts a ready candidate there. A
  preparation still in flight at the threshold is awaited (bounded by its own
  timeout) and adopted, rather than paying for a second summary in the
  foreground; only a failed or missing preparation leaves the host's own
  summary to run. The threshold route also skips an Anthropic lane that
  cannot serve (no wire capture, or it just refused the cut) in favor of the
  text lane. The Codex lane never yields to text: a Codex-owned model is
  compacted by Codex's own handler, so a refused Codex cut (for example
  before the session's first recorded provider response) retries on the
  Codex lane after the cooldown, and the host's Codex foreground compaction
  covers the threshold meanwhile. Overflow
  recovery must shrink the next request before it can be sent at all, so an
  in-flight preparation is cancelled and the foreground summarizer recovers.
  `navigateTree({ summarize })` produces a branch summary, not a compaction.
- **RPC and GUI clients.** Hosts without the TUI (Waku and other RPC clients)
  send the RPC `compact` command (with optional `customInstructions`). With
  the feature on and the session idle it starts the background preparation and
  answers success at once with no data. It falls through to the host's own
  compaction (the normal blocking result) when the feature is off, the
  coordinator registry is in conflict, the session is busy, or the feature
  declines the request (no usable lane, a ready candidate that already answers
  it, or a preparation it cannot start).
- **Context cap.** When `.pi/extensions/model-context-cap.ts` reaches its
  compaction threshold and a ready candidate exists, it hands the compaction to
  the idle route instead of requesting a summary. Otherwise it behaves as before.

### Consumers

Consumers learn about adoptions from the process-global signal
`Symbol.for("choco-pi:compaction-background-adoption")` (`getBackgroundAdoptionSignal()`),
which delivers one notice per committed adoption with its route (`boundary`,
`host` or `recovered`) and can tell whether a `session_before_compact` or a
compaction entry belongs to a background adoption. The slot is created when the
extension registers, so consumers loaded earlier bind in their own
`session_start`; while the feature is off it has no owners and publishes nothing.
Subagent children register their own owner through the runner bridge.

- **Goal:** runs its post-compaction work exactly once per compaction. Boundary
  adoptions come from the signal; idle and host adoptions from their real
  `session_compact`.
- **Hooks:** external `PreCompact` and `PostCompact` hooks are **not run** for
  background adoption on any route. Host and manual compactions run each hook
  once, as before. No new hook event type exists.

### Subagents

The main session publishes a child provider that the subagent runner uses to
attach a separate coordinator to each child under
`subagent-child:<childSessionId>`; the parent session's coordinator is never
touched. A child gets the same provider-native lanes as the main session for
the same model (`nativeLaneSwitches`): a Codex child prepares with
`codex-native-v2`, an admitted Anthropic child with `anthropic-native`, an
admitted xAI child in `server-side` mode leaves compaction to xAI's foreground
path, and every other model uses `text`. The child's provider scope is resolved
like the main session's (Anthropic auth mode, hashed Codex account); when its
credentials cannot be read the native capability checks fail closed and the
text lane serves the child. Children have no idle route. When a child's cut
has no retained entry yet, the coordinator appends a model-invisible
`choco-compaction-anchor` entry through the runner bridge and keeps it.

Inside the child session itself the extension registers no coordinator, but
it binds the child's own Anthropic and xAI replay (capture, projection,
rewrite) and answers the child's host compactions with Anthropic or xAI
server-side compaction under the same rules as the main session. Every piece
of that state is keyed by session ID: a child's replay rejection turns
server-side off for that child only. The Codex package binds each session
under `ownerKeyFor(sessionId)` (the child key for a child), so a child
coordinator finds its child's Codex binding even when the binding appears
after the coordinator was created.

`refreshSessionNativeState(sessionId, ctx)` re-runs every registered native
restore for one session: this package re-binds the session's Anthropic and xAI
replay to `ctx`'s session manager (keeping its captures), and the Codex package
re-installs the session's committed Codex checkpoint. Contributors register
through `registerSessionNativeRefresher` in a process-global table; a
superseded or shut-down session's refresher does nothing. Only stale-context
errors are contained. It is the hook for the subagent runner to call when a
child reattaches after cancel or resume.

### Backends and the registry

| Backend ID         | Switch            | Scope                                                                                                                                                |
| ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`             | `text`            | Any locally summarized model; summarizes the frozen prefix with the session model.                                                                   |
| `anthropic-native` | `anthropicNative` | Combinations the foreground gate admits; on-demand native compaction on a separate lane, replayed byte-exact at the transport.                       |
| `codex-native-v2`  | `codexNative`     | Codex-owned models; registered by the Codex package. Prepares on a detached SSE lane from a frozen canonical request and installs only after commit. |

Backends are created through the neutral registry (`registerBackendFactory`).
The in-package `text` and `anthropic-native` factories are registered only when
no factory exists for that ID, so a harness can register its own (for example
with a scripted `fetch`) before the extension binds. Factories receive
`{ ownerKey, ownerGeneration, providerScope }`.

### Diagnostics

Warnings are shown once per message, prefixed `Background compaction:`.
They cover rejected settings, unavailable backends, preparation or recovery
failures, idle adoption failures other than the expected refusals, and
Anthropic replay that was refused or could not be verified at the transport
(the summary text is sent instead). Child-session warnings are prefixed
`subagent:`. The Codex package reports a rejected sidecar and an incompatible
committed Codex checkpoint (model, account or credentials changed) once per
session; the host's existing compaction path is then used.

### Limitations

- Provider errors from the text backend are classified by matching error text;
  an unrecognized error is treated as a retryable malformed response.
- Snapshots are refused when no legal cut exists (for example a cut that would
  split a tool call or, for Anthropic, an ambiguous wire mapping); preparation
  then waits for the cooldown and a later threshold.
- Anthropic native replay is refused with `binding-mismatch` when the system
  prompt or tools changed while the retained messages carry thinking bound to
  them; the summary text is used instead.
- Retained thinking behind a native compaction block is still bound to the
  messages the block replaced. The replay keeps the provider's
  `thinking.block_binding` (`drop_block` on managed-effort models), so the API
  drops those blocks instead of rejecting the request; a model without
  `block_binding` support may still reject them.
- Anthropic native support follows a static family table. Live acceptance
  evidence covers only foreground `/compact` on `claude-fable-5-1`
  (first-party API, OAuth); other admitted families and the background lanes
  rely on the documented compatibility list.
- A canceled or timed-out subagent run detaches its coordinator permanently;
  resuming that child continues without background compaction unless the
  runner reattaches one.
- Child native lanes have offline test evidence only (fake transports and
  fake subagent registry); no live child run has exercised them yet.
- Runs started without `prompt()` (for example `sendMessage(..., { triggerTurn: true })`)
  skip the idle route and rely on boundary adoption.
- Scheduling is per process; separate Pi processes do not share limits.

### Host behavior this relies on (Pi SDK 1.0.4)

- A compaction draft returned from `turn_end` or `agent_before_settle` commits
  while the run is active, without abort or `session_compact`. Returning it
  proves nothing: a later handler can replace the batch and one invalid draft
  drops it, so adoption is acknowledged only by finding the entry on the branch.
- `ctx.compact()` aborts an active run, so it is called only while idle.
  Answering its `session_before_compact` with the checkpoint skips the host
  summarizer; other extensions' handlers still run (last result wins, `cancel`
  short-circuits).
- `firstKeptEntryId: null` is stored as a self-reference and silently drops
  later entries. Adoption always uses an ID on the current branch; an empty
  suffix gets an anchor custom entry.
- An inline factory appended to the subagent runner's `extensionFactories`
  binds in every restricted child mode without enabling denied extensions.
- `pi.appendEntry` custom entries survive reopen exactly and never reach model
  context. A new session writes no file before its first message.
- `before_provider_request` is last-writer-wins. The Anthropic replay rewrite
  registers last and is verified against the body the transport actually sends;
  a later change to the block or beta fails the request closed.
- The installed Anthropic adapter rejects `stop_reason: "compaction"`, so native
  summarization uses its own client, never the foreground stream.

### Verification and live status

Pure logic is unit-tested in `tests/`; host and provider behavior is checked by
real-SDK integration tests and the end-to-end harness
(`tests/live/background-compaction/`), whose seven offline scenarios pass. The
foreground server-side path, the family gate and the session disable are
covered by unit and real-SDK tests with scripted transports, and by two harness
scenarios: `anthropic-foreground-compaction` (`/compact <instructions>`) and
`anthropic-foreground-auto-compaction` (the context cap's `compactAt` route,
no instructions). Offline, both send the same lane request (the
`compact-2026-09-04` beta and `compaction.summarize`, with instructions only
for `/compact`), persist `AnthropicDetails` and replay the block on the next
request.

Live status:

- **Foreground, `claude-fable-5-1` (2026-10-14, subscription OAuth, one run,
  exit 0).** Two foreground turns returned 200; `/compact <instructions>` sent
  one lane request with the compaction beta and instructions, answered 200
  with `stop_reason: "compaction"`; the compaction entry carried
  `AnthropicDetails`; the next foreground request started with the persisted
  block under the same beta and returned 200. No fallback notice and no local
  summarizer request. The automatic route was not run live, and the
  session-disable path was not exercised live because nothing was rejected.
- **Earlier `claude-haiku-5-5` runs (background lanes).** Every full-profile
  foreground request returned HTTP 400 `invalid_request_error` ("Third-party
  apps now draw from your extra usage, not your plan limits"); the tool-less
  summarizer request returned 200. Those runs sent Pi's default system
  preamble without built-in tools; live mode now sends the user's `SYSTEM.md`
  and the built-in tools, as a real session does. Which difference caused the
  refusal is not isolated, and the Haiku scenarios have not been rerun.
- **Codex.** No live driver: Codex foreground traffic uses the cached
  WebSocket, not `fetch`, and the harness transport checks are
  Anthropic-shaped. The Codex lane is covered by unit tests with fake
  transports only.
