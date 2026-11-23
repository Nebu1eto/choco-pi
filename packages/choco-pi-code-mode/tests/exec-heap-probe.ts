// Child-process probe for exec-session-buffer-bound.test.ts; run with --expose-gc.
// Prints one JSON line: the live (post-GC) heap growth while a large producer runs,
// the heap still retained once it finished, and the exec result fields the test checks.
import v8 from "node:v8";

import { createExecSessionManager } from "../src/tools/exec/session-manager.ts";

const MB = 1024 * 1024;
const collect = globalThis.gc;
if (!collect) throw new Error("exec-heap-probe needs --expose-gc");
const used = () => v8.getHeapStatistics().used_heap_size;
const megabytes = Number(process.argv[2] ?? "64");

const manager = createExecSessionManager({});
collect();
const base = used();
let liveMax = 0;
let next = 32 * MB;
// Sampled peaks include garbage the collector has not reached yet, so they track GC
// pacing, not memory the host must hold. Collect whenever growth crosses the next
// step and keep only what survives.
const sampler = setInterval(() => {
  if (used() - base <= next) return;
  collect();
  const live = used() - base;
  liveMax = Math.max(liveMax, live);
  next = live + 32 * MB;
}, 50);
try {
  const result = await manager.exec(
    {
      cmd: `head -c ${megabytes * MB} /dev/zero | tr '\\0' 'x' | fold -w 200`,
      yield_time_ms: 120_000,
      max_output_tokens: 1_000,
    },
    process.cwd(),
    undefined,
    undefined,
  );
  clearInterval(sampler);
  collect();
  const retained = used() - base;
  process.stdout.write(
    `${JSON.stringify({
      exit_code: result.exit_code ?? null,
      output_length: result.output.length,
      original_token_count: result.original_token_count ?? 0,
      live_max_mb: Math.max(liveMax, retained) / MB,
      retained_mb: retained / MB,
    })}\n`,
  );
} finally {
  clearInterval(sampler);
  await manager.shutdown();
}
