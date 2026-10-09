import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  claimSessionFile,
  releaseSessionFile,
  sessionFileOwner,
  waitForSessionFileRelease,
} from "../src/session-file-ownership.ts";

let fileCounter = 0;
function freshFile(): string {
  fileCounter += 1;
  return `/tmp/choco-pi-ownership-test/${process.pid}-${fileCounter}.jsonl`;
}

test("claim is exclusive, idempotent for the owner, and normalizes paths", () => {
  const file = freshFile();
  assert.equal(claimSessionFile(file, "a"), true);
  assert.equal(claimSessionFile(file, "a"), true);
  assert.equal(claimSessionFile(file, "b"), false);
  assert.equal(claimSessionFile(`${file}/../${file.split("/").at(-1) ?? ""}`, "b"), false);
  assert.equal(sessionFileOwner(file), "a");
  assert.equal(claimSessionFile(file, ""), false);
  releaseSessionFile(file, "a");
  assert.equal(sessionFileOwner(file), undefined);
  assert.equal(claimSessionFile(file, "b"), true);
  releaseSessionFile(file, "b");
});

test("only the owner releases", () => {
  const file = freshFile();
  assert.equal(claimSessionFile(file, "a"), true);
  releaseSessionFile(file, "b");
  assert.equal(sessionFileOwner(file), "a");
  releaseSessionFile(file, "a");
  assert.equal(sessionFileOwner(file), undefined);
});

test("wait resolves immediately for an unowned file", async () => {
  assert.equal(await waitForSessionFileRelease(freshFile(), { timeoutMs: 10_000 }), "released");
});

test("release resolves every waiter exactly once; non-owner release does not", async () => {
  const file = freshFile();
  claimSessionFile(file, "a");
  const first = waitForSessionFileRelease(file, { timeoutMs: 10_000 });
  const second = waitForSessionFileRelease(file, { timeoutMs: 10_000 });
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  releaseSessionFile(file, "b");
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(settled, false);
  releaseSessionFile(file, "a");
  assert.deepEqual(await Promise.all([first, second]), ["released", "released"]);
});

test("wait times out while the owner holds the file", async () => {
  const file = freshFile();
  claimSessionFile(file, "a");
  assert.equal(await waitForSessionFileRelease(file, { timeoutMs: 5 }), "timeout");
  releaseSessionFile(file, "a");
});

test("wait aborts, including an already-aborted signal", async () => {
  const file = freshFile();
  claimSessionFile(file, "a");
  const controller = new AbortController();
  const pending = waitForSessionFileRelease(file, {
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await pending, "aborted");
  assert.equal(
    await waitForSessionFileRelease(file, { timeoutMs: 10_000, signal: controller.signal }),
    "aborted",
  );
  // A later release after abort must not throw or resettle.
  releaseSessionFile(file, "a");
});

const OwnershipModuleSchema = Type.Object({
  claimSessionFile: Type.Function([Type.String(), Type.String()], Type.Boolean()),
  releaseSessionFile: Type.Function([Type.String(), Type.String()], Type.Void()),
  sessionFileOwner: Type.Function([Type.String()], Type.Union([Type.String(), Type.Undefined()])),
});

test("ownership state survives module re-import (reload)", async () => {
  const file = freshFile();
  assert.equal(claimSessionFile(file, "old-instance"), true);
  const specifier = `${new URL("../src/session-file-ownership.ts", import.meta.url).href}?reload=1`;
  const reloaded: unknown = await import(specifier);
  assert.ok(Value.Check(OwnershipModuleSchema, reloaded));
  assert.equal(reloaded.sessionFileOwner(file), "old-instance");
  assert.equal(reloaded.claimSessionFile(file, "new-instance"), false);
  const waiting = waitForSessionFileRelease(file, { timeoutMs: 10_000 });
  releaseSessionFile(file, "old-instance");
  assert.equal(await waiting, "released");
  assert.equal(reloaded.claimSessionFile(file, "new-instance"), true);
  reloaded.releaseSessionFile(file, "new-instance");
});
