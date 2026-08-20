import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionAliases, { deleteSessionRecord } from "../.pi/extensions/session-aliases.ts";

test("deleteSessionRecord permanently removes a persisted session", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-delete-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  await writeFile(sessionFile, "session record\n");

  await deleteSessionRecord(sessionFile);
  await assert.rejects(readFile(sessionFile), { code: "ENOENT" });
});

test("/delete confirms, deletes the session record, and shuts down", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-delete-command-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  await writeFile(sessionFile, "session record\n");
  let deleteHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = reinterpretHostValue<ExtensionAPI>({
    registerCommand: (name: string, command: { handler: typeof deleteHandler }) => {
      if (name === "delete") deleteHandler = command.handler;
    },
  });
  sessionAliases(pi);
  let shutdown = false;

  await deleteHandler?.("", {
    waitForIdle: async () => {},
    ui: { confirm: async () => true, notify: () => assert.fail("unexpected notification") },
    sessionManager: { getSessionFile: () => sessionFile },
    shutdown: () => {
      shutdown = true;
    },
  });

  assert.equal(shutdown, true);
  await assert.rejects(readFile(sessionFile), { code: "ENOENT" });
});

test("/delete leaves the session intact when confirmation is declined", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-delete-cancel-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  await writeFile(sessionFile, "session record\n");
  let deleteHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = reinterpretHostValue<ExtensionAPI>({
    registerCommand: (name: string, command: { handler: typeof deleteHandler }) => {
      if (name === "delete") deleteHandler = command.handler;
    },
  });
  sessionAliases(pi);
  let shutdown = false;

  await deleteHandler?.("", {
    waitForIdle: async () => {},
    ui: { confirm: async () => false },
    sessionManager: { getSessionFile: () => sessionFile },
    shutdown: () => {
      shutdown = true;
    },
  });

  assert.equal(shutdown, false);
  assert.equal(await readFile(sessionFile, "utf8"), "session record\n");
});
