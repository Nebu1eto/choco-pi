import assert from "node:assert/strict";
import test from "node:test";
import { applyDefaultCacheRetention } from "../.pi/extensions/cache-retention.ts";

test("defaults PI_CACHE_RETENTION to long when unset", () => {
  const env: Record<string, string | undefined> = {};
  applyDefaultCacheRetention(env);
  assert.equal(env.PI_CACHE_RETENTION, "long");
});

test("preserves an explicit PI_CACHE_RETENTION value", () => {
  const env: Record<string, string | undefined> = { PI_CACHE_RETENTION: "none" };
  applyDefaultCacheRetention(env);
  assert.equal(env.PI_CACHE_RETENTION, "none");
});
