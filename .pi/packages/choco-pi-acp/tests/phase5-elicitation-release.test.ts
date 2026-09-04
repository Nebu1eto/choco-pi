import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type AcpConnection, PiAcpSession } from "../src/acp/session.ts";
import { parseJsonLine } from "../src/boundary.ts";
import { PiRpcProcess } from "../src/pi-rpc/process.ts";
import { numberField, recordField, stringField } from "../src/pi-rpc/protocol.ts";

function executable(root: string, source: string): string {
  const path = join(root, "fake-pi");
  writeFileSync(path, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

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
    }, 1_000);
  });
}

test("disconnect releases every real-stdio elicitation awaiting an unresponsive ACP client", async () => {
  const root = mkdtempSync(join(tmpdir(), "choco-pi-phase5-elicitation-release-"));
  const recordsPath = join(root, "records.jsonl");
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let proc: PiRpcProcess | undefined;
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
    proc = await bounded(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable(
          root,
          `
const fs = require("node:fs");
const readline = require("node:readline");
const recordsPath = ${JSON.stringify(recordsPath)};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(recordsPath, JSON.stringify(request) + "\\n");
  if (request.type !== "prompt") return;
  send({ type: "response", id: request.id, command: "prompt", success: true, data: {} });
  send({ type: "extension_ui_request", id: "confirm", method: "confirm", title: "Confirm" });
  send({ type: "extension_ui_request", id: "select", method: "select", title: "Select", options: ["A", "B"] });
  send({ type: "extension_ui_request", id: "input", method: "input", title: "Input" });
});
`,
        ),
      }),
      "spawn elicitation Pi",
    );
    const session = new PiAcpSession({
      sessionId: `phase5-elicitation-release-${randomUUID()}`,
      cwd: root,
      mcpServers: [],
      proc,
      conn,
    });

    const prompt = session.prompt("open dialogs");
    await waitUntil(() => elicitationCount === 3, "observe three pending elicitations");
    assert.equal(extensionUiActive(session), 3);

    await bounded(session.closeExtensionUi(), "release pending elicitations");
    await waitUntil(() => extensionUiActive(session) === 0, "settle released elicitation handlers");
    await waitUntil(() => {
      try {
        return (
          readFileSync(recordsPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseJsonLine(line))
            .filter((record) => stringField(record, "type") === "extension_ui_response").length ===
          3
        );
      } catch {
        return false;
      }
    }, "deliver three cancellation responses");

    await bounded(proc.shutdown(50), "shutdown elicitation Pi");
    assert.equal(await bounded(prompt, "settle elicitation prompt"), "error");
  } finally {
    await proc?.shutdown(50);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
