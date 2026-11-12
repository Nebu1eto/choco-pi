import assert from "node:assert/strict";
import test from "node:test";

import { snakeCaseKey, toSnakeCaseKeys } from "../.pi/extensions/lib/tool-output-keys.ts";

test("snakeCaseKey follows the camel to snake rule", () => {
  assert.equal(snakeCaseKey("fileKey"), "file_key");
  assert.equal(snakeCaseKey("waitForDownload"), "wait_for_download");
  assert.equal(snakeCaseKey("already_snake"), "already_snake");
  assert.equal(snakeCaseKey("kebab-case"), "kebab-case");
  assert.equal(snakeCaseKey("word"), "word");
});

test("toSnakeCaseKeys converts nested plain object keys only", () => {
  const date = new Date(0);
  const map = new Map([["someKey", 1]]);
  class Holder {
    innerKey = 1;
  }
  const holder = new Holder();
  const converted = toSnakeCaseKeys({
    sessionId: "camelValue",
    nested: { messageCount: 2, list: [{ timedOut: false }, "someValue", 3] },
    date,
    map,
    holder,
    nothing: null,
    missing: undefined,
  });
  assert.deepEqual(converted, {
    session_id: "camelValue",
    nested: { message_count: 2, list: [{ timed_out: false }, "someValue", 3] },
    date,
    map,
    holder,
    nothing: null,
    missing: undefined,
  });
  assert.equal(Object.getPrototypeOf(converted), Object.prototype);
});

test("toSnakeCaseKeys passes scalars through", () => {
  assert.equal(toSnakeCaseKeys("fooBar"), "fooBar");
  assert.equal(toSnakeCaseKeys(5), 5);
  assert.equal(toSnakeCaseKeys(null), null);
});
