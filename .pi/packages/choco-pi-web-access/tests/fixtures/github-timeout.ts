#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { mock } from "node:test";

const mode = process.argv[2];

function notifyRunner(message: string): void {
  const readyPort = process.env.CLONE_READY_PORT;
  assert.ok(readyPort);
  const socket = createConnection({ host: "127.0.0.1", port: Number(readyPort) });
  socket.once("connect", () => socket.end(message));
}

if (mode === "runner") {
  const { Type } = await import("typebox");
  const { Value } = await import("typebox/value");
  const TcpAddress = Type.Object({
    address: Type.String(),
    family: Type.String(),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
  });
  const { extractGitHub } = await import("../../github-extract.ts");
  const server = createServer();
  let markReady = () => {};
  let markResistant = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const resistant = new Promise<void>((resolve) => {
    markResistant = resolve;
  });
  const acknowledgements = new Set<string>();
  server.on("connection", (socket) => {
    let message = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      message += chunk;
    });
    socket.once("end", () => {
      if (message === "ready") markReady();
      else {
        assert.ok(message === "root" || message === "helper");
        acknowledgements.add(message);
        if (acknowledgements.size === 2) markResistant();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(Value.Check(TcpAddress, address));
  process.env.CLONE_READY_PORT = String(address.port);

  // Keep the configured 500 ms deadline, but start advancing time only after
  // both fake processes resist SIGTERM and the helper has flushed its PID file.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const extraction = extractGitHub("https://github.com/test/repo");
    await ready;
    mock.timers.tick(500);
    // Both handlers must actually receive and survive SIGTERM before escalation.
    await resistant;
    mock.timers.tick(3000);
    console.log(JSON.stringify(await extraction));
  } finally {
    mock.timers.reset();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
} else if (mode === "helper") {
  const pidFile = process.env.CLONE_PROCESS_PID_FILE;
  assert.ok(pidFile);
  process.on("SIGTERM", () => notifyRunner("helper"));
  await writeFile(pidFile, JSON.stringify({ rootPid: process.ppid, helperPid: process.pid }));
  notifyRunner("ready");
  // The open interval models a stuck credential helper without polling readiness.
  setInterval(() => {}, 1000);
} else {
  assert.equal(mode, "clone");
  process.on("SIGTERM", () => notifyRunner("root"));
  spawn(process.execPath, [import.meta.filename, "helper"], { stdio: "ignore" });
  setInterval(() => {}, 1000);
}
