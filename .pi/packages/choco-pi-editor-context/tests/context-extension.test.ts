import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import editorContextExtension, {
  formatRejectedContextDiagnostic,
} from "../src/context-extension.ts";
import type {
  ConsumeEditorContextResult,
  ContextStoreDiagnostic,
  EditorContextStore,
} from "../src/context-store.ts";
import type { LiveSessionClient, LiveSessionState } from "../src/live-session-client.ts";
import type { EditorContextDocument } from "../src/protocol.ts";

type HandlerResult = void | object | Promise<void | object>;
type Handler = (...args: unknown[]) => HandlerResult;

const TEST_ROOT = await mkdtemp(join(tmpdir(), "choco-pi-context-extension-"));
const CWD = join(TEST_ROOT, "project");
await mkdir(CWD);
after(() => rm(TEST_ROOT, { recursive: true, force: true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function document(requestId = "request-1", selectionText = "selected text"): EditorContextDocument {
  const now = Date.now();
  return {
    version: 1,
    requestId,
    editor: { name: "zed" },
    session: { sessionId: "session-1", ownerId: "owner-1", generation: 1 },
    workspace: { root: CWD },
    buffer: { path: join(CWD, "src/example.ts"), relativePath: "src/example.ts" },
    cursor: { line: 4, column: 2 },
    selection: { text: selectionText },
    capturedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 30_000).toISOString(),
  };
}

function liveState(overrides: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    version: 1,
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    cwd: CWD,
    pid: process.pid,
    ownerId: "owner-1",
    status: "idle",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function storeDouble(overrides: Partial<EditorContextStore> = {}): EditorContextStore {
  return {
    directory: "/tmp/editor-context",
    contextPath: (sessionId, ownerId) => `/tmp/editor-context/${sessionId}.${ownerId}.json`,
    write: async () => "/tmp/editor-context/context.json",
    consume: async () => ({ status: "missing" }),
    cleanup: async () => ({ inspected: 0, removed: 0, retainedLive: 0 }),
    removeOwned: async () => undefined,
    ...overrides,
  };
}

function liveClientDouble(overrides: Partial<LiveSessionClient> = {}): LiveSessionClient {
  return {
    bridgeDirectory: "/tmp/bridge",
    liveDirectory: "/tmp/bridge/live",
    liveStatePath: (sessionId, ownerId) => `/tmp/bridge/live/${sessionId}.${ownerId}.json`,
    readLiveState: async () => liveState(),
    listLiveStates: async () => [],
    publishLiveState: async () => undefined,
    removeOwnedLiveState: async () => undefined,
    ...overrides,
  };
}

function context(
  notifications: string[],
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  // SAFETY: Focused tests supply every ExtensionContext member exercised by the extension.
  return {
    cwd: CWD,
    sessionManager: {
      getSessionId: () => "session-1",
    },
    ui: {
      notify: (message: string) => notifications.push(message),
    },
    ...overrides,
  } as ExtensionContext;
}

function harness(store: EditorContextStore, liveClient: LiveSessionClient) {
  const handlers = new Map<string, Handler>();
  // SAFETY: The extension only calls the on registration method supplied by this focused double.
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as ExtensionAPI;
  editorContextExtension(api, { store, liveClient });
  return {
    async emit(event: string, ...args: unknown[]) {
      const handler = handlers.get(event);
      assert.ok(handler, `Missing ${event} handler.`);
      return await handler(...args);
    },
  };
}

test("session start snapshots identity before await and does not touch stale context afterward", async () => {
  const cleanup = deferred<{ inspected: number; removed: number; retainedLive: number }>();
  const store = storeDouble({ cleanup: () => cleanup.promise });
  const extension = harness(store, liveClientDouble());
  let stale = false;
  let accesses = 0;
  const notifications: string[] = [];
  const ctx = context(notifications, {
    get cwd() {
      accesses += 1;
      if (stale) throw new Error("stale cwd accessed");
      return CWD;
    },
    // SAFETY: This test exercises only getSessionId on the session manager.
    sessionManager: {
      getSessionId() {
        accesses += 1;
        if (stale) throw new Error("stale session manager accessed");
        return "session-1";
      },
    } as ExtensionContext["sessionManager"],
  });

  const starting = extension.emit("session_start", {}, ctx);
  stale = true;
  cleanup.resolve({ inspected: 0, removed: 0, retainedLive: 0 });
  await starting;
  assert.equal(accesses, 2);
});

test("before-agent work revalidates generation after live-state and consume awaits", async () => {
  const notifications: string[] = [];
  const pendingLive = deferred<LiveSessionState | undefined>();
  let consumes = 0;
  const store = storeDouble({
    consume: async () => {
      consumes += 1;
      return { status: "consumed", document: document() };
    },
  });
  const extension = harness(store, liveClientDouble({ readLiveState: () => pendingLive.promise }));
  const ctx = context(notifications);
  await extension.emit("session_start", {}, ctx);
  const pendingBefore = extension.emit("before_agent_start", {}, ctx);
  await extension.emit("session_shutdown", {});
  pendingLive.resolve(liveState());
  assert.equal(await pendingBefore, undefined);
  assert.equal(consumes, 0);

  const pendingConsume = deferred<ConsumeEditorContextResult>();
  const consumeStarted = deferred<void>();
  const removed: Array<[string, string]> = [];
  const secondStore = storeDouble({
    consume: () => {
      consumeStarted.resolve();
      return pendingConsume.promise;
    },
    removeOwned: async (sessionId, ownerId) => {
      removed.push([sessionId, ownerId]);
    },
  });
  const second = harness(secondStore, liveClientDouble());
  await second.emit("session_start", {}, ctx);
  const consuming = second.emit("before_agent_start", {}, ctx);
  await consumeStarted.promise;
  await second.emit("session_shutdown", {});
  pendingConsume.resolve({ status: "consumed", document: document() });
  assert.equal(await consuming, undefined);
  assert.deepEqual(removed, [["session-1", "owner-1"]]);
});

test("injects each request only once and passes the last consumed request to the store", async () => {
  const first = document("request-1", "first selection");
  const second = document("request-2", "second selection");
  const results = [first, first, second];
  const lastConsumed: Array<string | undefined> = [];
  const store = storeDouble({
    consume: async (options) => {
      lastConsumed.push(options.lastConsumedRequestId);
      const next = results.shift();
      return next ? { status: "consumed", document: next } : { status: "missing" };
    },
  });
  const extension = harness(store, liveClientDouble());
  const notifications: string[] = [];
  const ctx = context(notifications);
  await extension.emit("session_start", {}, ctx);

  const firstResult = await extension.emit("before_agent_start", {}, ctx);
  const duplicateResult = await extension.emit("before_agent_start", {}, ctx);
  const secondResult = await extension.emit("before_agent_start", {}, ctx);

  assert.match(JSON.stringify(firstResult), /first selection/);
  assert.equal(duplicateResult, undefined);
  assert.match(JSON.stringify(secondResult), /second selection/);
  assert.deepEqual(lastConsumed, [undefined, "request-1", "request-1"]);
  assert.deepEqual(notifications, []);
});

test("passes the real ctx cwd as an additional approved workspace root", async (t) => {
  const realCwd = join(TEST_ROOT, "real-project");
  const linkedCwd = join(TEST_ROOT, "linked-project");
  await mkdir(realCwd);
  await symlink(realCwd, linkedCwd, "dir");
  t.after(() => rm(linkedCwd, { force: true }));
  const approvedRoots: Array<readonly string[] | undefined> = [];
  const store = storeDouble({
    consume: async (options) => {
      approvedRoots.push(options.approvedWorkspaceRoots);
      return { status: "missing" };
    },
  });
  const extension = harness(
    store,
    liveClientDouble({
      readLiveState: async () => liveState({ cwd: realCwd }),
    }),
  );
  const ctx = context([], { cwd: linkedCwd });
  await extension.emit("session_start", {}, ctx);
  await extension.emit("before_agent_start", {}, ctx);

  assert.deepEqual(approvedRoots, [[await realpath(realCwd)]]);
});

test("rejection notification is bounded to diagnostic codes and never echoes selection text", async () => {
  const sentinel = "DO-NOT-ECHO-SELECTION";
  // SAFETY: The runtime boundary may supply extra fields; the formatter must ignore them.
  const maliciousDiagnostic = {
    code: "CONTEXT_READ_FAILED",
    text: sentinel,
  } as ContextStoreDiagnostic;
  const store = storeDouble({
    consume: async () => ({ status: "rejected", diagnostics: [maliciousDiagnostic] }),
  });
  const extension = harness(store, liveClientDouble());
  const notifications: string[] = [];
  const ctx = context(notifications);
  await extension.emit("session_start", {}, ctx);

  assert.equal(await extension.emit("before_agent_start", {}, ctx), undefined);
  assert.deepEqual(notifications, ["Editor context rejected (CONTEXT_READ_FAILED).\n"]);
  assert.equal(
    `${formatRejectedContextDiagnostic([maliciousDiagnostic])}No focused editor context was provided.`,
    "Editor context rejected (CONTEXT_READ_FAILED).\nNo focused editor context was provided.",
  );
  assert.equal(notifications.join("\n").includes(sentinel), false);
});

test("shutdown removes only the file bound to the current live owner", async () => {
  const removed: Array<[string, string]> = [];
  const store = storeDouble({
    removeOwned: async (sessionId, ownerId) => {
      removed.push([sessionId, ownerId]);
    },
  });
  const extension = harness(store, liveClientDouble());
  const ctx = context([]);
  await extension.emit("session_start", {}, ctx);
  assert.equal(await extension.emit("before_agent_start", {}, ctx), undefined);
  await extension.emit("session_shutdown", {});

  assert.deepEqual(removed, [["session-1", "owner-1"]]);
});
