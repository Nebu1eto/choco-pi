import assert from "node:assert/strict";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  artifactLeaks,
  InputSchema,
  JsonSchema,
  Recorder,
  redact,
  writeArtifact,
} from "./live/background-compaction/artifacts.ts";
import { requireLiveRun } from "./live/background-compaction/budget.ts";
import {
  evaluateCheck,
  type CheckEvidence,
  type CheckName,
} from "./live/background-compaction/checks.ts";
import { launch } from "./live/background-compaction/launch.ts";
import { LiveLedger, usageFromSse } from "./live/background-compaction/live-ledger.ts";
import { containsText, mapPayload } from "./live/background-compaction/transport-capture.ts";

const scratchRoot = "/tmp/choco-pi/01a12ed9-8477-76d1-b5cd-928b54b5cd15/harness-tests";
const PROMPT = "HARNESS-GO";
const LATE_MUTATION = "HARNESS-LATE-MUTATION";

function emptyEvidence(): CheckEvidence {
  return {
    records: [],
    aborts: 0,
    networkCalls: 0,
    mode: "fake",
    notifications: [],
    observations: {},
  };
}

function record(kind: string, data: Record<string, string> = {}) {
  return { sequence: 0, elapsedMs: 0, kind, data };
}

function statusOf(check: CheckName, evidence: CheckEvidence) {
  return evaluateCheck(check, evidence).status;
}

test("checks fail without runtime evidence and on every observed violation", () => {
  const empty = emptyEvidence();
  assert.equal(statusOf("post-adoption-transport", empty), "fail", "missing evidence never passes");
  assert.equal(statusOf("consumers-notified-once", empty), "fail", "no adoption is not a pass");
  assert.equal(statusOf("no-abort", { ...empty, aborts: 1 }), "fail");
  const unbacked = {
    ...empty,
    observations: {
      "single-checkpoint": [{ description: "one", actual: 1, expected: 1, evidenceRefs: [7] }],
    },
  };
  assert.equal(statusOf("single-checkpoint", unbacked), "fail", "refs must name real records");
  const notice = { consumer: "goal", adoptionId: "a", evidenceRef: 0 };
  const roster = { ...empty, records: [record("counts")], expectedNotifications: [notice] };
  assert.equal(statusOf("consumers-notified-once", { ...roster, notifications: [notice] }), "pass");
  const duplicate = { ...roster, notifications: [notice, notice] };
  assert.equal(statusOf("consumers-notified-once", duplicate), "fail");
  const runnerMismatch = {
    ...roster,
    notifications: [notice],
    observations: {
      "consumers-notified-once": [
        { description: "runner once", actual: [2], expected: [1], evidenceRefs: [0] },
      ],
    },
  };
  assert.equal(statusOf("consumers-notified-once", runnerMismatch), "fail");
  const leaked = { ...empty, records: [record("bad", { signature: "unsafe" })] };
  assert.equal(statusOf("no-secret-leak", leaked), "fail");
});

test("zero-network tolerates only listed non-provider origins and every counted fetch", () => {
  const github = [record("network-blocked", { origin: "https://github.com" })];
  const tolerated = { ...emptyEvidence(), records: github, networkCalls: 1 };
  assert.equal(statusOf("zero-network", tolerated), "pass");
  const provider = [record("network-blocked", { origin: "https://api.anthropic.com" })];
  assert.equal(statusOf("zero-network", { ...tolerated, records: provider }), "fail");
  assert.equal(statusOf("zero-network", { ...tolerated, networkCalls: 2 }), "fail");
  assert.equal(statusOf("zero-network", { ...emptyEvidence(), networkCalls: 1 }), "fail");
});

test("redaction removes signatures, ciphertext and credentials before recording/writing", async () => {
  const secret = "harness-signature-must-not-appear";
  const safe = redact({
    signature: secret,
    nested: [{ encrypted_content: "ciphertext", authorization: "Bearer secret", id: "entry-id" }],
  });
  assert.deepEqual(artifactLeaks(safe, "$", [secret, "ciphertext", "Bearer secret"]), []);
  assert.deepEqual(redact(safe), safe, "redaction metadata is stable across writer boundaries");
  assert.equal(artifactLeaks({ signatureRedacted: secret }).length, 1);
  const recorder = new Recorder(["opaque-credential-value"]);
  recorder.record("candidate", { signature: secret });
  recorder.record("unlabelled-provider-echo", { text: "opaque-credential-value" });
  const records = Value.Parse(InputSchema, recorder.records);
  assert.deepEqual(artifactLeaks(records, "$", ["opaque-credential-value"]), []);
  const dir = join(scratchRoot, "artifacts");
  await mkdir(scratchRoot, { recursive: true });
  try {
    await writeArtifact(dir, "events.json", records);
    const text = await readFile(join(dir, "events.json"), "utf8");
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("sha256"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live runs are opt-in and the ledger counts real SSE usage, stopping runaways", async () => {
  const env = { CHOCO_PI_LIVE_E2E: "1" };
  const haiku = "anthropic/claude-haiku-5-5";
  assert.throws(() => requireLiveRun("text-boundary-adoption", haiku, {}));
  // An id outside APPROVED_LIVE_MODELS (Opus 5.5 is approved for the RPC probe matrix).
  assert.throws(() => requireLiveRun("text-boundary-adoption", "anthropic/claude-opus-4-1", env));
  assert.throws(() => requireLiveRun("host-compaction-arbitration", haiku, env));
  assert.equal(requireLiveRun("text-boundary-adoption", haiku, env).requests, 7);
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90,"cache_creation_input_tokens":5,"output_tokens":1}}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
    'data: {"type":"message_stop"}',
  ].join("\n\n");
  const lane = usageFromSse(
    'data: {"type":"message_delta","usage":{"input_tokens":0,"output_tokens":0,"iterations":[{"type":"compaction","input_tokens":7,"cache_read_input_tokens":3,"output_tokens":4}]}}',
  );
  assert.deepEqual(lane?.iterations, [{ input: 10, output: 4 }]);
  const ledger = new LiveLedger(new Recorder(), {
    requests: 1,
    inputTokens: 100,
    outputTokens: 10,
  });
  const id = ledger.reserve("foreground", 50);
  ledger.observe(id, new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  await ledger.drain();
  const report = ledger.report();
  assert.equal(report.inputTokens, 105, "cache reads and writes are billed input");
  assert.equal(report.outputTokens, 42, "message_delta overrides message_start output");
  assert.throws(() => ledger.reserve("foreground", 1000), /runaway-guard/u);
  const busy = new LiveLedger(new Recorder(), { requests: 5, inputTokens: 100, outputTokens: 10 });
  busy.observe(busy.reserve("summary", 1), new Response("", { status: 529 }));
  await busy.drain();
  assert.throws(() => busy.reserve("summary", 1), /provider-unavailable/u);
});

test("marker mapping follows wire order and refuses ambiguous markers", () => {
  const payload = { messages: [{ content: "MARK-B" }, { content: "MARK-A" }] };
  const markers = [
    { entryId: "a", text: "MARK-A" },
    { entryId: "b", text: "MARK-B" },
  ];
  assert.deepEqual(mapPayload(payload, markers), ["b", "a"]);
  const twice = [
    { entryId: "a", text: "SAME" },
    { entryId: "b", text: "SAME" },
  ];
  assert.throws(() => mapPayload({ content: "SAME" }, twice), /Ambiguous/u);
});

const MessagesSchema = Type.Object(
  { messages: Type.Array(Type.Record(Type.String(), JsonSchema)) },
  { additionalProperties: true },
);

/** Appends text to the last message after capture, as a late payload rewriter would. */
function appendLateText(payload: Static<typeof MessagesSchema>) {
  const last = payload.messages.at(-1);
  const content = last?.["content"];
  if (!last || !Value.Check(Type.Array(JsonSchema), content))
    throw new Error("Expected block content");
  const mutated = { ...last, content: [...content, { type: "text", text: LATE_MUTATION }] };
  return { ...payload, messages: [...payload.messages.slice(0, -1), mutated] };
}

test(
  "fake launcher isolates the process, blocks fetch and records the actual wire request",
  { timeout: 30000 },
  async () => {
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousFetch = globalThis.fetch;
    const host = await launch({
      scratchRoot,
      scenario: "harness-test",
      cycles: 0,
      factories: [
        (pi) => {
          pi.on("before_provider_request", (event) =>
            appendLateText(Value.Parse(MessagesSchema, event.payload)),
          );
        },
      ],
    });
    const root = host.root;
    try {
      assert.equal(process.env.PI_CODING_AGENT_DIR, host.agentDir);
      assert.deepEqual(await host.credentials.list(), []);
      await assert.rejects(
        host.credentials.modify("anthropic", async () => ({ type: "api_key", key: "not-secret" })),
      );
      await host.session.prompt(PROMPT);
      const before = host.recorder.records.find((item) => item.kind === "before-provider");
      const transport = host.recorder.records.find((item) => item.kind === "transport");
      assert.ok(before && transport);
      assert.equal(containsText(before.data, LATE_MUTATION), false);
      assert.equal(containsText(transport.data, LATE_MUTATION), true, "capture is the wire body");
      const promptEntry = host.markers.find((marker) => marker.text === PROMPT);
      assert.ok(promptEntry);
      assert.ok(mapPayload(transport.data, host.markers).includes(promptEntry.entryId));
      await assert.rejects(globalThis.fetch("https://harness.invalid/never"), /Network blocked/u);
      assert.equal(host.networkCalls(), 1, "every global fetch is counted");
      await assert.rejects(access(join(host.agentDir, "auth.json")));
    } finally {
      await host.cleanup();
    }
    assert.equal(process.env.PI_CODING_AGENT_DIR, previousDir);
    assert.equal(globalThis.fetch, previousFetch);
    await assert.rejects(access(root));
  },
);
