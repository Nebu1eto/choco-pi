import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
    mode: "tui",
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

type AliasHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function aliasHandlers(): Map<string, AliasHandler> {
  const handlers = new Map<string, AliasHandler>();
  sessionAliases(
    reinterpretHostValue<ExtensionAPI>({
      registerCommand: (name: string, command: { handler: AliasHandler }) => {
        handlers.set(name, command.handler);
      },
    }),
  );
  return handlers;
}

test("/exit, /clear, and /delete confirm with a notice only outside the TUI", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "choco-pi-alias-rpc-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const handlers = aliasHandlers();
  for (const mode of ["tui", "rpc"] as const) {
    const sessionFile = path.join(directory, `${mode}.jsonl`);
    await writeFile(sessionFile, "session record\n");
    const notices: string[] = [];
    let shutdowns = 0;
    let stale = false;
    const ui = {
      confirm: async () => true,
      notify: (message: string) => notices.push(message),
    };
    const ctx = reinterpretHostValue<ExtensionCommandContext>({
      mode,
      waitForIdle: async () => {},
      get ui() {
        if (stale) throw new Error("stale ctx after session replacement");
        return ui;
      },
      sessionManager: { getSessionFile: () => sessionFile },
      shutdown: () => {
        shutdowns++;
      },
      newSession: async (options?: {
        withSession?: (fresh: ExtensionCommandContext) => Promise<void>;
      }) => {
        stale = true;
        await options?.withSession?.(
          reinterpretHostValue<ExtensionCommandContext>({
            ui: { notify: (message: string) => notices.push(message) },
          }),
        );
        return { cancelled: false };
      },
    });

    await handlers.get("exit")?.("", ctx);
    await handlers.get("clear")?.("", ctx);
    stale = false;
    await handlers.get("delete")?.("", ctx);

    assert.equal(shutdowns, 2);
    await assert.rejects(readFile(sessionFile), { code: "ENOENT" });
    assert.deepEqual(
      notices,
      mode === "tui"
        ? []
        : ["Exiting Pi.", "Started a new session.", "Deleted this session. Exiting Pi."],
    );
  }
});
