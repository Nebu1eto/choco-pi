/**
 * xAI usable capture ring (the Anthropic ring's policy, D8): only an HTTP 200
 * answer to a mapped request is a usable capture. Any other response goes to
 * a bounded diagnostics ring (eight per session), so a retry burst never
 * evicts the last usable capture and a failed request never becomes the
 * prefix sent to the compact endpoint.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  bindXaiSessionProjection,
  createXaiCapturingStreamSimple,
  recentXaiResponsesFor,
  releaseXaiSessionCaptures,
  xaiCapturesFor,
} from "../src/xai/capture.ts";
import {
  compactionsOf,
  compactResponse,
  createXaiRig,
  recordingFetch,
  textResponse,
  XAI_API_KEY,
  XAI_MODEL,
} from "./xai-rig.ts";

function outage(): Response {
  return new Response(JSON.stringify({ error: { message: "synthetic outage" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

/** A session with one projected user message and a captured stream answering per `respond`. */
function rig(sessionId: string, respond: (index: number) => Response, options = { bind: true }) {
  const manager = SessionManager.inMemory("/xai-capture-ring");
  manager.appendMessage({ role: "user", content: "XRING-PROMPT", timestamp: 0 });
  const unbind = options.bind
    ? bindXaiSessionProjection(sessionId, () => manager.buildSessionProjection().entries)
    : () => undefined;
  let index = 0;
  const stream = createXaiCapturingStreamSimple({ fetch: async () => respond(index++) });
  const context = normalizeContext({
    messages: [{ role: "user", content: "XRING-PROMPT", timestamp: 0 }],
  });
  return {
    async send(): Promise<void> {
      for await (const event of stream(XAI_MODEL, context, { apiKey: XAI_API_KEY, sessionId })) {
        if (event.type === "error") break;
      }
    },
    dispose(): void {
      unbind();
      releaseXaiSessionCaptures(sessionId);
    },
  };
}

test("a non-200 burst does not evict the last usable xAI capture", async () => {
  const sessionId = "xai-capture-ring-burst";
  const host = rig(sessionId, (index) => (index === 0 ? textResponse("XRING-OK") : outage()));
  try {
    await host.send();
    const [usable] = xaiCapturesFor(sessionId);
    assert.ok(usable?.mapping, "the 200 answer is a mapped, usable capture");
    assert.equal(usable.status, 200);
    for (let attempt = 0; attempt < 4; attempt++) await host.send();
    assert.deepEqual(
      xaiCapturesFor(sessionId).map((capture) => capture.sequence),
      [usable.sequence],
      "the failed requests left the usable ring unchanged",
    );
    assert.deepEqual(
      recentXaiResponsesFor(sessionId).map((response) => response.status),
      [500, 500, 500, 500],
      "kept for diagnostics only",
    );
  } finally {
    host.dispose();
  }
});

test("the xAI diagnostics ring is bounded at eight responses per session", async () => {
  const sessionId = "xai-capture-ring-bounded";
  const host = rig(sessionId, () => outage());
  try {
    for (let attempt = 0; attempt < 11; attempt++) await host.send();
    const responses = recentXaiResponsesFor(sessionId);
    assert.equal(responses.length, 8);
    const sequences = responses.map((response) => response.sequence);
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
      "oldest first",
    );
    assert.equal(xaiCapturesFor(sessionId).length, 0);
  } finally {
    host.dispose();
  }
  assert.equal(recentXaiResponsesFor(sessionId).length, 0, "released with the session");
});

test("a 200 answer to an unmapped request is not a usable xAI capture", async () => {
  const sessionId = "xai-capture-ring-unmapped";
  const host = rig(sessionId, () => textResponse("XRING-OK"), { bind: false });
  try {
    await host.send();
    assert.equal(xaiCapturesFor(sessionId).length, 0);
    assert.deepEqual(
      recentXaiResponsesFor(sessionId).map((response) => response.status),
      [200],
    );
  } finally {
    host.dispose();
  }
});

test("a failed xAI request never becomes the compaction prefix", { timeout: 60_000 }, async () => {
  const foreground = recordingFetch((index) =>
    index === 1 ? outage() : textResponse(`XRING-ANSWER-${index}`),
  );
  const lane = recordingFetch(() => compactResponse());
  const rig = await createXaiRig({ foreground, lane, child: true });
  try {
    const sessionId = rig.manager.getSessionId();
    await rig.session.prompt("XRING-ANSWERED");
    await rig.session.prompt("XRING-FAILED-NEWER");
    assert.equal(foreground.sent.length, 2);
    assert.ok(foreground.sent[1]?.text.includes("XRING-FAILED-NEWER"), "the failed request");
    assert.equal(xaiCapturesFor(sessionId).length, 1, "only the answered request is usable");
    assert.deepEqual(
      recentXaiResponsesFor(sessionId).map((response) => response.status),
      [500],
    );
    await rig.session.compact();
    assert.equal(lane.sent.length, 1, "the compact endpoint was called");
    const compacted = lane.sent[0]?.text ?? "";
    assert.ok(compacted.includes("XR-PREFIX-A"), "the answered request's prefix is compacted");
    assert.equal(
      compacted.includes("XRING-FAILED-NEWER"),
      false,
      "the failed request's body is never compacted",
    );
    assert.equal(compactionsOf(rig.manager).length, 1);
  } finally {
    await rig.dispose();
  }
});
