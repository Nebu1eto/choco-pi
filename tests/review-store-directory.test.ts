import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The store reads the agent directory and HOME; both point into a sandbox
// before the module loads, so no run of this file can reach the real home.
const sandbox = await mkdtemp(join(tmpdir(), "review-store-directory-"));
const home = join(sandbox, "home");
const agentDirectory = join(sandbox, "agent");
const previousHome = process.env.HOME;
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDirectory;
const store = await import("../.pi/extensions/review/core/store.ts");
type ReviewRecord = import("../.pi/extensions/review/core/types.ts").ReviewRecord;

test.after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  await rm(sandbox, { recursive: true, force: true });
});

const NOW = "2026-03-01T12:00:00.000Z";

function record(repository: string): ReviewRecord {
  return {
    version: 1,
    repoKey: repository,
    target: { kind: "branch", base: "main" },
    baseSha: "base",
    headSha: "head",
    cursor: { reviewedHunkIds: [], lastHeadSha: "head" },
    comments: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("records are written under the session's agent directory, not HOME", async () => {
  const repository = store.repoKey("/work/directory-test");
  const saved = record(repository);
  await store.createReviewStore().save(saved);
  const fileName = `${store.targetKey(saved.target)}.json`;
  const expected = join(agentDirectory, "choco-pi", "reviews", repository, fileName);
  assert.equal(await exists(expected), true, `record must be written at ${expected}`);
  assert.equal(await exists(join(home, ".pi")), false, "nothing may be written under HOME/.pi");
});

test("the agent directory is resolved when the store is used, not when it loads", async () => {
  const later = join(sandbox, "later-agent");
  process.env.PI_CODING_AGENT_DIR = later;
  try {
    const repository = store.repoKey("/work/resolved-at-use");
    await store.createReviewStore().save(record(repository));
    const names = await readdir(join(later, "choco-pi", "reviews", repository));
    assert.equal(names.length, 1);
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
  }
});

test("the default agent directory keeps today's review path byte for byte", () => {
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    // HOME is the sandbox, so this only computes a path; nothing is written.
    assert.equal(store.resolveReviewDirectory(), join(home, ".pi", "agent", "choco-pi", "reviews"));
  } finally {
    process.env.PI_CODING_AGENT_DIR = agentDirectory;
  }
});

test("an explicit agent directory maps to <agentDir>/choco-pi/reviews", () => {
  assert.equal(store.resolveReviewDirectory("/agents/x"), join("/agents/x", "choco-pi", "reviews"));
});
