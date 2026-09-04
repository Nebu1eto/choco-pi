import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { after } from "node:test";

import { runEditorContextCli } from "../src/cli.ts";
import { createEditorContextStore, type EditorContextStore } from "../src/context-store.ts";
import {
  canonicalizeCwd,
  createContextTargetStore,
  type ContextTargetStore,
  type PersistedContextTarget,
} from "../src/context-target.ts";
import {
  createLiveSessionClient,
  type LiveSessionClient,
  type LiveSessionState,
} from "../src/live-session-client.ts";
import type { EditorContextDocument } from "../src/protocol.ts";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const TEST_ROOT = await mkdtemp(join(tmpdir(), "choco-pi-cli-"));
const CWD = join(TEST_ROOT, "project");
await mkdir(CWD);
after(() => rm(TEST_ROOT, { recursive: true, force: true }));

function state(overrides: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    version: 1,
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    cwd: CWD,
    pid: 123,
    ownerId: "owner-1",
    status: "idle",
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function liveClient(overrides: Partial<LiveSessionClient> = {}): LiveSessionClient {
  return {
    bridgeDirectory: "/tmp/bridge",
    liveDirectory: "/tmp/bridge/live",
    liveStatePath: (sessionId, ownerId) => `/tmp/${sessionId}.${ownerId}.json`,
    readLiveState: async () => state(),
    listLiveStates: async () => [],
    publishLiveState: async () => undefined,
    removeOwnedLiveState: async () => undefined,
    ...overrides,
  };
}

function store(writes: EditorContextDocument[]): EditorContextStore {
  return {
    directory: "/tmp/editor-context",
    contextPath: (sessionId, ownerId) => `/tmp/${sessionId}.${ownerId}.json`,
    write: async (document) => {
      writes.push(document);
      return "/tmp/context.json";
    },
    consume: async () => ({ status: "missing" }),
    cleanup: async () => ({ inspected: 0, removed: 0, retainedLive: 0 }),
    removeOwned: async () => undefined,
  };
}

function memoryTargetStore(initial?: PersistedContextTarget) {
  let target = initial;
  const cleared: string[] = [];
  return {
    cleared,
    store: {
      directory: "/tmp/bridge/editor-context/targets",
      targetPath: async () => "/tmp/target.json",
      read: async () => target,
      write: async (cwd, sessionId, ownerId) => {
        target = {
          version: 1,
          sessionId,
          ownerId,
          cwd,
          recordedAt: new Date(NOW).toISOString(),
        };
        return "/tmp/target.json";
      },
      clear: async (cwd) => {
        cleared.push(cwd);
        target = undefined;
      },
    } satisfies ContextTargetStore,
  };
}

function target(sessionId: string, ownerId: string): PersistedContextTarget {
  return {
    version: 1,
    sessionId,
    ownerId,
    cwd: CWD,
    recordedAt: new Date(NOW).toISOString(),
  };
}

test("publish dry-run validates live ownership and selection without writing or echoing text", async () => {
  const sentinel = "PRIVATE-SELECTION-CONTENT";
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const exitCode = await runEditorContextCli(
    [
      "publish",
      "--session-id",
      "session-1",
      "--owner-id",
      "owner-1",
      "--cwd",
      CWD,
      "--path",
      `${CWD}/src/example.ts`,
      "--line",
      "7",
      "--column",
      "3",
      "--symbol",
      "Example.run",
      "--language",
      "TypeScript",
      "--selection-file",
      "/tmp/selection.txt",
      "--dry-run",
    ],
    {
      liveClient: liveClient(),
      store: store(writes),
      now: () => NOW,
      readSelectionFile: async () => sentinel,
      output: (line) => output.push(line),
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(output, ["Dry run: editor context is valid; no file written."]);
  assert.equal(output.join("\n").includes(sentinel), false);
});

test("publish writes the validated current-session document", async () => {
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const exitCode = await runEditorContextCli(
    [
      "publish",
      "--session-id",
      "session-1",
      "--owner-id",
      "owner-1",
      "--cwd",
      CWD,
      "--path",
      `${CWD}/src/example.ts`,
    ],
    {
      liveClient: liveClient(),
      store: store(writes),
      now: () => NOW,
      output: (line) => output.push(line),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]?.session, {
    sessionId: "session-1",
    ownerId: "owner-1",
    generation: 1,
  });
  assert.equal(writes[0]?.workspace.root, CWD);
  assert.equal(writes[0]?.buffer?.path, `${CWD}/src/example.ts`);
  assert.deepEqual(output, ["Editor context published."]);
});

test("publish and dry-run reject consumer-invalid roots without writing", async (t) => {
  const bridgeDirectory = await mkdtemp(join(TEST_ROOT, "rejected-publish-"));
  t.after(() => rm(bridgeDirectory, { recursive: true, force: true }));
  const otherCwd = join(bridgeDirectory, "other-project");
  await mkdir(otherCwd);
  const contextStore = createEditorContextStore({ bridgeDirectory, now: () => NOW });
  const rejectedState = state({ cwd: otherCwd });
  const client = liveClient({
    bridgeDirectory,
    liveStatePath: (sessionId, ownerId) =>
      join(bridgeDirectory, "live", `${sessionId}.${ownerId}.json`),
    readLiveState: async () => rejectedState,
  });

  for (const dryRun of [false, true]) {
    const output: string[] = [];
    const argv = [
      "publish",
      "--session-id",
      rejectedState.sessionId,
      "--owner-id",
      rejectedState.ownerId,
      "--cwd",
      CWD,
    ];
    if (dryRun) argv.push("--dry-run");
    assert.equal(
      await runEditorContextCli(argv, {
        liveClient: client,
        store: contextStore,
        now: () => NOW,
        output: (line) => output.push(line),
      }),
      1,
    );
    assert.deepEqual(output, ["Editor context rejected: WORKSPACE_NOT_APPROVED"]);
    await assert.rejects(
      stat(contextStore.contextPath(rejectedState.sessionId, rejectedState.ownerId)),
      { code: "ENOENT" },
    );
  }
});

test("publish accepts a symlink cwd for a realpath live cwd and writes consumable context", async (t) => {
  const bridgeDirectory = await mkdtemp(join(TEST_ROOT, "symlink-publish-"));
  t.after(() => rm(bridgeDirectory, { recursive: true, force: true }));
  const realCwd = join(bridgeDirectory, "real-project");
  const linkedCwd = join(bridgeDirectory, "linked-project");
  await mkdir(realCwd);
  await symlink(realCwd, linkedCwd, "dir");
  const contextStore = createEditorContextStore({ bridgeDirectory, now: () => NOW });
  const linkedState = state({ cwd: realCwd });
  const client = liveClient({
    bridgeDirectory,
    liveStatePath: (sessionId, ownerId) =>
      join(bridgeDirectory, "live", `${sessionId}.${ownerId}.json`),
    readLiveState: async () => linkedState,
  });
  const output: string[] = [];

  assert.equal(
    await runEditorContextCli(
      [
        "publish",
        "--session-id",
        linkedState.sessionId,
        "--owner-id",
        linkedState.ownerId,
        "--cwd",
        linkedCwd,
      ],
      {
        liveClient: client,
        store: contextStore,
        now: () => NOW,
        output: (line) => output.push(line),
      },
    ),
    0,
  );
  assert.deepEqual(output, ["Editor context published."]);
  const consumed = await contextStore.consume({
    cwd: realCwd,
    sessionId: linkedState.sessionId,
    ownerId: linkedState.ownerId,
    generation: 1,
  });
  assert.equal(consumed.status, "consumed");
});

test("publish auto-targets the only fresh canonical-cwd session", async () => {
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const exitCode = await runEditorContextCli(["publish", "--cwd", CWD], {
    liveClient: liveClient({ listLiveStates: async () => [state()] }),
    store: store(writes),
    now: () => NOW,
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(writes[0]?.session, {
    sessionId: "session-1",
    ownerId: "owner-1",
    generation: 1,
  });
  assert.deepEqual(output, ["Editor context published."]);
});

test("select persists a canonical target atomically with private permissions", async (t) => {
  const bridgeDirectory = await mkdtemp(join(tmpdir(), "choco-pi-target-"));
  t.after(async () => rm(bridgeDirectory, { recursive: true, force: true }));
  const client = liveClient({ bridgeDirectory, readLiveState: async () => state() });
  const output: string[] = [];

  assert.equal(
    await runEditorContextCli(
      ["select", "--session-id", "session-1", "--owner-id", "owner-1", "--cwd", CWD],
      {
        liveClient: client,
        now: () => NOW,
        output: (line) => output.push(line),
      },
    ),
    0,
  );

  const targets = createContextTargetStore({ bridgeDirectory, now: () => NOW });
  const path = await targets.targetPath(CWD);
  const canonicalCwd = await canonicalizeCwd(CWD);
  assert.equal(basename(path), `${createHash("sha256").update(canonicalCwd).digest("hex")}.json`);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    ...target("session-1", "owner-1"),
    cwd: canonicalCwd,
  });
  assert.equal((await stat(targets.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(output, ["Context target selected."]);

  assert.equal(
    await runEditorContextCli(["select", "--cwd", CWD, "--clear"], {
      liveClient: client,
      output: (line) => output.push(line),
    }),
    0,
  );
  assert.equal(await targets.read(CWD), undefined);
});

test("canonical target cwd rejects an unresolvable directory", async () => {
  await assert.rejects(canonicalizeCwd(join(TEST_ROOT, "missing-cwd")), /CWD_UNRESOLVABLE/);
});

test("select accepts a stale heartbeat only while its pid is alive", async () => {
  const stale = state({ updatedAt: new Date(NOW - 60_000).toISOString() });
  const selected = memoryTargetStore();
  const argv = [
    "select",
    "--session-id",
    stale.sessionId,
    "--owner-id",
    stale.ownerId,
    "--cwd",
    CWD,
  ];
  assert.equal(
    await runEditorContextCli(argv, {
      liveClient: liveClient({ readLiveState: async () => stale }),
      targetStore: selected.store,
      now: () => NOW,
      pidAlive: () => true,
      output: () => undefined,
    }),
    0,
  );
  assert.equal(
    await runEditorContextCli(argv, {
      liveClient: liveClient({ readLiveState: async () => stale }),
      targetStore: memoryTargetStore().store,
      now: () => NOW,
      pidAlive: () => false,
      output: () => undefined,
    }),
    1,
  );
});

test("publish target precedence is explicit then persisted then single live", async () => {
  const writes: EditorContextDocument[] = [];
  const persisted = target("session-persisted", "owner-persisted");
  const states = new Map([
    ["session-explicit", state({ sessionId: "session-explicit", ownerId: "owner-explicit" })],
    [persisted.sessionId, state({ sessionId: persisted.sessionId, ownerId: persisted.ownerId })],
  ]);
  const explicitStore: ContextTargetStore = {
    directory: "/tmp/targets",
    targetPath: async () => "/tmp/target.json",
    read: async () => {
      throw new Error("persisted target must not be read");
    },
    write: async () => "/tmp/target.json",
    clear: async () => undefined,
  };
  const client = liveClient({
    readLiveState: async (sessionId) => states.get(sessionId),
    listLiveStates: async () => [state({ sessionId: "session-single", ownerId: "owner-single" })],
  });

  assert.equal(
    await runEditorContextCli(
      ["publish", "--session-id", "session-explicit", "--owner-id", "owner-explicit", "--cwd", CWD],
      {
        liveClient: client,
        store: store(writes),
        targetStore: explicitStore,
        now: () => NOW,
        output: () => undefined,
      },
    ),
    0,
  );
  assert.equal(writes.at(-1)?.session.sessionId, "session-explicit");

  assert.equal(
    await runEditorContextCli(["publish", "--cwd", CWD], {
      liveClient: client,
      store: store(writes),
      targetStore: memoryTargetStore(persisted).store,
      now: () => NOW,
      output: () => undefined,
    }),
    0,
  );
  assert.equal(writes.at(-1)?.session.sessionId, "session-persisted");
});

test("publish clears a stale persisted target and falls back to the single live session", async () => {
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const staleTarget = target("session-stale", "owner-stale");
  const targets = memoryTargetStore(staleTarget);
  const staleState = state({
    sessionId: staleTarget.sessionId,
    ownerId: staleTarget.ownerId,
    updatedAt: new Date(NOW - 60_000).toISOString(),
  });
  const fallback = state({ sessionId: "session-fallback", ownerId: "owner-fallback" });
  const exitCode = await runEditorContextCli(["publish", "--cwd", CWD], {
    liveClient: liveClient({
      readLiveState: async (sessionId) =>
        sessionId === staleState.sessionId ? staleState : fallback,
      listLiveStates: async () => [fallback],
    }),
    store: store(writes),
    targetStore: targets.store,
    now: () => NOW,
    pidAlive: () => false,
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(targets.cleared, [CWD]);
  assert.equal(writes[0]?.session.sessionId, "session-fallback");
  assert.deepEqual(output, ["TARGET_STALE_CLEARED", "Editor context published."]);
});

test("publish converts zero-based Zed positions to one-based protocol positions", async () => {
  const writes: EditorContextDocument[] = [];
  const exitCode = await runEditorContextCli(
    ["publish", "--cwd", CWD, "--line", "0", "--column", "0", "--zero-based-position"],
    {
      liveClient: liveClient({ listLiveStates: async () => [state()] }),
      store: store(writes),
      now: () => NOW,
      output: () => undefined,
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(writes[0]?.cursor, { line: 1, column: 1 });
});

test("publish passes one-based real-Zed positions through unchanged", async () => {
  const writes: EditorContextDocument[] = [];
  const exitCode = await runEditorContextCli(
    ["publish", "--cwd", CWD, "--line", "3", "--column", "2"],
    {
      liveClient: liveClient({ listLiveStates: async () => [state()] }),
      store: store(writes),
      now: () => NOW,
      output: () => undefined,
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(writes[0]?.cursor, { line: 3, column: 2 });
});

test("publish requires an explicit target when canonical-cwd matches are ambiguous", async () => {
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const client = liveClient({
    listLiveStates: async () => [state(), state({ sessionId: "session-2", ownerId: "owner-2" })],
  });

  const ambiguous = await runEditorContextCli(["publish", "--cwd", CWD], {
    liveClient: client,
    store: store(writes),
    output: (line) => output.push(line),
  });
  assert.equal(ambiguous, 1);
  assert.match(output[0] ?? "", /LIVE_TARGET_AMBIGUOUS/);
  assert.match(output[0] ?? "", /List Live Sessions/);
  assert.match(output[0] ?? "", /printed select command/);
  assert.deepEqual(writes, []);

  output.length = 0;
  const explicit = await runEditorContextCli(
    ["publish", "--session-id", "session-1", "--owner-id", "owner-1", "--cwd", CWD],
    {
      liveClient: client,
      store: store(writes),
      now: () => NOW,
      output: (line) => output.push(line),
    },
  );
  assert.equal(explicit, 0);
  assert.equal(writes.length, 1);
  assert.deepEqual(output, ["Editor context published."]);
});

test("publish bounds injected selection environment without leaking content", async () => {
  const sentinel = "PRIVATE-ZED-SELECTION";
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const argv = [
    "publish",
    "--session-id",
    "session-1",
    "--owner-id",
    "owner-1",
    "--cwd",
    CWD,
    "--selection-env",
    "ZED_SELECTED_TEXT",
  ];
  const captured = await runEditorContextCli(argv, {
    liveClient: liveClient(),
    store: store(writes),
    now: () => NOW,
    environment: { ZED_SELECTED_TEXT: sentinel },
    output: (line) => output.push(line),
  });

  assert.equal(captured, 0);
  assert.equal(writes[0]?.selection?.text, sentinel);
  assert.equal(output.join("\n").includes(sentinel), false);

  output.length = 0;
  writes.length = 0;
  const oversized = await runEditorContextCli(argv, {
    liveClient: liveClient(),
    store: store(writes),
    now: () => NOW,
    environment: { ZED_SELECTED_TEXT: sentinel.repeat(2_000) },
    output: (line) => output.push(line),
  });

  assert.equal(oversized, 1);
  assert.deepEqual(output, ["Editor context command failed: SELECTION_TEXT_TOO_LARGE"]);
  assert.equal(output.join("\n").includes(sentinel), false);
  assert.deepEqual(writes, []);

  output.length = 0;
  const conflict = await runEditorContextCli([...argv, "--selection-file", "/tmp/selection.txt"], {
    liveClient: liveClient(),
    store: store(writes),
    output: (line) => output.push(line),
  });

  assert.equal(conflict, 1);
  assert.deepEqual(output, ["Editor context command failed: SELECTION_FILE_AND_ENV_CONFLICT"]);
});

test("publish rejects owner mismatch and oversized selection with bounded code-only diagnostics", async () => {
  const output: string[] = [];
  const writes: EditorContextDocument[] = [];
  const mismatch = await runEditorContextCli(
    ["publish", "--session-id", "session-1", "--owner-id", "wrong-owner", "--cwd", CWD],
    {
      liveClient: liveClient(),
      store: store(writes),
      output: (line) => output.push(line),
    },
  );
  assert.equal(mismatch, 1);
  assert.match(output[0] ?? "", /LIVE_OWNER_MISMATCH/);

  output.length = 0;
  const sentinel = "SECRET-SELECTION";
  const oversized = await runEditorContextCli(
    [
      "publish",
      "--session-id",
      "session-1",
      "--owner-id",
      "owner-1",
      "--cwd",
      CWD,
      "--selection-file",
      "/tmp/selection.txt",
    ],
    {
      liveClient: liveClient(),
      store: store(writes),
      now: () => NOW,
      readSelectionFile: async () => sentinel.repeat(2_000),
      output: (line) => output.push(line),
    },
  );
  assert.equal(oversized, 1);
  assert.match(output[0] ?? "", /SELECTION_TEXT_TOO_LARGE/);
  assert.equal(output.join("\n").includes(sentinel), false);
  assert.deepEqual(writes, []);
});

test("diagnose dry-run lists only canonical cwd matches from newest to oldest", async () => {
  const output: string[] = [];
  const exitCode = await runEditorContextCli(["diagnose", "--cwd", CWD, "--dry-run"], {
    liveClient: liveClient({
      listLiveStates: async () => [
        state({ ownerId: "owner-old", updatedAt: new Date(NOW - 2_000).toISOString() }),
        state({ ownerId: "owner-new", updatedAt: new Date(NOW - 1_000).toISOString() }),
        state({ sessionId: "session-other", ownerId: "owner-other", cwd: "/workspace/other" }),
      ],
    }),
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(output[0], "Matching live sessions: 2");
  assert.match(output[1] ?? "", /owner-new/);
  assert.match(output[2] ?? "", /owner-old/);
  assert.equal(output.join("\n").includes("owner-other"), false);
});

test("list prints a copy-ready select command with status and model", async () => {
  const output: string[] = [];
  const exitCode = await runEditorContextCli(["list", "--cwd", CWD], {
    liveClient: liveClient({ listLiveStates: async () => [state({ model: "provider/model" })] }),
    commandPath: "/fixture/node",
    cliPath: "/fixture/cli.ts",
    output: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(
    output[1],
    `'/fixture/node' '/fixture/cli.ts' 'select' '--session-id' 'session-1' '--owner-id' 'owner-1' '--cwd' '${CWD}' # status=idle model="provider/model"`,
  );
});

test("list prints every fresh session sharing the same cwd", async (t) => {
  const bridgeDirectory = await mkdtemp(join(TEST_ROOT, "multi-live-"));
  t.after(() => rm(bridgeDirectory, { recursive: true, force: true }));
  const client = createLiveSessionClient({ bridgeDirectory });
  const updatedAt = new Date().toISOString();
  await Promise.all([
    client.publishLiveState(state({ sessionId: "session-a", ownerId: "owner-a", updatedAt })),
    client.publishLiveState(state({ sessionId: "session-b", ownerId: "owner-b", updatedAt })),
  ]);
  const output: string[] = [];

  assert.equal(
    await runEditorContextCli(["list", "--cwd", CWD], {
      liveClient: client,
      commandPath: "/fixture/node",
      cliPath: "/fixture/cli.ts",
      output: (line) => output.push(line),
    }),
    0,
  );
  assert.equal(output[0], "Matching live sessions: 2");
  assert.ok(
    output.some((line) => line.includes("'--session-id' 'session-a' '--owner-id' 'owner-a'")),
  );
  assert.ok(
    output.some((line) => line.includes("'--session-id' 'session-b' '--owner-id' 'owner-b'")),
  );
});
