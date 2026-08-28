import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { enqueueSessionDelivery } from "../.pi/extensions/lib/session-communication.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type {
  ExecRunner,
  ResolvedReviewConfig,
  ReviewRecord,
  ReviewStore,
} from "../.pi/extensions/review/core/types.ts";
import {
  registerReviewExtension,
  type ReviewExtensionDependencies,
} from "../.pi/extensions/review/index.ts";
import type { ReviewViewResult } from "../.pi/extensions/review/ui/review-view.ts";

const STALE_CONTEXT_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use the old owner.";
const root = "/work/lifecycle";
const sessionId = "lifecycle-session";
const patch = [
  "diff --git a/value.ts b/value.ts",
  "--- a/value.ts",
  "+++ b/value.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");
const config: ResolvedReviewConfig = {
  editor: { command: ["true"], mode: "gui" },
  highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
  heuristics: { riskPatterns: [], collapsePatterns: [] },
};

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function checkpointEntries(): RuntimeValue[] {
  const checkpoint = (id: string, turnIndex: number, tree: string) => ({
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: "choco-pi:file-checkpoint",
    data: {
      version: 1,
      ref: `refs/choco-pi/checkpoints/${id}`,
      indexTree: tree,
      worktreeTree: tree,
      timestamp: "2026-01-01T00:00:00.000Z",
      turnIndex,
      label: `Turn ${turnIndex}`,
    },
  });
  const user = (id: string) => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: id, timestamp: 1 },
  });
  return [
    checkpoint("checkpoint-1", 1, "tree-1"),
    user("user-1"),
    checkpoint("checkpoint-2", 2, "tree-2"),
    user("user-2"),
  ];
}

function context(waitForIdle: () => Promise<void> = async () => undefined) {
  let stale = false;
  let accesses = 0;
  const notifications: string[] = [];
  const widgets: Array<string | undefined> = [];
  const read = <Value>(value: Value): Value => {
    accesses += 1;
    if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
    return value;
  };
  const ui = {
    theme: { fg: (_color: string, text: string) => text, inverse: (text: string) => text },
    notify: (message: string) => notifications.push(message),
    setWidget: (_key: string, value?: string[]) => widgets.push(value?.[0]),
  };
  const sessionManager = {
    getSessionId: () => sessionId,
    getBranch: () => checkpointEntries(),
  };
  // SAFETY: The fixture defines every command-context property exercised by the review extension.
  const fixture = Object.create(null) as ExtensionCommandContext;
  Object.defineProperties(fixture, {
    cwd: { get: () => read(root) },
    mode: { get: () => read("tui") },
    hasUI: { get: () => read(true) },
    ui: { get: () => read(ui) },
    sessionManager: { get: () => read(sessionManager) },
    waitForIdle: { get: () => read(waitForIdle) },
    model: { get: () => read(undefined) },
    thinkingLevel: { get: () => read(undefined) },
    modelRegistry: { get: () => read({ getAvailable: () => [] }) },
  });
  return {
    ctx: fixture,
    notifications,
    widgets,
    markStale() {
      stale = true;
    },
    accessCount() {
      return accesses;
    },
  };
}

function runner(): ExecRunner {
  return async (_command, args) => {
    if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
    if (args.includes("diff")) return { stdout: patch, stderr: "", code: 0 };
    throw new Error(`Unexpected runner arguments: ${args.join(" ")}`);
  };
}

function store(): ReviewStore {
  return { load: async () => undefined, save: async () => undefined, list: async () => [] };
}

function activate(dependencies: Partial<ReviewExtensionDependencies> = {}) {
  const handlers = new Map<
    string,
    (event: RuntimeValue, ctx: ExtensionCommandContext) => RuntimeValue
  >();
  let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
  const appended: RuntimeValue[] = [];
  const pi = reinterpretHostValue<ExtensionAPI>({
    on(
      event: string,
      handler: (event: RuntimeValue, ctx: ExtensionCommandContext) => RuntimeValue,
    ) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, registered: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      command = registered;
    },
    appendEntry(_type: string, value: RuntimeValue) {
      appended.push(value);
    },
  });
  registerReviewExtension(pi, {
    runner: runner(),
    store: store(),
    loadConfig: async () => config,
    openView: async () => undefined,
    now: () => "2026-01-01T00:00:00.000Z",
    ...dependencies,
  });
  assert.ok(command);
  return { command, handlers, appended };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("reload during awaited review work rejects the old context and UI owner", async () => {
  const idle = deferred<void>();
  let views = 0;
  const extension = activate({
    openView: async () => {
      views += 1;
      return undefined;
    },
  });
  const oldOwner = context(() => idle.promise);
  const pending = extension.command.handler("session", oldOwner.ctx);
  await settle();

  extension.handlers.get("session_start")?.({}, context().ctx);
  oldOwner.markStale();
  const before = oldOwner.accessCount();
  idle.resolve();

  await pending;
  assert.equal(oldOwner.accessCount(), before);
  assert.equal(views, 0);
  assert.deepEqual(oldOwner.widgets, []);
  assert.deepEqual(oldOwner.notifications, []);
});

test("session shutdown contains canonical stale rejection but propagates unrelated failure", async (t) => {
  for (const [name, error, contained] of [
    ["canonical", new Error(STALE_CONTEXT_MESSAGE), true],
    ["unrelated", new Error("repository lookup failed"), false],
  ] as const) {
    await t.test(name, async () => {
      const lookup = deferred<{ stdout: string; stderr: string; code: number }>();
      const extension = activate({ runner: async () => lookup.promise });
      const oldOwner = context();
      const pending = extension.command.handler("session", oldOwner.ctx);
      await settle();
      extension.handlers.get("session_shutdown")?.({}, context().ctx);
      oldOwner.markStale();
      const before = oldOwner.accessCount();
      lookup.reject(error);
      if (contained) await assert.doesNotReject(pending);
      else await assert.rejects(pending, (failure) => failure === error);
      assert.equal(oldOwner.accessCount(), before);
    });
  }
});

test("review cancellation before completion is ignored; completion before shutdown persists once", async (t) => {
  await t.test("cancelled by owner replacement", async () => {
    const view = deferred<ReviewViewResult | undefined>();
    const entered = deferred<void>();
    const extension = activate({
      openView: () => {
        entered.resolve();
        return view.promise;
      },
    });
    const oldOwner = context();
    const pending = extension.command.handler("session turn 1", oldOwner.ctx);
    await entered.promise;
    extension.handlers.get("session_start")?.({}, context().ctx);
    oldOwner.markStale();
    const before = oldOwner.accessCount();
    view.resolve(undefined);
    await pending;
    assert.equal(oldOwner.accessCount(), before);
    assert.equal(extension.appended.length, 0);
  });

  await t.test("completed before shutdown", async () => {
    let resultRecord: ReviewRecord | undefined;
    const extension = activate({
      openView: async (options) => {
        resultRecord = options.record;
        return { action: "save", record: options.record };
      },
    });
    const owner = context();
    await extension.command.handler("session turn 1", owner.ctx);
    assert.ok(resultRecord);
    assert.equal(extension.appended.length, 1);
    extension.handlers.get("session_shutdown")?.({}, context().ctx);
    assert.equal(extension.appended.length, 1);
  });
});

test("accepted asynchronous delivery survives rejection and does not block the next delivery", async () => {
  const first = deferred<void>();
  const queue = { deliveryChain: Promise.resolve() };
  let starts = 0;
  enqueueSessionDelivery(queue, () => {
    starts += 1;
    return first.promise;
  });
  assert.equal(starts, 0, "acceptance returns before delivery starts");
  await Promise.resolve();
  assert.equal(starts, 1);

  first.reject(new Error("receiver rejected after acceptance"));
  await queue.deliveryChain;
  enqueueSessionDelivery(queue, async () => {
    starts += 1;
  });
  await queue.deliveryChain;
  assert.equal(starts, 2);
});
