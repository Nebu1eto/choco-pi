import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHookWatchers } from "../src/index.ts";
import type { HookSource, MergedHookResult } from "../src/index.ts";
import type { RuntimeValue } from "../src/validation.ts";

const STALE_CONTEXT_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

interface PendingDispatch {
  event: string;
  promise: Promise<MergedHookResult>;
  resolve(result: MergedHookResult): void;
  reject(error: Error): void;
}

interface WatcherUiDouble {
  notify(message?: string, level?: string): void;
}

interface WatcherContextDouble {
  readonly hasUI: boolean;
  readonly ui: WatcherUiDouble;
}

function extensionContext(value: WatcherContextDouble): ExtensionContext {
  // SAFETY: Each focused watcher test supplies every ExtensionContext member exercised by the watcher.
  return value as ExtensionContext;
}

function pendingDispatch(event: string): PendingDispatch {
  let resolve!: (result: MergedHookResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<MergedHookResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { event, promise, resolve, reject };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for watcher callback");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emptyResult(): MergedHookResult {
  return {
    invocations: [],
    blocked: false,
    continue: true,
    systemMessages: [],
    terminalSequences: [],
    additionalContext: [],
  };
}

test("FileChanged and ConfigChange fire from actual filesystem changes", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-watch-"));
  fs.mkdirSync(path.join(cwd, ".claude"));
  fs.writeFileSync(path.join(cwd, ".env"), "A=0\n");
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), '{"initial":true}\n');
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source: HookSource = {
    id: "project",
    kind: "project",
    hooks: { FileChanged: [{ matcher: ".env", hooks: [] }] },
  };
  const events: string[] = [];
  // SAFETY: Watcher uses hasUI and ui.notify only; hasUI false prevents the latter.
  const ctx = extensionContext({ hasUI: false, ui: { notify() {} } });
  const watcher = createHookWatchers({
    cwd,
    ctx,
    sources: [source],
    dispatch: async (event) => {
      events.push(event);
      return emptyResult();
    },
    onAllowedConfigChange: () => undefined,
  });
  t.after(() => watcher.dispose());
  let revision = 0;
  await waitFor(() => {
    if (events.includes("FileChanged") && events.includes("ConfigChange")) return true;
    revision += 1;
    fs.writeFileSync(path.join(cwd, ".env"), `A=${revision}\n`);
    fs.writeFileSync(
      path.join(cwd, ".claude", "settings.json"),
      `${JSON.stringify({ revision })}\n`,
    );
    return false;
  });
  assert.ok(events.includes("FileChanged"));
  assert.ok(events.includes("ConfigChange"));
});

test("disposed watcher drops ConfigChange and FileChanged continuations", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-watch-dispose-"));
  fs.mkdirSync(path.join(cwd, ".claude"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source: HookSource = {
    id: "project",
    kind: "project",
    hooks: { FileChanged: [{ matcher: ".env", hooks: [] }] },
  };
  const pending: PendingDispatch[] = [];
  let stale = false;
  let contextAccesses = 0;
  let reloads = 0;
  // SAFETY: This focused watcher double exposes only the UI properties read by continuations.
  const ctx = extensionContext({
    get hasUI() {
      contextAccesses += 1;
      if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
      return true;
    },
    get ui() {
      contextAccesses += 1;
      if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
      return { notify() {} };
    },
  });
  const watcher = createHookWatchers({
    cwd,
    ctx,
    sources: [source],
    dispatch: (event) => {
      const held = pendingDispatch(event);
      pending.push(held);
      return held.promise;
    },
    onAllowedConfigChange: () => {
      reloads += 1;
    },
  });
  t.after(() => watcher.dispose());

  fs.writeFileSync(path.join(cwd, ".env"), "A=1\n");
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}\n");
  await waitFor(
    () =>
      pending.some(({ event }) => event === "FileChanged") &&
      pending.some(({ event }) => event === "ConfigChange"),
  );

  watcher.dispose();
  stale = true;
  const unhandled: RuntimeValue[] = [];
  const onUnhandled = (reason: RuntimeValue) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  for (const held of pending) {
    held.resolve({
      ...emptyResult(),
      systemMessages: ["must not notify"],
      watchPaths: [path.join(cwd, "ignored")],
    });
  }
  await Promise.all(pending.map(({ promise }) => promise));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(contextAccesses, 0);
  assert.equal(reloads, 0);
  assert.deepEqual(unhandled, []);
});

test("disposed watcher handles the canonical stale-context rejection", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-watch-stale-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const pending: PendingDispatch[] = [];
  const watcher = createHookWatchers({
    cwd,
    ctx: extensionContext({ hasUI: false, ui: { notify() {} } }),
    sources: [
      { id: "project", kind: "project", hooks: { FileChanged: [{ matcher: ".env", hooks: [] }] } },
    ],
    dispatch: (event) => {
      const held = pendingDispatch(event);
      pending.push(held);
      return held.promise;
    },
    onAllowedConfigChange: () => undefined,
  });
  t.after(() => watcher.dispose());
  fs.writeFileSync(path.join(cwd, ".env"), "A=1\n");
  await waitFor(() => pending.some(({ event }) => event === "FileChanged"));
  watcher.dispose();

  const unhandled: RuntimeValue[] = [];
  const onUnhandled = (reason: RuntimeValue) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  for (const held of pending) held.reject(new Error(STALE_CONTEXT_MESSAGE));
  await Promise.all(pending.map(({ promise }) => promise.catch(() => emptyResult())));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(unhandled, []);
});
