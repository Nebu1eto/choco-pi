import assert from "node:assert/strict";
import test from "node:test";
import { scratchRoot } from "../e2e/isolation.ts";

test("scratchRoot prefers PI_SCRATCH_DIR", () => {
  assert.equal(
    scratchRoot({ PI_SCRATCH_DIR: "/tmp/choco-pi/root-1/", PI_SESSION_ID: "other" }),
    "/tmp/choco-pi/root-1/e2e",
  );
});

test("scratchRoot falls back to the session id", () => {
  assert.equal(scratchRoot({ PI_SESSION_ID: "a/b" }), "/tmp/choco-pi/a_b/e2e");
  const fallback = scratchRoot({});
  assert.ok(fallback.startsWith("/tmp/choco-pi/") && fallback.endsWith("/e2e"));
});
