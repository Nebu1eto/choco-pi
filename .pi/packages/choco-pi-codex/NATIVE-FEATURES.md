# Native Responses features

In `/preferences` → Model → Codex, **Mid-turn Steering** and **Async Code Mode**
default to **auto**. Select **off** independently to disable either feature.
The config keys are `openai.midTurnSteering` and `openai.asyncCodeMode`.
Existing project/global preference scoping is unchanged.

The native integration targets `openai-codex/gpt-6-astra` over the Responses
WebSocket transport. Other models and SSE do not enable these features.
Code Mode stays selected; no temporary execution-mode switch is required.
The native features use public Pi APIs and do not require the legacy
registered-tool capture. That pre-existing Code Mode bridge is unchanged.

## Mid-turn Steering

Pi already queues steering input. This option additionally sends eligible input
to the active response using `response.steer`. Pi still persists the user
message and controls the next turn. A connection-owned inbox retains the
automatic successor until Pi requests that turn, preserving separate assistant
messages and normal multi-turn history.

New native-steerable Astra responses send full context rather than a cached
`previous_response_id` delta. The endpoint's cached-continuation path can reject
thinking-phase successor creation with `successor_creation_failed` and
`prompt_cache_options is not supported on this model`. Full-context starts avoid
that failure while retaining the prompt-cache key and ordinary prompt-cache reuse.
This increases transmitted input for those starts; accepted automatic successors
still require no new request. Off and ineligible requests keep normal delta behavior.

If the server needs tool results, Pi executes those tools through its normal
checks and returns their outputs. The adapter omits the accepted steer from that
request because the server inserts it. If input or request settings change, the
adapter discards unconsumed generation and sends Pi's full context on a fresh
connection. It does not replay actions or discard Pi's queued input.
A failed successor also reconnects directly, because its previous response ID may
no longer exist. Diagnostics retain safe failure codes, never raw error messages.

One steer may be pending per connection. Images, already queued input, unsupported
models/transports, and submissions before a response ID exists use ordinary Pi
queuing. Requests containing server-hosted tools also stay queued: discarding an
unconsumed generation must not risk replaying a hosted action.
Direct SDK `session.steer()` and RPC's dedicated `steer` command still
bypass the extension input hook; prompt submission with
`streamingBehavior: "steer"` uses it.

Steering does not undo completed output or cancel tools already running.
The editor widget shows the latest four steering submissions independently,
with numbered, sanitized message previews: **Queued (Pi path)**, **Mid-turn
sent**, **Mid-turn accepted**, **Mid-turn applied**, or **Queue fallback**.
Applied means the validated native successor started being consumed; it does
not claim that the model followed the instruction or completed successfully.
Pi's ordinary queue remains authoritative. These session-local receipts are
not saved to history or sent to the model, and clear on the next idle prompt,
session replacement, or reload. They do not require diagnostic logging.
Direct SDK/RPC steer commands that bypass the input hook have no receipt.

The inbox is capped at 10,000 queued events and two million decoded characters;
overflow or an invalid connection fails rather than replaying partial tool work.

## Async Code Mode

The outer `exec` tool is client-owned. It is not OpenAI's hosted
`programmatic_tool_calling` tool, so the hosted PTC restriction does not by itself
exclude local Code Mode. Code Mode must be selected. Only the direct `exec`
definition receives `async: true`;
`wait` and nested tools are not marked async. Hosted PTC requests are excluded.

The model may continue before the `exec` output arrives. **Pi still starts local
tool execution at its normal dispatch boundary, after the assistant response
ends and preflight passes.** This is not early execution during streaming.

For an actual native async `exec` call, the initial Code Mode wait defaults to
250ms. A longer-running cell returns its existing cell ID; use `wait` to obtain
the eventual result or terminate it. Explicit `// @exec` settings and configured
tool-specific yield times retain priority. Tool blocking, source validation,
nested preflight, cancellation and output handling remain in their existing paths.

The API result for the original `exec` call is the real completed/yielded cell
response. A resumed cell's result belongs to its `wait` call. This is the existing
Code Mode contract, not a fabricated final result or a new arbitrary-tool job queue.

## Validation

Protocol/config regressions run in the baseline suite. The opt-in suite below
uses a fresh Pi SDK host with production provider/input/Code Mode components,
synthetic delayed work, temporary state, and an existing unexpired credential.
It requires an already installed Code Mode host and never installs or refreshes
credentials:

```sh
CHOCO_PI_NATIVE_LIVE=1 node --test .pi/packages/choco-pi-codex/tests/native-features.e2e.ts
```

This consumes Codex inference quota. It exercises steering history, actual Code
Mode yield/wait, normal Pi tool blocking, Off, and SSE. The older single-turn
prototype under `src/prototype/` remains a separate explicitly invoked experiment.

For an isolated real interactive Pi TUI, run the following in a disposable
terminal and submit a text-only steer while Astra is streaming. Add `--off`
for a queue-only control or `--fallback` to test a post-hook input transform
that forces ordinary queue recovery. The interactive runner disables the
automated suite's 120-second abort watchdog; transport idle timeouts still apply.
Exit with `/quit`.

```sh
CHOCO_PI_NATIVE_LIVE=1 node .pi/packages/choco-pi-codex/tests/native-steering-tui.ts
```
