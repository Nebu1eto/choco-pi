import assert from "node:assert/strict";
import test from "node:test";
import { compile, obj, str, arr, unknown } from "@earendil-works/pi-schema";
import { countAntigravityTokens } from "../src/client/count-tokens.ts";
import { fakeFetch, json } from "./helpers.ts";

const ENDPOINTS = ["https://cloudcode.test"];
const isCountRequest = compile(
  obj({
    request: obj({
      model: str(),
      contents: arr(unknown()),
      systemInstruction: obj({ role: str(), parts: arr(unknown()) }),
    }),
  }),
).check;

function count(
  fetch: ReturnType<typeof fakeFetch>["fetch"],
  signal?: AbortSignal,
  timeoutMs?: number,
) {
  return countAntigravityTokens({
    token: "fake",
    model: "gemini-3.8-flash-low",
    system: "sys",
    promptText: "hello",
    fetch,
    signal,
    timeoutMs,
    endpoints: ENDPOINTS,
  });
}

test("success sends the CountTokensRequest wrapper and returns totalTokens", async () => {
  const fake = fakeFetch(() => json(200, '{"totalTokens":42}'));
  assert.deepEqual(await count(fake.fetch), { ok: true, inputTokens: 42 });
  assert.equal(fake.calls[0]?.url, "https://cloudcode.test/v1internal:countTokens");
  const body: unknown = JSON.parse(fake.calls[0]?.body ?? "");
  assert.ok(isCountRequest(body));
  assert.equal(body.request.model, "gemini-3.8-flash-low");
});

test("malformed, auth and rate-limit failures resolve to typed results", async () => {
  const malformed = await count(fakeFetch(() => json(200, '{"tokens":1}')).fetch);
  assert.equal(malformed.ok, false);
  assert.ok(!malformed.ok && malformed.code === "malformed");
  const auth = await count(
    fakeFetch(() => json(401, '{"error":{"code":401,"status":"UNAUTHENTICATED","message":"no"}}'))
      .fetch,
  );
  assert.ok(!auth.ok && auth.code === "auth" && auth.status === 401);
  const limited = await count(
    fakeFetch(() =>
      json(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow down"}}'),
    ).fetch,
  );
  assert.ok(!limited.ok && limited.code === "rate-limit");
});

test("timeout and abort resolve instead of throwing", async () => {
  const hang = fakeFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        void call;
        setTimeout(
          () => reject(new DOMException("The operation was aborted", "TimeoutError")),
          100,
        );
      }),
  );
  const timedOut = await count(hang.fetch, undefined, 20);
  assert.ok(!timedOut.ok && timedOut.code === "timeout");
  const controller = new AbortController();
  controller.abort();
  const aborted = await count(
    fakeFetch(() => json(200, '{"totalTokens":1}')).fetch,
    controller.signal,
  );
  assert.ok(!aborted.ok && aborted.code === "aborted");
});
