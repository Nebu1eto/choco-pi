import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalizePath,
  createScratchWarner,
  describeScratchChange,
  loadScratchGrants,
  registerScratchRoot,
  resolveScratch,
  scratchChangedNotice,
  scratchDestinations,
  scratchEnv,
  scratchPromptLine,
  scratchWarningText,
  sessionIdFromFile,
  setPreviousScratchDir,
  unregisterScratchRoot,
} from "../.pi/extensions/lib/scratch-path.ts";

const NO_ENV = {};

test("resolveScratch roots at the lineage id and names the previous directory", () => {
  assert.deepEqual(resolveScratch({ currentSessionId: "cur" }), {
    rootSessionId: "cur",
    currentSessionId: "cur",
    scratchDir: "/tmp/choco-pi/cur/",
  });
  assert.deepEqual(
    resolveScratch({ rootSessionId: "root", currentSessionId: "cur", previousSessionId: "old" }),
    {
      rootSessionId: "root",
      currentSessionId: "cur",
      scratchDir: "/tmp/choco-pi/root/",
      previousScratchDir: "/tmp/choco-pi/old/",
    },
  );
  assert.equal(
    resolveScratch({ currentSessionId: "same", previousSessionId: "same" }).previousScratchDir,
    undefined,
  );
});

test("canonicalizePath maps /private/tmp, resolves relatives and follows symlinked ancestors", async () => {
  assert.equal(await canonicalizePath("/private/tmp/a/b", "/"), "/tmp/a/b");
  assert.equal(
    await canonicalizePath("x/../y.txt", "/tmp/choco-pi-none"),
    "/tmp/choco-pi-none/y.txt",
  );
  const dir = await mkdtemp(join(tmpdir(), "scratch-path-"));
  try {
    const real = join(dir, "real");
    await mkdir(real);
    await symlink(real, join(dir, "link"));
    const viaLink = await canonicalizePath(join(dir, "link", "new", "file.txt"), "/");
    const direct = await canonicalizePath(join(real, "new", "file.txt"), "/");
    assert.equal(viaLink, direct);
    assert.ok(viaLink.endsWith("/real/new/file.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlink into the scratch directory is judged by its target", async () => {
  const sessionId = `scratch-test-${process.pid}-${Date.now()}`;
  const scratch = `/tmp/choco-pi/${sessionId}`;
  const dir = await mkdtemp(join("/tmp", "scratch-path-link-"));
  try {
    await mkdir(scratch, { recursive: true });
    await symlink(scratch, join(dir, "link"));
    const warner = createScratchWarner({ inherited: NO_ENV });
    const call = (file: string) =>
      warner.check({
        sessionId,
        toolName: "write",
        cwd: "/",
        destinations: [{ path: file, directory: false }],
      });
    assert.deepEqual(await call(join(dir, "link", "new", "f.txt")), []);
    assert.equal((await call(join(dir, "plain", "f.txt"))).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("warning and notice text are exact", () => {
  assert.equal(
    scratchWarningText("/tmp/x/y", "/tmp/choco-pi/r/"),
    "Scratch path warning: /tmp/x/y is outside this session's scratch directory /tmp/choco-pi/r/. Use /tmp/choco-pi/r/ for temporary files unless the user granted this path.",
  );
  assert.equal(
    scratchChangedNotice("/tmp/choco-pi/old/", "/tmp/choco-pi/new/"),
    "Scratch directory changed: previous /tmp/choco-pi/old/; use /tmp/choco-pi/new/ from now on. Nothing was moved or deleted.",
  );
  assert.equal(scratchPromptLine("s", NO_ENV), "Scratch directory: /tmp/choco-pi/s/");
  assert.equal(sessionIdFromFile("/x/2026-01-01T00-00-00-000Z_abc-123.jsonl"), "abc-123");
});

test("warner warns for /tmp outside scratch once per tool and directory, never inside or elsewhere", async () => {
  const warner = createScratchWarner({ inherited: NO_ENV });
  const call = (toolName: string, file: string) =>
    warner.check({
      sessionId: "s1",
      toolName,
      cwd: "/work",
      destinations: [{ path: file, directory: false }],
    });
  assert.deepEqual(await call("write", "/tmp/choco-pi/s1/a.txt"), []);
  assert.deepEqual(await call("write", "/private/tmp/choco-pi/s1/a.txt"), []);
  assert.deepEqual(await call("write", "/work/src/a.txt"), []);
  const first = await call("write", "/tmp/stray/a.txt");
  assert.deepEqual(first, [scratchWarningText("/tmp/stray/a.txt", "/tmp/choco-pi/s1/")]);
  assert.deepEqual(await call("write", "/tmp/stray/b.txt"), []);
  assert.equal((await call("edit", "/tmp/stray/b.txt")).length, 1);
  assert.equal((await call("write", "/tmp/other/b.txt")).length, 1);
  assert.equal((await call("write", "/tmp/choco-pi/other-session/b.txt")).length, 1);
  warner.reset();
  assert.equal((await call("write", "/tmp/stray/a.txt")).length, 1);
});

test("grants suppress the warning and read only user-level settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scratch-grants-"));
  try {
    const file = join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ scratchGrants: ["/tmp/granted", "relative", 5] }));
    const grants = await loadScratchGrants([file, join(dir, "missing.json")]);
    assert.deepEqual(grants, ["/tmp/granted"]);
    assert.deepEqual(await loadScratchGrants([join(dir, "missing.json")]), []);
    const warner = createScratchWarner({ inherited: NO_ENV, grants: () => grants });
    const granted = await warner.check({
      sessionId: "s",
      toolName: "write",
      cwd: "/",
      destinations: [{ path: "/tmp/granted/x/y.txt", directory: false }],
    });
    assert.deepEqual(granted, []);
    const ungranted = await warner.check({
      sessionId: "s",
      toolName: "write",
      cwd: "/",
      destinations: [{ path: "/tmp/grantedx/y.txt", directory: false }],
    });
    assert.equal(ungranted.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("destinations cover write, edit, apply_patch and ast_grep_replace only", () => {
  assert.deepEqual(scratchDestinations("write", { path: "/a" }), [
    { path: "/a", directory: false },
  ]);
  assert.deepEqual(scratchDestinations("Edit", { file_path: "/b" }), [
    { path: "/b", directory: false },
  ]);
  assert.deepEqual(
    scratchDestinations("apply_patch", {
      input:
        "*** Begin Patch\n*** Add File: /tmp/n.txt\n+x\n*** Update File: src/u.ts\n*** Move to: /tmp/m.ts\n*** End Patch",
    }).map((entry) => entry.path),
    ["/tmp/n.txt", "src/u.ts", "/tmp/m.ts"],
  );
  assert.deepEqual(scratchDestinations("ast_grep_replace", { paths: ["/tmp/d", 3] }), [
    { path: "/tmp/d", directory: true },
  ]);
  assert.deepEqual(scratchDestinations("bash", { command: "touch /tmp/x" }), []);
  assert.deepEqual(scratchDestinations("write", "nope"), []);
});

test("env carries the lineage root, keeps inherited values and exposes the previous directory", () => {
  registerScratchRoot("child", "root");
  registerScratchRoot("grandchild", "root");
  try {
    assert.deepEqual(scratchEnv("child", NO_ENV), {
      PI_ROOT_SESSION_ID: "root",
      PI_SCRATCH_DIR: "/tmp/choco-pi/root/",
    });
    assert.deepEqual(scratchEnv("grandchild", NO_ENV), scratchEnv("child", NO_ENV));
    assert.deepEqual(scratchEnv("plain", NO_ENV), {
      PI_ROOT_SESSION_ID: "plain",
      PI_SCRATCH_DIR: "/tmp/choco-pi/plain/",
    });
    assert.deepEqual(
      scratchEnv("child", { PI_ROOT_SESSION_ID: "inherited", PI_SCRATCH_DIR: "/tmp/choco-pi/x/" }),
      {},
    );
    assert.equal(
      scratchEnv("child", { PI_ROOT_SESSION_ID: "inherited" })["PI_SCRATCH_DIR"],
      "/tmp/choco-pi/inherited/",
    );
    setPreviousScratchDir("plain", "/tmp/choco-pi/old/");
    assert.equal(scratchEnv("plain", NO_ENV)["PI_PREVIOUS_SCRATCH_DIR"], "/tmp/choco-pi/old/");
  } finally {
    unregisterScratchRoot("child");
    unregisterScratchRoot("grandchild");
    unregisterScratchRoot("plain");
  }
  assert.equal(scratchEnv("child", NO_ENV)["PI_ROOT_SESSION_ID"], "child");
});

test("a fork or resume that changes the session id owes one notice naming both directories", () => {
  const change = describeScratchChange({
    reason: "fork",
    previousSessionFile: "/s/2026-01-01T00-00-00-000Z_old-id.jsonl",
    currentSessionId: "new-id",
    inherited: NO_ENV,
  });
  assert.deepEqual(change, {
    previousScratchDir: "/tmp/choco-pi/old-id/",
    scratchDir: "/tmp/choco-pi/new-id/",
    notice:
      "Scratch directory changed: previous /tmp/choco-pi/old-id/; use /tmp/choco-pi/new-id/ from now on. Nothing was moved or deleted.",
  });
  const input = { previousSessionFile: "/s/t_old-id.jsonl", currentSessionId: "new-id" };
  assert.ok(describeScratchChange({ ...input, reason: "resume", inherited: NO_ENV }));
  for (const reason of ["startup", "reload", "new"])
    assert.equal(describeScratchChange({ ...input, reason, inherited: NO_ENV }), undefined);
  assert.equal(
    describeScratchChange({ reason: "fork", currentSessionId: "new-id", inherited: NO_ENV }),
    undefined,
  );
  assert.equal(
    describeScratchChange({
      reason: "resume",
      previousSessionFile: "/s/t_same.jsonl",
      currentSessionId: "same",
      inherited: NO_ENV,
    }),
    undefined,
  );
  assert.equal(
    describeScratchChange({ ...input, reason: "fork", inherited: { PI_ROOT_SESSION_ID: "r" } }),
    undefined,
  );
});
