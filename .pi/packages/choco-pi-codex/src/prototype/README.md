# Responses protocol prototype

This opt-in experiment tests native `response.steer` and `async: true` with
GPT-6 Astra through a real Pi SDK host. It does not change Pi, patch prototypes,
load the registered-tool bridge, or enable anything in the installed profile.

## Run

From `~/Workspace/choco-pi-dev`:

```sh
# Deterministic protocol regression tests
node --test .pi/packages/choco-pi-codex/tests/responses-prototype.test.ts

# Opt-in real Pi host, scripted Responses transport; no network or credentials
node --test .pi/packages/choco-pi-codex/tests/responses-prototype.e2e.ts

# Live endpoint probes; consume Codex quota and send only synthetic prompts
node .pi/packages/choco-pi-codex/src/prototype/run.ts steering --live
node .pi/packages/choco-pi-codex/src/prototype/run.ts async --live
```

The live runner rejects other checkout locations. It uses an existing Codex
OAuth credential through Pi's public `readStoredCredential` API. It never
prints, refreshes, or writes credentials. An expired or nearly expired login
stops the probe. Each run uses an empty resource directory, in-memory settings
and session history, no Pi tools, a scratch model cache, and a 90-second
provider deadline. Scratch files are removed on normal completion or failure.

The result is a JSON report with `passed`, a protocol trace, and the number of
Pi tool executions. Error reports omit raw server bodies and credentials.

## What a passing probe proves

**Steering:** the runner submits input through
`session.prompt(text, { streamingBehavior: "steer" })`, the path used for normal
interactive submissions. The extension handles that input, sends
`response.steer`, observes acceptance, consumes the automatic successor, and
checks its requested output marker. It does not create that successor itself.
Both a steered incomplete response and a normally completed original response
are valid preceding events.

**Async:** the provider advertises exactly one direct function with
`async: true`. On its completed call item, the module starts a cancellable
1.5-second synthetic lookup while continuing to consume assistant text. After
the initial response completes, it sends the actual output on the original
`call_id`, continuing from the latest response ID. Passing requires text while
the job is pending and a continuation that quotes the generated marker.
Pi's tool executor never runs this call.

## Deliberate limits

- One initial prompt per host, one steer or one async call. The scenarios are
  separate; their combination is not implemented or proven.
- No ordinary Pi tools, MCP tools, filesystem operations, approvals, Code Mode,
  wait tool, or background tasks spanning arbitrary conversation turns.
- No reconnect/replay, queued-steer recovery, or SSE fallback. Disconnects,
  unsupported calls, missing native async flags, and unexpected required input
  fail closed rather than simulate success.
- Steering is retained as explicit custom metadata. Multiple Responses outputs
  are flattened into one Pi assistant message. This is not a production-ready
  persisted conversation representation; resume and second turns are rejected.
- `session.steer()` and RPC's dedicated `steer` command bypass the input hook.
  They do not gain native steering from this extension. Normal prompt submission
  with `streamingBehavior: "steer"` does reach the hook.
- Token usage is accumulated, but pricing is not modeled. No production UI or
  TUI acceptance is claimed by the SDK-host tests.

## Evidence scope

The protocol tests cover automatic continuation, original-call result delivery,
rejection, and cancellation. The opt-in host tests exercise real public Pi
extension loading, input interception, streaming, metadata, and second-turn
rejection. Live success must be established by the explicit commands above;
scripted transport tests alone do not prove endpoint support.

Reference CLI inspection used `openai/codex` commit
`5ecb3afd1bf405149e2159bfda50093b0c1b5fab`. That revision queues steering locally,
dispatches tools during streaming, and drains them before continuing. It does
not supply an implementation of the new `response.steer` protocol to copy.
