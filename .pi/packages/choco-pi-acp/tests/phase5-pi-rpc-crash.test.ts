import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiAcpAgent } from "../src/acp/agent.ts";
import { PiAcpSession } from "../src/acp/session.ts";
import { PiRpcProcess } from "../src/pi-rpc/process.ts";
import { FakeAgentSideConnection, asAgentConn } from "./helpers-fakes.ts";

function executable(root: string, source: string): string {
  const path = join(root, "fake-pi");
  writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

test("a child exit after prompt acknowledgement settles the active and queued ACP turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-acked-crash-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let proc: PiRpcProcess | undefined;

  try {
    proc = await bounded(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable(
          root,
          `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true, data: {} }) + "\\n");
  setTimeout(() => process.exit(47), 20);
});
`,
        ),
      }),
      "spawn acknowledged-crash Pi",
    );
    const session = new PiAcpSession({
      sessionId: `phase5-acked-crash-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc,
      conn: asAgentConn(new FakeAgentSideConnection()),
    });

    const active = session.prompt("active turn");
    const queued = session.prompt("queued turn");
    assert.deepEqual(
      await bounded(Promise.all([active, queued]), "settle turns after acknowledged crash"),
      ["error", "error"],
    );
    await assert.rejects(session.prompt("after child exit"), /pi process exited \(code=47/);
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a child exit after cancellation settles the acknowledged ACP turn as cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-cancelled-crash-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let proc: PiRpcProcess | undefined;

  try {
    proc = await bounded(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable(
          root,
          `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} }) + "\\n");
  if (request.type === "abort") setTimeout(() => process.exit(48), 20);
});
`,
        ),
      }),
      "spawn cancelled-crash Pi",
    );
    const session = new PiAcpSession({
      sessionId: `phase5-cancelled-crash-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc,
      conn: asAgentConn(new FakeAgentSideConnection()),
    });

    const active = session.prompt("active turn");
    await bounded(session.cancel(), "acknowledge cancellation");
    assert.equal(await bounded(active, "settle cancelled crashed turn"), "cancelled");
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function crashSource(kind: "exit" | "signal", recordsPath: string): string {
  const crash = kind === "exit" ? "process.exit(23);" : 'process.kill(process.pid, "SIGTERM");';
  return `
const fs = require("node:fs");
const readline = require("node:readline");
const recordsPath = ${JSON.stringify(recordsPath)};
fs.writeFileSync(recordsPath, JSON.stringify({ pid: process.pid }) + "\\n");
let requests = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  JSON.parse(line);
  requests += 1;
  if (requests === 2) ${crash}
});
`;
}

for (const kind of ["exit", "signal"] as const) {
  test(
    `Pi RPC ${kind} crash rejects all pending requests once and becomes deterministically stale`,
    { skip: kind === "signal" && process.platform === "win32" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), `choco-pi-phase5-${kind}-`));
      const recordsPath = join(root, "records.jsonl");
      const piCommand = executable(root, crashSource(kind, recordsPath));
      let proc: PiRpcProcess | undefined;

      try {
        proc = await bounded(PiRpcProcess.spawn({ cwd: root, piCommand }), "spawn fake Pi");
        let settlements = 0;
        const first = proc.getState().finally(() => {
          settlements += 1;
        });
        const second = proc.getAvailableModels().finally(() => {
          settlements += 1;
        });

        const results = await bounded(Promise.allSettled([first, second]), "settle crashed RPCs");
        assert.deepEqual(
          results.map((result) => result.status),
          ["rejected", "rejected"],
        );
        const expected = kind === "exit" ? /code=23, signal=null/ : /code=null, signal=SIGTERM/;
        for (const result of results) {
          assert.ok(result.status === "rejected", "every pending RPC rejects after the crash");
          assert.match(String(result.reason), expected);
        }
        assert.equal(settlements, 2);

        await assert.rejects(proc.getState(), /shutting down/);
        const exit = await bounded(proc.shutdown(50), "observe crashed Pi exit");
        assert.deepEqual(
          exit,
          kind === "exit" ? { code: 23, signal: null } : { code: null, signal: "SIGTERM" },
        );

        const pid = Number(JSON.parse(readFileSync(recordsPath, "utf8").trim()).pid);
        assert.throws(
          () => process.kill(pid, 0),
          (error: NodeJS.ErrnoException) => error.code === "ESRCH",
        );
      } finally {
        await proc?.shutdown(50);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("a failed child startup is cleaned up and a new-session retry uses a fresh Pi child", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-retry-"));
  const counterPath = join(root, "spawn-count");
  const recordsPath = join(root, "records.jsonl");
  const piCommand = executable(
    root,
    `
const fs = require("node:fs");
const readline = require("node:readline");
const counterPath = ${JSON.stringify(counterPath)};
const recordsPath = ${JSON.stringify(recordsPath)};
const spawnNumber = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) + 1 : 1;
fs.writeFileSync(counterPath, String(spawnNumber));
fs.appendFileSync(recordsPath, JSON.stringify({ type: "spawn", spawnNumber, pid: process.pid }) + "\\n");
if (spawnNumber === 1) {
  setImmediate(() => process.exit(31));
} else {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    let data = {};
    if (request.type === "get_state") data = { sessionId: "retry-session", thinkingLevel: "medium", model: { provider: "test", id: "model" } };
    if (request.type === "get_available_models") data = { models: [{ provider: "test", id: "model", name: "Model" }] };
    if (request.type === "get_commands") data = { commands: [] };
    process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data }) + "\\n");
  });
}
`,
  );
  const client = new FakeAgentSideConnection();
  const agent = new PiAcpAgent(asAgentConn(client), { piCommand });

  try {
    await assert.rejects(
      bounded(agent.newSession({ cwd: root, mcpServers: [] }), "failed first session"),
      /pi process exited|shutting down/,
    );

    const retried = await bounded(
      agent.newSession({ cwd: root, mcpServers: [] }),
      "retry new session",
    );
    assert.equal(retried.sessionId, "retry-session");
    assert.equal(readFileSync(recordsPath, "utf8").trim().split("\n").length, 2);
  } finally {
    await bounded(agent.shutdown(100), "shutdown retry session");
    rmSync(root, { recursive: true, force: true });
  }
});
