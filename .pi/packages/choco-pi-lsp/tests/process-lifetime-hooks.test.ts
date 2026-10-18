import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = (relative: string): string =>
  pathToFileURL(path.join(packageRoot, relative)).href;

const ChildReportSchema = Type.Record(Type.String(), Type.Unknown());

/**
 * Each scenario runs in a fresh Node process: process listeners, module
 * instances, and data directories are process-wide state, and a module is
 * re-evaluated (as Pi does for an in-process session with another cwd) by
 * importing it under a distinct query string.
 */
async function runChild(source: string, root: string, env: Record<string, string> = {}) {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: {
      ...process.env,
      CHOCO_PI_LSP_HOME: path.join(root, "home"),
      PILENS_DATA_DIR: path.join(root, "data"),
      ...env,
    },
  });
  const lines = stdout.trim().split("\n");
  const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? "{}");
  return Value.Parse(ChildReportSchema, parsed);
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-lsp-lifetime-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const snapshotSource = (cwd: string) => `
const url = ${JSON.stringify(moduleUrl("clients/project-snapshot.ts"))};
const snapshot = (seq) => ({
  version: 2, projectRoot: ${JSON.stringify(cwd)}, generatedAt: new Date().toISOString(), seq,
  files: {}, symbols: {}, reverseDeps: {}, cachedExports: [],
});
// A warm-up evaluation lets shared process-wide hooks (loggers) install once.
const warm = await import(url + "?instance=warm");
warm.saveProjectSnapshot(${JSON.stringify(cwd)}, snapshot(1));
await warm.waitForProjectSnapshotPersistsForTests();
const before = process.listenerCount("exit");
let seq = 2;
for (const tag of ["a", "b", "c"]) {
  const instance = await import(url + "?instance=" + tag);
  instance.saveProjectSnapshot(${JSON.stringify(cwd)}, snapshot(seq++));
  await instance.waitForProjectSnapshotPersistsForTests();
}
console.log(JSON.stringify({ addedExitListeners: process.listenerCount("exit") - before }));
`;

test("re-evaluated project-snapshot instances do not accumulate exit listeners", async () => {
  await withRoot(async (root) => {
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const report = await runChild(snapshotSource(cwd), root);
    assert.equal(report.addedExitListeners, 0);
  });
});

const crashGuardSource = `
const url = ${JSON.stringify(moduleUrl("clients/lsp/crash-guard.ts"))};
const before = {
  uncaught: process.listenerCount("uncaughtException"),
  rejection: process.listenerCount("unhandledRejection"),
};
for (const tag of ["a", "b", "c"]) {
  const instance = await import(url + "?instance=" + tag);
  instance.installLspCrashGuard();
  instance.installLspCrashGuard();
}
const ignorable = (await import(url)).isIgnorableLspRuntimeCrash(
  Object.assign(new Error("boom"), { code: "EPIPE" }),
);
console.log(JSON.stringify({
  uncaught: process.listenerCount("uncaughtException") - before.uncaught,
  rejection: process.listenerCount("unhandledRejection") - before.rejection,
  ignorable,
}));
`;

test("the LSP crash guard installs once per process across module instances", async () => {
  await withRoot(async (root) => {
    const report = await runChild(crashGuardSource, root);
    assert.deepEqual(report, { uncaught: 1, rejection: 1, ignorable: true });
  });
});

const reviewGraphSource = (cwd: string, mode: "drain" | "exit") => `
const builder = await import(${JSON.stringify(moduleUrl("clients/review-graph/builder.ts"))});
const { FactStore } = await import(${JSON.stringify(moduleUrl("clients/dispatch/fact-store.ts"))});
const before = process.listenerCount("exit");
await builder.buildOrUpdateGraph(${JSON.stringify(cwd)}, [], new FactStore());
const pendingListeners = process.listenerCount("exit") - before;
if (${JSON.stringify(mode)} === "exit") {
  // The debounced persist is still pending: only the exit hook can write it.
  console.log(JSON.stringify({ pendingListeners }));
  process.exit(0);
}
builder.flushReviewGraphPersistsForTests();
console.log(JSON.stringify({
  pendingListeners,
  drainedListeners: process.listenerCount("exit") - before,
}));
`;

async function reviewGraphFixture(root: string): Promise<string> {
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), '{"name":"fixture","type":"module"}\n');
  await writeFile(
    path.join(cwd, "src", "a.ts"),
    'import { b } from "./b.ts";\nexport const a = () => b();\n',
  );
  await writeFile(path.join(cwd, "src", "b.ts"), "export const b = () => 1;\n");
  return cwd;
}

const debounced = { CHOCO_PI_LSP_GRAPH_PERSIST_DEBOUNCE_MS: "60000" };

test("a drained review-graph persist queue unregisters its exit hook", async () => {
  await withRoot(async (root) => {
    const cwd = await reviewGraphFixture(root);
    const report = await runChild(reviewGraphSource(cwd, "drain"), root, debounced);
    assert.ok(Number(report.pendingListeners) >= 1, JSON.stringify(report));
    // Shared logger hooks may stay; this instance's persist hook must not.
    assert.equal(report.drainedListeners, Number(report.pendingListeners) - 1);
  });
});

test("pending review-graph persists are still flushed at process exit", async () => {
  await withRoot(async (root) => {
    const cwd = await reviewGraphFixture(root);
    const builderUrl = moduleUrl("clients/review-graph/builder.ts");
    const report = await runChild(reviewGraphSource(cwd, "exit"), root, debounced);
    assert.ok(Number(report.pendingListeners) >= 1, JSON.stringify(report));
    const pathReport = await runChild(
      `const b = await import(${JSON.stringify(builderUrl)});
       console.log(JSON.stringify({ cachePath: b.reviewGraphCachePath(${JSON.stringify(cwd)}) }));`,
      root,
    );
    await access(String(pathReport.cachePath));
  });
});
