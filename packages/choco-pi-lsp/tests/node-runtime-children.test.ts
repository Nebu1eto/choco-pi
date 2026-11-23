import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "lsp-node-runtime-")));
process.env.CHOCO_PI_LSP_HOME = path.join(scratch, "lsp-home");
const { launchViaNode, stopLSP } = await import("../clients/lsp/launch.ts");
const { getToolEnvironment } = await import("../clients/installer/index.ts");
const { analyzeFileFresh } = await import("../clients/mcp/review.ts");

test.after(() => rm(scratch, { recursive: true, force: true }));

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

test("Node-script language servers and npm tool PATHs use CHOCO_PI_NODE under Bun", async () => {
  const directory = await mkdtemp(path.join(scratch, "launch-"));
  const { node, log } = await recordingNode(directory);
  const script = path.join(directory, "server.mjs");
  await writeFile(
    script,
    "process.stdout.write(process.env.PATH + '\\n'); process.stdin.resume();\n",
  );
  const handle = await underSimulatedBun(node, () => launchViaNode(script, ["--stdio"]));
  try {
    assert.equal(handle.command, node, "launchViaNode spawns CHOCO_PI_NODE");
    const pathLine = await new Promise<string>((resolve) => {
      let text = "";
      handle.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes("\n")) resolve(text.split("\n")[0] ?? "");
      });
    });
    assert.ok(
      pathLine.split(path.delimiter).includes(path.dirname(node)),
      "shebang tools resolve node from CHOCO_PI_NODE's directory",
    );
  } finally {
    await stopLSP(handle);
  }
  assert.deepEqual((await readFile(log, "utf8")).split("\n").slice(0, 2), [script, "--stdio"]);

  const environment = await underSimulatedBun(node, () => getToolEnvironment());
  assert.ok(String(environment.PATH).split(path.delimiter).includes(path.dirname(node)));
  const underNode = await getToolEnvironment();
  assert.ok(String(underNode.PATH).split(path.delimiter).includes(path.dirname(process.execPath)));
});

test("the fresh analyze worker runs on CHOCO_PI_NODE under Bun", async () => {
  const directory = await mkdtemp(path.join(scratch, "review-"));
  const { node, log } = await recordingNode(directory);
  const worker = path.join(directory, "worker.mjs");
  await writeFile(worker, "process.stdout.write(JSON.stringify({ ok: 1 }));\n");
  await mkdir(path.join(directory, "cwd"));
  const outcome = await underSimulatedBun(node, () =>
    analyzeFileFresh(worker, "a.ts", path.join(directory, "cwd"), {}, 20_000),
  );
  assert.equal(outcome.error, undefined);
  assert.deepEqual(outcome.result, { ok: 1 });
  assert.equal((await readFile(log, "utf8")).split("\n")[0], worker);
});
