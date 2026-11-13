// Fixture replay: files written by the TypeBox-validated HEAD must still load after the pi-schema migration.
// The fixtures are hand-built from HEAD's schemas (clients/*.ts), not produced by the code under test.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateAdvisoryProvenance } from "../clients/advisory-provenance.ts";
import { CacheManager } from "../clients/cache-manager.ts";
import { loadCodebaseModel } from "../clients/codebase-model.ts";
import { renderDegradationLines } from "../clients/degradation-ledger.ts";
import { readExtensionMode } from "../clients/extension-mode.ts";
import { getProjectDataDir } from "../clients/file-utils.ts";
import { getWorklogPath, readWorklog } from "../clients/fix-worklog.ts";

async function withProject(run: (cwd: string, dataDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-lsp-cache-formats-"));
  const previous = process.env.PILENS_DATA_DIR;
  process.env.PILENS_DATA_DIR = path.join(root, "data");
  try {
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    await run(cwd, getProjectDataDir(cwd));
  } finally {
    if (previous === undefined) delete process.env.PILENS_DATA_DIR;
    else process.env.PILENS_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const identity = { reviewGraphVersion: "rg-1", reviewGraphSignature: "sig-1" };
const modelFixture = {
  version: 1,
  reviewGraphVersion: "rg-1",
  reviewGraphSignature: "sig-1",
  generatedAt: "2026-01-01T00:00:00.000Z",
  totalSymbols: 1,
  totalFiles: 1,
  entries: [
    {
      file: "a.ts",
      name: "f",
      kind: "function",
      calls: ["g"],
      calledBy: [],
      inDegree: 0.5,
      tokens: 12,
      extraFromNewerWriter: true,
    },
  ],
  totalTokens: 12,
  extraTopLevel: "kept-open",
};

test("codebase model: HEAD-format file loads; open objects, missing and non-finite fields rejected", async () => {
  await withProject(async (cwd, dataDir) => {
    const file = path.join(dataDir, "cache", "codebase-model.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(modelFixture));
    assert.equal(loadCodebaseModel(cwd, identity)?.entries[0]?.name, "f");

    await writeFile(file, JSON.stringify({ ...modelFixture, reviewGraphVersion: "" }));
    assert.equal(loadCodebaseModel(cwd, { ...identity, reviewGraphVersion: "" }), undefined);

    await writeFile(file, JSON.stringify({ ...modelFixture, version: 2 }));
    assert.equal(loadCodebaseModel(cwd, identity), undefined);

    const { totalTokens: _omitted, ...missing } = modelFixture;
    await writeFile(file, JSON.stringify(missing));
    assert.equal(loadCodebaseModel(cwd, identity), undefined);

    // JSON.parse("1e999") is Infinity; TypeBox Number rejected it and so must the migrated schema.
    await writeFile(
      file,
      JSON.stringify(modelFixture).replace('"totalTokens":12', '"totalTokens":1e999'),
    );
    assert.equal(loadCodebaseModel(cwd, identity), undefined);
  });
});

test("worklog: valid lines load, invalid lines are skipped, optional fields stay optional", async () => {
  await withProject(async (cwd) => {
    const file = getWorklogPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const legacy = {
      timestamp: "2026-01-01T00:00:00.000Z",
      filePath: "a.ts",
      rule: "r",
      tool: "t",
      message: "m",
      line: 3,
      fixable: true,
      autoFixed: false,
    };
    const full = {
      ...legacy,
      column: 2,
      fixSuggestion: "s",
      model: "m1",
      provider: "p1",
      extra: 1,
    };
    const lines = [
      JSON.stringify(legacy),
      JSON.stringify(full),
      JSON.stringify({ ...legacy, line: "3" }),
      JSON.stringify({ ...legacy, fixable: undefined }),
      "not json",
    ];
    await writeFile(file, `${lines.join("\n")}\n`);
    const entries = readWorklog(cwd);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.provider, "p1");
  });
});

test("cache meta: HEAD-format meta is fresh; wrong types are malformed", async () => {
  await withProject(async (cwd, dataDir) => {
    const cacheDir = path.join(dataDir, "cache");
    await mkdir(cacheDir, { recursive: true });
    const manager = new CacheManager();
    const write = async (meta: Record<string, string | number>) => {
      await writeFile(path.join(cacheDir, "probe.json"), JSON.stringify({ ok: true }));
      await writeFile(path.join(cacheDir, "probe.meta.json"), JSON.stringify(meta));
    };
    await write({ timestamp: new Date().toISOString(), scanDurationMs: 5, fileCount: 2, extra: 1 });
    assert.equal(manager.inspectCache("probe", cwd), "fresh");
    await write({ timestamp: new Date().toISOString() });
    assert.equal(manager.inspectCache("probe", cwd), "fresh");
    await write({ timestamp: Date.now() });
    assert.equal(manager.inspectCache("probe", cwd), "malformed");
    await write({ timestamp: new Date().toISOString(), fileCount: "2" });
    assert.equal(manager.inspectCache("probe", cwd), "malformed");
  });
});

test("advisory provenance: legacy or malformed records stay unknown, well-formed ones validate", async () => {
  await withProject(async (cwd) => {
    const unknownResult = validateAdvisoryProvenance({ provenance: { revision: {} } }, cwd);
    assert.equal(unknownResult.status, "unknown");
    assert.deepEqual(unknownResult.reasons, ["malformed-or-legacy-provenance"]);

    const wellFormed = {
      revision: {
        sessionId: "s",
        projectSeq: 1,
        turnIndex: 1,
        generation: 1,
        capturedAt: 1,
        extra: 1,
      },
      files: [{ path: "gone.ts", role: "source", mtimeMs: 1, size: 1, sha256: "missing" }],
    };
    const ok = validateAdvisoryProvenance({ provenance: wellFormed }, cwd);
    assert.notEqual(ok.reasons[0], "malformed-or-legacy-provenance");

    const badRole = structuredClone(wellFormed);
    badRole.files[0].role = "other";
    assert.deepEqual(validateAdvisoryProvenance({ provenance: badRole }, cwd).reasons, [
      "malformed-or-legacy-provenance",
    ]);
    const badHash = structuredClone(wellFormed);
    badHash.files[0].sha256 = "XYZ";
    assert.deepEqual(validateAdvisoryProvenance({ provenance: badHash }, cwd).reasons, [
      "malformed-or-legacy-provenance",
    ]);
    const noFiles = { ...wellFormed, files: [] };
    assert.deepEqual(validateAdvisoryProvenance({ provenance: noFiles }, cwd).reasons, [
      "malformed-or-legacy-provenance",
    ]);
  });
});

test("degradation summary and extension mode guards keep their accept/reject behaviour", () => {
  const group = { kind: "k", count: 2, latestReasons: [{ subject: "s", reason: "r" }], extra: 1 };
  assert.ok(renderDegradationLines([group]).length > 0);
  assert.deepEqual(renderDegradationLines([{ ...group, count: "2" }]), []);
  assert.deepEqual(renderDegradationLines("nope"), []);

  assert.equal(readExtensionMode({ mode: "rpc" }), "rpc");
  assert.equal(readExtensionMode({ mode: "future" }), "unknown");
  assert.equal(readExtensionMode({ mode: 3 }), "unknown");
  assert.equal(readExtensionMode(null), "unknown");
  assert.equal(readExtensionMode([]), "unknown");
});
