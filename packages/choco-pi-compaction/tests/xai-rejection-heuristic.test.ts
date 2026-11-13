/**
 * Provider rejection heuristic of the xAI replay (O3): only an HTTP 400/422
 * whose JSON `error.message|code|param` names the compaction item turns
 * server-side compaction off; any other body (a mode error mentioning
 * "compact", plain text) does not.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject } from "@earendil-works/pi-ai";

import { xaiReplayRejectionCode } from "../src/xai/replay.ts";

function jsonResponse(status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a 400 that only mentions compact mode is not a rejection of the item", async () => {
  assert.equal(
    await xaiReplayRejectionCode(
      jsonResponse(400, { error: { message: "compact mode unsupported" } }),
    ),
    undefined,
  );
});

test("a 400 whose error.param points at input[0] names the item", async () => {
  assert.equal(
    await xaiReplayRejectionCode(jsonResponse(400, { error: { param: "input[0]" } })),
    "provider-400",
  );
});

test("encrypted_content in error.message, or a compaction-item error code, names the item", async () => {
  assert.equal(
    await xaiReplayRejectionCode(
      jsonResponse(422, { error: { message: "invalid encrypted_content" } }),
    ),
    "provider-422",
  );
  assert.equal(
    await xaiReplayRejectionCode(jsonResponse(400, { error: { code: "invalid compaction item" } })),
    "provider-400",
  );
  assert.equal(
    await xaiReplayRejectionCode(
      jsonResponse(400, { error: { message: 'unknown item of type "compaction"' } }),
    ),
    "provider-400",
  );
});

test("plain text, non-string fields, other shapes and other statuses are not rejections", async () => {
  assert.equal(
    await xaiReplayRejectionCode(new Response("bad encrypted_content", { status: 400 })),
    undefined,
  );
  assert.equal(
    await xaiReplayRejectionCode(jsonResponse(400, { error: { param: ["input[0]"] } })),
    undefined,
  );
  assert.equal(
    await xaiReplayRejectionCode(jsonResponse(400, { message: "encrypted_content" })),
    undefined,
  );
  assert.equal(
    await xaiReplayRejectionCode(
      jsonResponse(500, { error: { message: "invalid encrypted_content" } }),
    ),
    undefined,
  );
  assert.equal(
    await xaiReplayRejectionCode(
      jsonResponse(401, { error: { message: "invalid encrypted_content" } }),
    ),
    undefined,
  );
});
