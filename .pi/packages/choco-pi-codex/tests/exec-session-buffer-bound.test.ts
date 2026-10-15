import assert from "node:assert/strict";
import test from "node:test";
import v8 from "node:v8";

import { createExecSessionManager } from "../src/tools/exec/session-manager.ts";

// A fast producer must not grow the host heap with its output volume. With the
// former 256 MiB pipe buffer a 64 MiB producer retained hundreds of MB of
// cons/flattened string copies; a 1 GB producer took a 4 GB host down.
test("a large pipe producer leaves the host heap bounded and the count intact", async () => {
  const manager = createExecSessionManager({});
  const megabytes = 64;
  const heapBefore = v8.getHeapStatistics().used_heap_size;
  let peak = heapBefore;
  const sampler = setInterval(() => {
    peak = Math.max(peak, v8.getHeapStatistics().used_heap_size);
  }, 50);
  try {
    const result = await manager.exec(
      {
        cmd: `head -c ${megabytes * 1024 * 1024} /dev/zero | tr '\\0' 'x' | fold -w 200`,
        yield_time_ms: 120_000,
        max_output_tokens: 1_000,
      },
      process.cwd(),
      undefined,
      undefined,
    );
    assert.equal(result.exit_code, 0);
    assert.ok(result.output.length <= 4_000 + 200, "reader gets only the requested tail");
    assert.ok(
      (result.original_token_count ?? 0) >= (megabytes * 1024 * 1024) / 4 / 1.1,
      "the dropped head is still counted",
    );
  } finally {
    clearInterval(sampler);
    await manager.shutdown();
  }
  const growth = peak - heapBefore;
  assert.ok(
    growth < 160 * 1024 * 1024,
    `heap grew by ${Math.round(growth / 1024 / 1024)} MB for a ${megabytes} MB producer`,
  );
});
