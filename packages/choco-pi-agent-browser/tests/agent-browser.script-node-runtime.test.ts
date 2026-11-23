import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgentBrowserScript } from "../extensions/agent-browser/lib/input-modes/script.ts";

async function underSimulatedBun<T>(nodePath: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.CHOCO_PI_NODE;
  Object.defineProperty(process.versions, "bun", {
    value: "1.4.4",
    configurable: true,
    enumerable: true,
  });
  process.env.CHOCO_PI_NODE = nodePath;
  try {
    return await body();
  } finally {
    Reflect.deleteProperty(process.versions, "bun");
    if (previous === undefined) delete process.env.CHOCO_PI_NODE;
    else process.env.CHOCO_PI_NODE = previous;
  }
}

async function recordingNode(directory: string): Promise<{ node: string; log: string }> {
  const bin = path.join(directory, "node-bin");
  await mkdir(bin, { recursive: true });
  const node = path.join(bin, "node");
  const log = path.join(directory, "node-argv.log");
  await writeFile(
    node,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o755 },
  );
  return { node, log };
}

test("the script worker keeps Node's permission sandbox when Pi runs under Bun", async (t) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ab-script-node-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { node, log } = await recordingNode(directory);
  const run = await underSimulatedBun(node, () =>
    runAgentBrowserScript({
      code: "emit({ ok: true });",
      dispatch: async () => {
        throw new Error("no browser calls expected");
      },
      timeoutMs: 10_000,
    }),
  );
  assert.equal(run.ok, true, run.error ?? "script failed");
  const argv = (await readFile(log, "utf8")).split("\n");
  assert.equal(argv[0], "--permission", "the worker ran through CHOCO_PI_NODE with Node flags");
  assert.ok(argv.some((argument) => argument.startsWith("--allow-fs-read=")));
});
