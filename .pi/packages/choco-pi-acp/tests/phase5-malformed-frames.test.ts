import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isBoundaryRecord, parseJsonLine, type BoundaryValue } from "../src/boundary.ts";
import { type AcpConnection, PiAcpSession } from "../src/acp/session.ts";
import {
  PI_RPC_PRELUDE_MAX_BYTES,
  PI_RPC_PRELUDE_MAX_LINES,
  PiRpcProcess,
} from "../src/pi-rpc/process.ts";
import { numberField, recordField, stringField } from "../src/pi-rpc/protocol.ts";

const TEST_TIMEOUT_MS = 5_000;

/**
 * Read the session's in-flight extension-UI handler count.
 *
 * The counter is private to `PiAcpSession` and has no public accessor, so this
 * test reads it as an undecoded boundary record rather than asserting a shape.
 */
function extensionUiActive(session: PiAcpSession): number {
  const state = recordField(session, "extensionUiTaskState");
  const active = state === undefined ? undefined : numberField(state, "active");
  assert.ok(active !== undefined, "PiAcpSession tracks active extension UI handlers");
  return active;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), TEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const interval = setInterval(() => {
      if (!predicate()) return;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve();
    }, 5);
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`timed out: ${label}`));
    }, TEST_TIMEOUT_MS);
  });
}

function executable(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function spawnAdapter(root: string, name: string): ChildProcessWithoutNullStreams {
  const home = join(root, `${name}-home`);
  mkdirSync(home);
  return spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "choco-pi-acp.ts")], {
    cwd: root,
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
}

function collectOutput(child: NodeJS.ReadableStream) {
  let output = "";
  child.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return { read: () => output };
}

function waitForJsonLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (message: BoundaryValue) => boolean,
): Promise<BoundaryValue> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = parseJsonLine(line);
        if (message === undefined) {
          cleanup();
          reject(new Error("adapter wrote non-JSON stdout"));
          return;
        }
        if (!predicate(message)) continue;
        cleanup();
        resolve(message);
        return;
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`adapter exited before response (code=${code}, signal=${signal})`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

function childExit(
  child: ChildProcessWithoutNullStreams,
): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
  });
}

async function cleanupChild(child: ChildProcessWithoutNullStreams, label: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await bounded(childExit(child), label);
}

function field(value: BoundaryValue, key: string): BoundaryValue {
  return isBoundaryRecord(value) ? value[key] : undefined;
}

async function initializeAdapter(
  child: ChildProcessWithoutNullStreams,
  id: string,
): Promise<BoundaryValue> {
  const response = waitForJsonLine(child, (message) => stringField(message, "id") === id);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    })}\n`,
  );
  return bounded(response, `ACP initialize ${id}`);
}

test("malformed ACP input returns a redacted parse error and isolates the affected real CLI connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-acp-frame-"));
  const sentinel = join(root, "must-not-exist");
  const secret = "PRIVATE_EDITOR_SELECTION_MALFORMED";
  const malformed = `${secret}; require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed")`;
  const affected = spawnAdapter(root, "affected");
  const healthy = spawnAdapter(root, "healthy");
  const affectedStdout = collectOutput(affected.stdout);
  const affectedStderr = collectOutput(affected.stderr);

  try {
    const errorResponse = waitForJsonLine(affected, (message) => {
      const error = recordField(message, "error");
      return field(message, "id") === null && numberField(error, "code") === -32700;
    });
    affected.stdin.write(`${malformed}\n`);

    const response = await bounded(errorResponse, "malformed ACP parse error");
    const error = recordField(response, "error");
    const data = recordField(error, "data");
    assert.equal(stringField(response, "jsonrpc"), "2.0");
    assert.equal(stringField(error, "message"), "Parse error");
    assert.equal(stringField(data, "reason"), "malformed_json");
    assert.equal(existsSync(sentinel), false);

    const [code, signal] = await bounded(childExit(affected), "affected adapter exit");
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.doesNotMatch(affectedStdout.read(), new RegExp(secret));
    assert.doesNotMatch(affectedStderr.read(), new RegExp(secret));
    assert.match(affectedStderr.read(), /malformed_json \(bytes=\d+, max=1048576\)/);

    const healthyResponse = await initializeAdapter(healthy, `healthy-${randomUUID()}`);
    assert.equal(numberField(recordField(healthyResponse, "result"), "protocolVersion"), 1);
    healthy.stdin.end();
    assert.deepEqual(await bounded(childExit(healthy), "healthy adapter exit"), [0, null]);
  } finally {
    await cleanupChild(affected, "affected adapter cleanup");
    await cleanupChild(healthy, "healthy adapter cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized ACP frame returns a redacted parse error and terminates the real CLI connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-acp-large-frame-"));
  const affected = spawnAdapter(root, "oversized");
  const stdout = collectOutput(affected.stdout);
  const stderr = collectOutput(affected.stderr);
  const secret = "PRIVATE_EDITOR_SELECTION_OVERSIZED";
  const oversized = `${secret}${"x".repeat(1_100_000)}`;

  try {
    const errorResponse = waitForJsonLine(affected, (message) => {
      const error = recordField(message, "error");
      const data = recordField(error, "data");
      return field(message, "id") === null && stringField(data, "reason") === "frame_too_large";
    });
    affected.stdin.write(`${oversized}\n`);

    const response = await bounded(errorResponse, "oversized ACP parse error");
    const error = recordField(response, "error");
    const data = recordField(error, "data");
    const byteLength = numberField(data, "byteLength");
    const maxFrameBytes = numberField(data, "maxFrameBytes");
    assert.equal(numberField(error, "code"), -32700);
    assert.equal(stringField(error, "message"), "Parse error");
    assert.equal(maxFrameBytes, 1_048_576);
    assert.ok(byteLength !== undefined && maxFrameBytes !== undefined);
    assert.ok(byteLength > maxFrameBytes);
    assert.deepEqual(await bounded(childExit(affected), "oversized adapter exit"), [1, null]);
    assert.doesNotMatch(stdout.read(), new RegExp(secret));
    assert.doesNotMatch(stderr.read(), new RegExp(secret));
    assert.match(stderr.read(), /frame_too_large \(bytes=\d+, max=1048576\)/);
  } finally {
    await cleanupChild(affected, "oversized adapter cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi keeps a bounded non-JSON prelude before the first valid real-stdio RPC frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-pi-prelude-"));
  const sentinel = join(root, "must-not-exist");
  const maliciousLine = `not-json; require("node:fs").writeFileSync(${JSON.stringify(
    sentinel,
  )}, "executed")`;
  const piCommand = executable(
    root,
    "prelude-pi",
    `
const readline = require("node:readline");
process.stdout.write(${JSON.stringify(maliciousLine)} + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "safe" } }) + "\\n");
});
`,
  );
  let proc: PiRpcProcess | undefined;

  try {
    proc = await bounded(PiRpcProcess.spawn({ cwd: root, piCommand }), "spawn prelude Pi");
    const response = await bounded(proc.getState(), "Pi response after prelude");
    assert.equal(response.sessionId, "safe");
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(proc.consumePreludeLines(), {
      lines: [maliciousLine],
      truncated: false,
    });
  } finally {
    if (proc) await bounded(proc.shutdown(100), "shutdown prelude Pi");
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi prelude byte truncation retains a true prefix and rejects all later lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-pi-prelude-bounds-"));
  const ready = join(root, "ready");
  const piCommand = executable(
    root,
    "no-json-pi",
    `
const fs = require("node:fs");
for (let index = 0; index < 20; index += 1) process.stdout.write("x".repeat(10_000) + "\\n");
for (let index = 0; index < 400; index += 1) process.stdout.write("line-" + index + "\\n");
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1_000);
`,
  );
  let proc: PiRpcProcess | undefined;

  try {
    proc = await bounded(PiRpcProcess.spawn({ cwd: root, piCommand }), "spawn no-JSON Pi");
    await waitUntil(() => existsSync(ready), "no-JSON Pi emitted prelude");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const retained = proc.consumePreludeLines();
    assert.equal(retained.truncated, true);
    assert.deepEqual(
      retained.lines,
      Array.from({ length: 6 }, () => "x".repeat(10_000)),
    );
    assert.equal(
      retained.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line, "utf8"), 0),
      60_000,
    );
    assert.ok(60_000 <= PI_RPC_PRELUDE_MAX_BYTES);
    assert.ok(70_000 > PI_RPC_PRELUDE_MAX_BYTES);
  } finally {
    if (proc) await bounded(proc.shutdown(100), "shutdown no-JSON Pi");
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi prelude line truncation retains a true prefix and rejects all later lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-pi-prelude-lines-"));
  const ready = join(root, "ready");
  const piCommand = executable(
    root,
    "line-cap-pi",
    `
const fs = require("node:fs");
for (let index = 0; index < ${PI_RPC_PRELUDE_MAX_LINES}; index += 1) process.stdout.write("line-" + index + "\\n");
process.stdout.write("over-line-cap\\n");
process.stdout.write("later-short-line\\n");
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1_000);
`,
  );
  let proc: PiRpcProcess | undefined;

  try {
    proc = await bounded(PiRpcProcess.spawn({ cwd: root, piCommand }), "spawn line-cap Pi");
    await waitUntil(() => existsSync(ready), "line-cap Pi emitted prelude");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(proc.consumePreludeLines(), {
      lines: Array.from({ length: PI_RPC_PRELUDE_MAX_LINES }, (_, index) => `line-${index}`),
      truncated: true,
    });
  } finally {
    if (proc) await bounded(proc.shutdown(100), "shutdown line-cap Pi");
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed Pi RPC after JSON starts settles its session and dialogs while a healthy session survives", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-pi-malformed-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const sentinel = join(root, "must-not-exist");
  const maliciousLine = `not-json; require("node:fs").writeFileSync(${JSON.stringify(
    sentinel,
  )}, "executed")`;
  let affectedProc: PiRpcProcess | undefined;
  let healthyProc: PiRpcProcess | undefined;
  let elicitationCount = 0;
  const conn: AcpConnection = {
    async sessionUpdate() {},
    unstable_createElicitation() {
      elicitationCount += 1;
      return new Promise<never>(() => {});
    },
    requestPermission() {
      return new Promise<never>(() => {});
    },
  };

  try {
    affectedProc = await bounded(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable(
          root,
          "affected-pi",
          `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
send({ type: "ready" });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "prompt") {
    send({ type: "response", id: request.id, command: "prompt", success: true, data: {} });
    send({ type: "agent_start" });
    send({ type: "extension_ui_request", id: "pending-input", method: "input", title: "Input" });
    return;
  }
  if (request.type === "get_state") process.stdout.write(${JSON.stringify(maliciousLine)} + "\\n");
});
`,
        ),
      }),
      "spawn affected Pi",
    );
    healthyProc = await bounded(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable(
          root,
          "healthy-pi",
          `
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  send({ type: "response", id: request.id, command: "prompt", success: true, data: {} });
  send({ type: "agent_start" });
  send({ type: "agent_settled" });
});
`,
        ),
      }),
      "spawn healthy Pi",
    );

    const affectedSession = new PiAcpSession({
      sessionId: `phase5-malformed-affected-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc: affectedProc,
      conn,
    });
    const healthySession = new PiAcpSession({
      sessionId: `phase5-malformed-healthy-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc: healthyProc,
      conn,
    });

    assert.equal(
      await bounded(healthySession.prompt("before"), "healthy prompt before"),
      "end_turn",
    );
    const active = affectedSession.prompt("active");
    const queued = affectedSession.prompt("queued");
    await waitUntil(() => elicitationCount === 1, "affected session opened dialog");
    assert.equal(extensionUiActive(affectedSession), 1);

    await assert.rejects(
      bounded(affectedProc.getState(), "malformed Pi RPC rejection"),
      /Malformed Pi RPC stdout frame after protocol start \(bytes=\d+\)/,
    );
    assert.deepEqual(await bounded(Promise.all([active, queued]), "settle malformed Pi turns"), [
      "error",
      "error",
    ]);
    await bounded(affectedProc.exited, "affected Pi exit");
    await waitUntil(
      () => extensionUiActive(affectedSession) === 0,
      "affected session released dialog",
    );
    assert.equal(existsSync(sentinel), false);

    assert.equal(await bounded(healthySession.prompt("after"), "healthy prompt after"), "end_turn");
  } finally {
    if (affectedProc) await bounded(affectedProc.shutdown(100), "shutdown affected Pi");
    if (healthyProc) await bounded(healthyProc.shutdown(100), "shutdown healthy Pi");
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
