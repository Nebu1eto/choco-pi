import assert from "node:assert/strict";
import test from "node:test";
import { compile, obj, str } from "@earendil-works/pi-schema";
import { postV1Internal } from "../src/client/http.ts";
import { AntigravityError } from "../src/errors.ts";
import { fakeFetch, json } from "./helpers.ts";

const validator = compile(obj({ ok: str() }, { open: true }));
const ENDPOINTS = ["https://a.test", "https://b.test"];

test("503 and transport failures move to the next endpoint", async () => {
  let first = true;
  const fake = fakeFetch((call) => {
    if (call.url.startsWith("https://a.test")) {
      if (first) {
        first = false;
        return json(503, '{"error":{"code":503,"status":"UNAVAILABLE","message":"busy"}}');
      }
      throw new TypeError("fetch failed");
    }
    return json(200, '{"ok":"yes"}');
  });
  assert.deepEqual(
    await postV1Internal(
      "m",
      {},
      { token: "secret-token", validator, fetch: fake.fetch, endpoints: ENDPOINTS },
    ),
    { ok: "yes" },
  );
  assert.deepEqual(
    await postV1Internal(
      "m",
      {},
      { token: "secret-token", validator, fetch: fake.fetch, endpoints: ENDPOINTS },
    ),
    { ok: "yes" },
  );
  assert.deepEqual(
    fake.calls.map((call) => call.url),
    [
      "https://a.test/v1internal:m",
      "https://b.test/v1internal:m",
      "https://a.test/v1internal:m",
      "https://b.test/v1internal:m",
    ],
  );
});

test("429 fails at once and errors never carry the token or body", async () => {
  const fake = fakeFetch(() =>
    json(429, '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}'),
  );
  await assert.rejects(
    postV1Internal(
      "m",
      { secret_body: "do-not-leak" },
      { token: "secret-token", validator, fetch: fake.fetch, endpoints: ENDPOINTS },
    ),
    (error) =>
      error instanceof AntigravityError && !/secret-token|do-not-leak/u.test(error.message),
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.headers.get("authorization"), "Bearer secret-token");
});

test("schema mismatches and 200 error bodies are typed errors", async () => {
  const bad = fakeFetch(() => json(200, '{"other":1}'));
  await assert.rejects(
    postV1Internal("m", {}, { token: "t", validator, fetch: bad.fetch, endpoints: ENDPOINTS }),
    (error) => error instanceof AntigravityError && error.kind === "malformed_response",
  );
  const wrapped = fakeFetch(() =>
    json(200, '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"no"}}'),
  );
  await assert.rejects(
    postV1Internal("m", {}, { token: "t", validator, fetch: wrapped.fetch, endpoints: ENDPOINTS }),
    (error) => error instanceof AntigravityError && error.kind === "permission",
  );
});

test("a caller abort rejects with the abort reason and stops the walk", async () => {
  const controller = new AbortController();
  const fake = fakeFetch(() => {
    controller.abort(new Error("stop"));
    throw new DOMException("aborted", "AbortError");
  });
  await assert.rejects(
    postV1Internal(
      "m",
      {},
      { token: "t", validator, fetch: fake.fetch, endpoints: ENDPOINTS, signal: controller.signal },
    ),
    /stop/u,
  );
  assert.equal(fake.calls.length, 1);
});
