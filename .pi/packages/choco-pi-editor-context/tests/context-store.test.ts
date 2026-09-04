import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createEditorContextStore } from "../src/context-store.ts";
import {
  BRIDGE_VERSION,
  createLiveSessionClient,
  writeJsonAtomic,
  type LiveSessionState,
} from "../src/live-session-client.ts";
import type { EditorContextDocument } from "../src/protocol.ts";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), "choco-pi-context-workspaces-"));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
const OTHER_WORKSPACE = join(WORKSPACE_ROOT, "another-project");
await Promise.all([mkdir(WORKSPACE), mkdir(OTHER_WORKSPACE)]);
after(() => rm(WORKSPACE_ROOT, { recursive: true, force: true }));

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-context-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridgeDirectory = join(root, "bridge");
  const store = createEditorContextStore({
    bridgeDirectory,
    now: () => NOW,
    pidAlive: () => false,
  });
  return { root, bridgeDirectory, store };
}

function document(overrides: Partial<EditorContextDocument> = {}): EditorContextDocument {
  return {
    version: 1,
    requestId: "request-1",
    editor: { name: "zed" },
    session: { sessionId: "session-1", ownerId: "owner-1", generation: 1 },
    workspace: { root: WORKSPACE },
    buffer: { path: join(WORKSPACE, "src", "example.ts"), language: "TypeScript" },
    cursor: { line: 4, column: 2 },
    capturedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 30_000).toISOString(),
    ...overrides,
  };
}

function consumeOptions() {
  return {
    cwd: WORKSPACE,
    sessionId: "session-1",
    ownerId: "owner-1",
    generation: 1,
  } as const;
}

test("atomic writes use owner-only modes, freshest replacement wins, and consumption removes it", async (t) => {
  const { store } = await fixture(t);
  await store.write(document({ requestId: "request-old", cursor: { line: 1, column: 1 } }));
  const path = await store.write(
    document({ requestId: "request-new", cursor: { line: 9, column: 3 } }),
  );

  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(store.directory)).some((file) => file.endsWith(".tmp")),
    false,
  );

  const result = await store.consume(consumeOptions());
  assert.equal(result.status, "consumed");
  if (result.status !== "consumed") throw new Error("Expected context consumption.");
  assert.equal(result.document.requestId, "request-new");
  assert.deepEqual(result.document.cursor, { line: 9, column: 3 });
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.deepEqual(await store.consume(consumeOptions()), { status: "missing" });
});

test("consume rejects and removes stale, mismatched, oversized, and cross-project documents", async (t) => {
  const { store } = await fixture(t);
  const path = store.contextPath("session-1", "owner-1");
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const cases: Array<[EditorContextDocument, string]> = [
    [document({ expiresAt: new Date(NOW).toISOString() }), "CONTEXT_EXPIRED"],
    [
      document({ session: { sessionId: "session-1", ownerId: "other-owner", generation: 1 } }),
      "OWNER_MISMATCH",
    ],
    [document({ selection: { text: "x".repeat(16 * 1024 + 1) } }), "SELECTION_TEXT_TOO_LARGE"],
    [
      document({
        workspace: { root: OTHER_WORKSPACE },
        buffer: { path: join(OTHER_WORKSPACE, "file.ts") },
      }),
      "WORKSPACE_NOT_APPROVED",
    ],
  ];

  for (const [candidate, expectedCode] of cases) {
    await writeJsonAtomic(path, candidate);
    const result = await store.consume(consumeOptions());
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") throw new Error("Expected context rejection.");
    assert.ok(
      result.diagnostics.some(({ code }) => code === expectedCode),
      expectedCode,
    );
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
});

test("cleanup removes owned crash leftovers while retaining live, unexpired, foreign, and symlink files", async (t) => {
  const { root, bridgeDirectory, store } = await fixture(t);
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const currentClaimed = join(store.directory, "session-1.owner-1.json.123.claim-owner.claimed");
  const currentTemporary = join(store.directory, "session-1.owner-1.json.123.temp-owner.tmp");
  const liveOther = join(store.directory, "session-2.owner-live.json.123.live-owner.claimed");
  const expiredOther = join(store.directory, "session-3.owner-dead.json.123.dead-owner.tmp");
  const unexpiredOther = join(store.directory, "session-4.owner-wait.json.123.wait-owner.tmp");
  const outside = join(root, "outside.json");
  const linked = join(store.directory, "session-5.owner-link.json.123.link-owner.claimed");
  const expired = document({ expiresAt: new Date(NOW - 1).toISOString() });
  const unexpired = document();
  await Promise.all([
    writeFile(currentClaimed, JSON.stringify(unexpired), { mode: 0o600 }),
    writeFile(currentTemporary, JSON.stringify(unexpired), { mode: 0o600 }),
    writeFile(liveOther, JSON.stringify(expired), { mode: 0o600 }),
    writeFile(expiredOther, JSON.stringify(expired), { mode: 0o600 }),
    writeFile(unexpiredOther, JSON.stringify(unexpired), { mode: 0o600 }),
    writeFile(outside, JSON.stringify(expired), { mode: 0o600 }),
  ]);
  await symlink(outside, linked);

  const liveClient = createLiveSessionClient({ bridgeDirectory });
  const liveState: LiveSessionState = {
    version: BRIDGE_VERSION,
    sessionId: "session-2",
    sessionFile: join(root, "session-2.jsonl"),
    cwd: WORKSPACE,
    pid: 99_999,
    ownerId: "owner-live",
    status: "idle",
    updatedAt: new Date(NOW).toISOString(),
  };
  await liveClient.publishLiveState(liveState);

  const result = await store.cleanup({ currentOwnerId: "owner-1" });
  assert.deepEqual(result, { inspected: 6, removed: 3, retainedLive: 1 });
  for (const path of [currentClaimed, currentTemporary, expiredOther]) {
    await assert.rejects(stat(path), { code: "ENOENT" });
  }
  for (const path of [liveOther, unexpiredOther, linked, outside]) {
    assert.ok(await stat(path));
  }
});

test("cleanup never removes a context file it cannot verify as current-user owned", async (t) => {
  const { bridgeDirectory } = await fixture(t);
  const actualStore = createEditorContextStore({ bridgeDirectory, now: () => NOW });
  await actualStore.write(document({ expiresAt: new Date(NOW - 1).toISOString() }));
  const path = actualStore.contextPath("session-1", "owner-1");
  const uid = (await stat(path)).uid;
  const foreignView = createEditorContextStore({
    bridgeDirectory,
    now: () => NOW,
    currentUid: uid + 1,
    pidAlive: () => false,
  });

  assert.deepEqual(await foreignView.cleanup(), { inspected: 1, removed: 0, retainedLive: 0 });
  assert.ok(await stat(path));
});

test("store rejection diagnostics never contain selection text", async (t) => {
  const { store } = await fixture(t);
  const sentinel = "SELECTION-SECRET-SENTINEL";
  await store.write(
    document({
      requestId: "invalid/request",
      selection: { text: sentinel.repeat(1_000) },
    }),
  );

  const result = await store.consume(consumeOptions());
  assert.equal(result.status, "rejected");
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.deepEqual(await readdir(store.directory), []);
});
