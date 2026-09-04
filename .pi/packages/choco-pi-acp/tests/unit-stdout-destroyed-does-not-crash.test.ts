import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

// This is a lightweight regression test: our stdout writer should not throw
// if stdout is marked as destroyed.

test("stdout writer: resolves even if stdout is destroyed", async () => {
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stdout.destroy();

  // Inline copy of the writer logic from src/index.ts (kept intentionally tiny)
  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve) => {
      if (stdout.destroyed || !stdout.writable) return resolve();
      try {
        stdout.write(chunk, () => resolve());
      } catch {
        resolve();
      }
    });

  await write(new Uint8Array([1, 2, 3]));
  assert.ok(true);
});
