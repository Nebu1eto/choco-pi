import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  type BoundaryValue,
  errorCode,
  isBoundaryRecord,
  isNumber,
  isString,
} from "../src/runtime-values.ts";
import {
  BRIDGE_VERSION,
  canonicalCwdMatches,
  createLiveSessionClient,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  isFresh,
  type LiveSessionState,
  parseLiveState,
  writeJsonAtomic,
} from "../src/live-session-client.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-live-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridgeDirectory = join(root, "bridge");
  return { root, client: createLiveSessionClient({ bridgeDirectory }) };
}

function liveState(overrides: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    version: BRIDGE_VERSION,
    sessionId: "session-1",
    sessionFile: join(tmpdir(), "session-1.jsonl"),
    cwd: tmpdir(),
    pid: 12_345,
    ownerId: "owner-1",
    status: "idle",
    model: "provider/model",
    effort: "high",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("live-state schema accepts valid documents and rejects every invalid field", async (t) => {
  const { client } = await fixture(t);
  const valid = liveState();

  assert.deepEqual(parseLiveState(valid), valid);
  await client.publishLiveState(valid);
  assert.deepEqual(await client.readLiveState(valid.sessionId), valid);

  const invalidDocuments: Array<[name: string, document: object]> = [
    ["version", { ...valid, version: 2 }],
    ["session ID charset", { ...valid, sessionId: "bad/session" }],
    ["relative session file", { ...valid, sessionFile: "session.jsonl" }],
    ["relative cwd", { ...valid, cwd: "project" }],
    ["non-integer pid", { ...valid, pid: 1.5 }],
    ["negative pid", { ...valid, pid: -1 }],
    ["owner ID charset", { ...valid, ownerId: "bad_owner" }],
    ["status", { ...valid, status: "inactive" }],
    ["updatedAt", { ...valid, updatedAt: "not-a-date" }],
    ["model type", { ...valid, model: 42 }],
    ["effort type", { ...valid, effort: 42 }],
    ["effort value", { ...valid, effort: "extreme" }],
  ];
  for (const [name, document] of invalidDocuments) {
    assert.equal(parseLiveState(document), undefined, name);
  }
});

test("freshness constants and inclusive stale boundary remain unchanged", (t) => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 2_000);
  assert.equal(HEARTBEAT_STALE_MS, 6_000);

  const now = Date.parse("2026-01-01T00:00:10.000Z");
  t.mock.method(Date, "now", () => now);
  assert.equal(isFresh(liveState({ updatedAt: new Date(now).toISOString() })), true);
  assert.equal(
    isFresh(liveState({ updatedAt: new Date(now - HEARTBEAT_STALE_MS).toISOString() })),
    true,
  );
  assert.equal(
    isFresh(liveState({ updatedAt: new Date(now - HEARTBEAT_STALE_MS - 1).toISOString() })),
    false,
  );
});

test("owner paths, removal, newest-state selection, and session deduplication", async (t) => {
  const { client } = await fixture(t);
  const now = Date.now();
  const older = liveState({ ownerId: "owner-old", updatedAt: new Date(now - 200).toISOString() });
  const newest = liveState({ ownerId: "owner-new", updatedAt: new Date(now - 100).toISOString() });
  const stale = liveState({
    ownerId: "owner-stale",
    updatedAt: new Date(now - HEARTBEAT_STALE_MS - 1_000).toISOString(),
  });
  const otherSession = liveState({
    sessionId: "session-2",
    ownerId: "owner-other",
    sessionFile: join(tmpdir(), "session-2.jsonl"),
  });

  assert.equal(
    client.liveStatePath("session-1", "owner-new"),
    join(client.liveDirectory, "session-1.owner-new.json"),
  );
  assert.throws(() => client.liveStatePath("bad/session", "owner-new"), /Session ID/);
  assert.throws(() => client.liveStatePath("session-1", "bad_owner"), /owner ID/);

  await Promise.all([
    client.publishLiveState(older),
    client.publishLiveState(newest),
    client.publishLiveState(stale),
    client.publishLiveState(otherSession),
  ]);
  assert.deepEqual(await client.readLiveState("session-1"), newest);

  const states = await client.listLiveStates();
  assert.equal(states.length, 2);
  assert.deepEqual(
    new Map(states.map((state) => [state.sessionId, state.ownerId])),
    new Map([
      ["session-1", "owner-new"],
      ["session-2", "owner-other"],
    ]),
  );

  await client.removeOwnedLiveState("session-1", "owner-new");
  await assert.rejects(stat(client.liveStatePath("session-1", "owner-new")), { code: "ENOENT" });
  assert.equal((await stat(client.liveStatePath("session-1", "owner-old"))).isFile(), true);
});

test("atomic JSON writes preserve modes and never expose partial files", async (t) => {
  const { client } = await fixture(t);
  await client.publishLiveState(liveState());

  assert.equal((await stat(client.liveDirectory)).mode & 0o777, 0o700);
  const statePath = client.liveStatePath("session-1", "owner-1");
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(client.liveDirectory)).some((file) => file.endsWith(".tmp")),
    false,
  );

  const atomicPath = join(client.liveDirectory, "atomic.json");
  const payloadSize = 512 * 1_024;
  let writing = true;
  let reads = 0;
  const reader = (async () => {
    while (writing) {
      try {
        const parsed: BoundaryValue = JSON.parse(await readFile(atomicPath, "utf8"));
        assert.equal(isBoundaryRecord(parsed), true);
        if (!isBoundaryRecord(parsed)) throw new TypeError("Atomic payload is not an object.");
        assert.equal(isNumber(parsed.iteration), true);
        assert.equal(isString(parsed.payload), true);
        if (!isString(parsed.payload)) throw new TypeError("Atomic payload is not a string.");
        assert.equal(parsed.payload.length, payloadSize);
        reads += 1;
      } catch (error) {
        // SAFETY: BoundaryValue represents arbitrary runtime values; errorCode performs the shape check.
        if (errorCode(error as BoundaryValue) !== "ENOENT") throw error;
      }
    }
  })();
  try {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      await writeJsonAtomic(atomicPath, {
        iteration,
        payload: (iteration % 2 === 0 ? "a" : "b").repeat(payloadSize),
      });
    }
  } finally {
    writing = false;
  }
  await reader;

  assert.ok(reads > 0);
  assert.equal((await stat(atomicPath)).mode & 0o777, 0o600);
  assert.equal(
    (await readdir(client.liveDirectory)).some((file) => file.endsWith(".tmp")),
    false,
  );
});

test("canonical cwd matching compares exact roots, not descendants", async (t) => {
  const { root } = await fixture(t);
  const project = join(root, "project");
  const sibling = join(root, "project2");
  const subdirectory = join(project, "src");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(sibling, { recursive: true }),
    mkdir(subdirectory, { recursive: true }),
  ]);

  assert.equal(await canonicalCwdMatches(project, project), true);
  assert.equal(await canonicalCwdMatches(`${project}${sep}`, join(project, ".")), true);
  assert.equal(await canonicalCwdMatches(join(project, "src", ".."), project), true);
  assert.equal(await canonicalCwdMatches(project, sibling), false);
  // Workspace matching is exact-root matching: a descendant is not the same workspace root.
  assert.equal(await canonicalCwdMatches(project, subdirectory), false);
  assert.equal(await canonicalCwdMatches(project, join(root, "missing")), false);
  assert.equal(
    await canonicalCwdMatches(join(root, "missing-left"), join(root, "missing-right")),
    false,
  );
});

test("canonical cwd matching resolves symlinks in either direction", async (t) => {
  const { root } = await fixture(t);
  const project = join(root, "project");
  const linkedProject = join(root, "linked-project");
  await mkdir(project);
  await symlink(project, linkedProject, "dir");

  assert.equal(await canonicalCwdMatches(linkedProject, project), true);
  assert.equal(await canonicalCwdMatches(project, linkedProject), true);
});

test("listLiveStates retains distinct sessions sharing one cwd", async (t) => {
  const { client, root } = await fixture(t);
  const cwd = join(root, "project");
  await mkdir(cwd);
  await Promise.all([
    client.publishLiveState(liveState({ sessionId: "session-a", ownerId: "owner-a", cwd })),
    client.publishLiveState(liveState({ sessionId: "session-b", ownerId: "owner-b", cwd })),
  ]);

  const states = await client.listLiveStates();
  assert.deepEqual(
    new Set(states.map(({ sessionId, ownerId }) => `${sessionId}:${ownerId}`)),
    new Set(["session-a:owner-a", "session-b:owner-b"]),
  );
});
