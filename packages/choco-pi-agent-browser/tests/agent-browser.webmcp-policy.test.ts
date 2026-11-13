import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  preflightWebMcpParams,
  redactWebMcpMetadata,
  WebMcpInvocationRegistry,
} from "../extensions/agent-browser/lib/webmcp-policy.ts";

test("reads params asynchronously without exposing nested secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-browser-webmcp-"));
  try {
    await writeFile(
      join(cwd, "params.json"),
      JSON.stringify({ nested: { token: "secret" }, safe: 1 }),
    );
    const result = await preflightWebMcpParams("@params.json", cwd);
    assert.deepEqual(result.params, { nested: { token: "secret" }, safe: 1 });
    assert.equal(result.summary.includes("secret"), false);
    assert.deepEqual(redactWebMcpMetadata(result.params), {
      nested: { token: "[REDACTED]" },
      safe: 1,
    });
    await assert.rejects(preflightWebMcpParams("@missing-secret.json", cwd), /Unable to read/);
    await assert.rejects(preflightWebMcpParams("[1,2]", cwd), /JSON object/);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("detached invocation lifecycle rejects every wrong-owner dimension", () => {
  const registry = new WebMcpInvocationRegistry();
  const owner = { frame: "frame-a", generation: 4, namespace: "ns", session: "s" };
  registry.register({ ...owner, invocationId: "invoke-1" });
  for (const wrongOwner of [
    { ...owner, frame: "frame-b" },
    { ...owner, generation: 5 },
    { ...owner, namespace: "other" },
    { ...owner, session: "other" },
  ]) {
    assert.throws(() => registry.assertOwned("invoke-1", wrongOwner), /not owned/);
  }
  assert.deepEqual(registry.takeOwned({ ...owner, generation: 5 }), []);
  assert.equal(registry.assertOwned("invoke-1", owner).invocationId, "invoke-1");
  registry.settle("invoke-1", owner);
  assert.throws(() => registry.assertOwned("invoke-1", owner), /not owned/);
});
