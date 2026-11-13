import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createBridgeSessionRuntime,
  type BridgeExecSession,
} from "../src/tools/exec/bridge-session.ts";
import { createExecSessionManager } from "../src/tools/exec/session-manager.ts";

// A fake exec_bridge: answers exec, then one read whose first chunk seq jumps
// from 1 to 4 (chunks 2 and 3 were discarded), then reports the close.
const FAKE_BRIDGE = `#!/usr/bin/env node
const b64 = (s) => Buffer.from(s).toString("base64");
let reads = 0;
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    let result;
    if (req.op === "exec") result = { processId: req.process_id };
    else if (req.op === "read") {
      reads++;
      if (reads === 1) result = { chunks: [{ seq: 1, stream: "stdout", chunk: b64("head\\n") }], nextSeq: 2, exited: false, closed: false };
      else if (reads === 2) result = { chunks: [{ seq: 4, stream: "stdout", chunk: b64("tail\\n") }], nextSeq: 5, exited: true, exitCode: 0, closed: true };
      else result = { chunks: [], nextSeq: 5, exited: true, exitCode: 0, closed: true };
    } else if (req.op === "shutdown") { process.stdout.write(JSON.stringify({ request_id: req.request_id, ok: true, result: {}, error: null }) + "\\n"); process.exit(0); } else result = {};
    process.stdout.write(JSON.stringify({ request_id: req.request_id, ok: true, result, error: null }) + "\\n");
  }
});
`;

async function withFakeBridge<T>(run: (binary: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-fake-bridge-"));
  const binary = join(dir, "exec_bridge.js");
  await writeFile(binary, FAKE_BRIDGE, { mode: 0o755 });
  await chmod(binary, 0o755);
  try {
    return await run(binary);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a seq gap from the bridge is surfaced in the output instead of hidden", async () => {
  await withFakeBridge(async (binary) => {
    const runtime = createBridgeSessionRuntime(() => binary);
    let output = "";
    let exited = false;
    const hooks = {
      isOwned: () => true,
      onOutput: (_session: BridgeExecSession, text: string) => {
        output += text;
      },
      onExit: () => {
        exited = true;
      },
    };
    const session = runtime.create({
      id: 1,
      input: { command: "x", executionCommand: "x", executionEnv: {}, tty: false, login: false },
      workdir: tmpdir(),
      shell: "/bin/sh",
      hooks,
    });
    await runtime.waitForStartup(session);
    for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 20));
    await runtime.shutdown();
    assert.ok(exited, "session exits");
    assert.equal(session.droppedChunks, 2);
    assert.match(output, /^head\n/);
    assert.match(output, /discarded 2 unread output chunks \(up to 16 KiB\)/);
    assert.match(output, /tail\n$/);
    assert.equal(session.lastSeq, 4);
  });
});

test("a contiguous stream reports no drop", async () => {
  const manager = createExecSessionManager({});
  try {
    const result = await manager.exec(
      { cmd: "seq 1 200000", yield_time_ms: 60_000, max_output_tokens: 100 },
      process.cwd(),
      undefined,
      undefined,
    );
    assert.equal(result.exit_code, 0);
    assert.doesNotMatch(result.output, /exec_bridge discarded/);
  } finally {
    await manager.shutdown();
  }
});

test("a stalled host sees the drop at the head of the result even when the tail is truncated", async () => {
  const manager = createExecSessionManager({});
  // Stall the event loop for 1.5 s once the producer is running; the bridge's
  // ~8 MiB unread ring overflows and the oldest chunks are discarded.
  const stall = setTimeout(() => {
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      /* synchronous stall */
    }
  }, 400);
  try {
    const result = await manager.exec(
      {
        cmd: "head -c 67108864 /dev/zero | tr '\\0' 'x' | fold -w 200",
        yield_time_ms: 120_000,
        max_output_tokens: 400,
      },
      process.cwd(),
      undefined,
      undefined,
    );
    assert.equal(result.exit_code, 0);
    assert.match(
      result.output,
      /^\[exec_bridge discarded \d+ unread output chunks \(up to \d+ KiB\) while the host was busy; this output is incomplete\]\n/,
    );
  } finally {
    clearTimeout(stall);
    await manager.shutdown();
  }
});
