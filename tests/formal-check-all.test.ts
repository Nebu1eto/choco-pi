// Tests for .pi/skills/formal-verify/scripts/check-all.ts: it runs every
// formal/tla/*/check.json model and its mutations through tlc.ts and exits 0
// only when every expectation holds. Runs that need TLC skip, visibly, when
// the pinned jar or Java is missing.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = path.join(ROOT, ".pi", "skills", "formal-verify", "scripts", "check-all.ts");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "formal", "counter");
const JAR = process.env.CHOCO_PI_TLA2TOOLS || path.join(ROOT, "formal", ".tools", "tla2tools.jar");

type Summary = {
  ok: boolean;
  error?: string;
  manifests?: number;
  message?: string;
  results?: { kind: string; name: string; status: string; ok: boolean; violated: string[] }[];
};
type Outcome = { code: number | null; summary: Summary };

function run(args: string[], cwd?: string): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const summary: Summary = JSON.parse(stdout);
        resolve({ code, summary });
      } catch (error) {
        reject(new Error(`no JSON summary (exit ${code}): ${String(error)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function javaWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.env.CHOCO_PI_JAVA || "java", ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
let missing: string | undefined;

before(async () => {
  if (!(await exists(JAR))) missing = `tla2tools.jar not found at ${JAR}`;
  else if (!(await javaWorks())) missing = "java is not runnable";
});

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A check.json as these tests write it; `expect` is loose so a bad value can be tested. */
type Mutation = { name: string; spec: string; config: string; expectViolated: string[] };
type Manifest = {
  schema: number;
  name: string;
  spec: string;
  config: string;
  expect: string;
  bounds: { maxStates: number; timeoutMs: number };
  mutations: Mutation[];
};

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema: 1,
    name: "counter",
    spec: "Counter.tla",
    config: "Counter.cfg",
    expect: "pass",
    bounds: { maxStates: 1000, timeoutMs: 60000 },
    mutations: [
      {
        name: "broken",
        spec: "Counter.tla",
        config: "Broken.cfg",
        expectViolated: ["Bounded"],
      },
    ],
    ...overrides,
  };
}

/** A temporary root holding formal/tla/counter with the fixture and this check.json text. */
async function rootWithText(text: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "formal-check-all-"));
  roots.push(root);
  const dir = path.join(root, "formal", "tla", "counter");
  await mkdir(dir, { recursive: true });
  for (const file of ["Counter.tla", "Counter.cfg", "Broken.cfg"]) {
    await copyFile(path.join(FIXTURE, file), path.join(dir, file));
  }
  await writeFile(path.join(dir, "check.json"), text);
  return root;
}

function rootWith(check: Manifest): Promise<string> {
  return rootWithText(JSON.stringify(check, null, 2));
}

function tlcArgs(root: string): string[] {
  return ["--root", root, "--jar", JAR];
}

describe("check-all.ts with TLC", () => {
  test("exits 0 when the base passes and each mutation violates exactly its set", async (t) => {
    if (missing !== undefined) return t.skip(missing);
    const { code, summary } = await run(tlcArgs(await rootWith(manifest())));
    assert.equal(code, 0, JSON.stringify(summary));
    assert.equal(summary.ok, true);
    assert.deepEqual(
      summary.results?.map((r) => [r.kind, r.name, r.status, r.ok, r.violated]),
      [
        ["base", "counter", "pass", true, []],
        ["mutation", "broken", "violated", true, ["Bounded"]],
      ],
    );
  });

  test("exits 3 when a mutation violates a different set than expected", async (t) => {
    if (missing !== undefined) return t.skip(missing);
    const check = manifest({
      mutations: [
        {
          name: "broken",
          spec: "Counter.tla",
          config: "Broken.cfg",
          expectViolated: ["Bounded", "NonNegative"],
        },
      ],
    });
    const { code, summary } = await run(tlcArgs(await rootWith(check)));
    assert.equal(code, 3);
    assert.equal(summary.ok, false);
    assert.equal(summary.results?.[1]?.ok, false);
  });

  test("exits 3 when a mutation is expected to fail but the model passes", async (t) => {
    if (missing !== undefined) return t.skip(missing);
    const check = manifest({
      mutations: [
        {
          name: "not-broken",
          spec: "Counter.tla",
          config: "Counter.cfg",
          expectViolated: ["Bounded"],
        },
      ],
    });
    const { code, summary } = await run(tlcArgs(await rootWith(check)));
    assert.equal(code, 3);
    assert.equal(summary.results?.[1]?.status, "pass");
  });

  test("exits 3 when the base model is violated but expected to pass", async (t) => {
    if (missing !== undefined) return t.skip(missing);
    const { code, summary } = await run(
      tlcArgs(await rootWith(manifest({ config: "Broken.cfg", mutations: [] }))),
    );
    assert.equal(code, 3);
    assert.equal(summary.results?.[0]?.status, "violated");
    assert.equal(summary.results?.[0]?.ok, false);
  });

  test("fails closed when the state bound makes a run inconclusive", async (t) => {
    if (missing !== undefined) return t.skip(missing);
    const check = manifest({ bounds: { maxStates: 2, timeoutMs: 60000 }, mutations: [] });
    const { code, summary } = await run(tlcArgs(await rootWith(check)));
    assert.equal(code, 3);
    assert.equal(summary.results?.[0]?.status, "inconclusive");
  });
});

describe("check-all.ts manifest handling", () => {
  test("exits 2 when an explicit --root has no formal/ directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "formal-check-all-empty-"));
    roots.push(root);
    const { code, summary } = await run(["--root", root]);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /no formal\/ directory/);
  });

  /** A git repository whose formal/ holds the given files and no TLA+ manifest. */
  async function repoWithFormal(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "formal-check-all-nomodel-"));
    roots.push(root);
    await mkdir(path.join(root, "formal"), { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
    return root;
  }

  function assertNothingChecked(outcome: Outcome): void {
    assert.equal(outcome.code, 0, outcome.summary.error ?? "");
    assert.equal(outcome.summary.ok, true);
    assert.equal(outcome.summary.manifests, 0);
    assert.equal(outcome.summary.results?.length, 0);
    assert.match(
      outcome.summary.message ?? "",
      /no TLA\+ model manifest .*formal\/tla\/\*\/check\.json.*nothing was checked/,
    );
  }

  test("an empty formal/ exits 0 and says no model was found", async () => {
    assertNothingChecked(await run([], await repoWithFormal({})));
  });

  test("a formal/ holding only property coverage records exits 0 and says no model was found", async () => {
    const root = await repoWithFormal({ "formal/property/parser/coverage.json": "{}\n" });
    assertNothingChecked(await run([], path.join(root, "formal")));
  });

  test("--only that matches no model is an error, with or without manifests", async () => {
    const empty = await run(["--only", "missing"], await repoWithFormal({}));
    assert.equal(empty.code, 2);
    assert.match(empty.summary.error ?? "", /no model named missing/);
    const some = await run(["--root", await rootWith(manifest()), "--only", "missing"]);
    assert.equal(some.code, 2);
    assert.match(some.summary.error ?? "", /no model named missing/);
  });

  test("exits 2 for a manifest that does not match the schema", async () => {
    const { code, summary } = await run(["--root", await rootWith(manifest({ expect: "maybe" }))]);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /not a check\.json manifest/);
  });

  test("exits 2 for unreadable JSON", async () => {
    const { code, summary } = await run(["--root", await rootWithText("{ not json")]);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /cannot read JSON/);
  });

  test("exits 2 when a path leaves the model directory", async () => {
    const { code, summary } = await run([
      "--root",
      await rootWith(manifest({ config: "../../../Counter.cfg" })),
    ]);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /leaves the model directory/);
  });

  test("exits 2 when a mutation expects no violation", async () => {
    const check = manifest({
      mutations: [{ name: "none", spec: "Counter.tla", config: "Broken.cfg", expectViolated: [] }],
    });
    const { code, summary } = await run(["--root", await rootWith(check)]);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /must expect a violation/);
  });

  test("without --root it finds formal/ from a subdirectory of a git repository", async () => {
    const root = await rootWith(manifest());
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
    const sub = path.join(root, "src", "deep");
    await mkdir(sub, { recursive: true });
    // --only with an unknown name stops after discovery, so no TLC run is needed.
    const { code, summary } = await run(["--only", "no-such-model"], sub);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /no model named no-such-model/);
  });

  test("without --root and without formal/ the error says where it searched", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "formal-check-all-bare-"));
    roots.push(root);
    await promisify(execFile)("git", ["init", "--quiet"], { cwd: root });
    const { code, summary } = await run([], root);
    assert.equal(code, 2);
    assert.match(summary.error ?? "", /no formal\/ directory in .* repository root/);
  });
});

describe("check-all.ts discovery failures are errors, never an empty model set", () => {
  const asRoot = process.getuid?.() === 0;
  const rootSkip = asRoot ? "running as root, which ignores file modes" : false;

  /** Run with `target` at `mode`, restoring 0o755 afterwards so cleanup works. */
  async function withMode(target: string, mode: number, body: () => Promise<void>): Promise<void> {
    await chmod(target, mode);
    try {
      await body();
    } finally {
      await chmod(target, 0o755);
    }
  }

  function assertDiscoveryError(outcome: Outcome, names: string): void {
    assert.equal(outcome.code, 2, JSON.stringify(outcome.summary));
    assert.equal(outcome.summary.ok, false);
    assert.equal(outcome.summary.results, undefined, "no model may run after a discovery error");
    assert.ok((outcome.summary.error ?? "").includes(names), outcome.summary.error ?? "");
  }

  test("an unreadable formal/tla/ is an error naming it", { skip: rootSkip }, async () => {
    const root = await rootWith(manifest());
    const tla = path.join(root, "formal", "tla");
    await withMode(tla, 0o000, async () => {
      assertDiscoveryError(await run(["--root", root]), tla);
    });
  });

  test(
    "one unreadable model directory among readable ones is an error naming it",
    { skip: rootSkip },
    async () => {
      const root = await rootWith(manifest());
      const locked = path.join(root, "formal", "tla", "zlocked");
      await mkdir(locked);
      await writeFile(
        path.join(locked, "check.json"),
        JSON.stringify(manifest({ name: "zlocked" })),
      );
      await withMode(locked, 0o000, async () => {
        assertDiscoveryError(await run(["--root", root]), locked);
      });
    },
  );

  test(
    "a check.json that exists but cannot be read is an error naming it",
    { skip: rootSkip },
    async () => {
      const root = await rootWith(manifest());
      const file = path.join(root, "formal", "tla", "counter", "check.json");
      await chmod(file, 0o000);
      try {
        assertDiscoveryError(await run(["--root", root]), file);
      } finally {
        await chmod(file, 0o644);
      }
    },
  );

  test("formal/tla as a file is an error naming it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "formal-check-all-tlafile-"));
    roots.push(root);
    await mkdir(path.join(root, "formal"));
    await writeFile(path.join(root, "formal", "tla"), "not a directory\n");
    assertDiscoveryError(await run(["--root", root]), path.join(root, "formal", "tla"));
  });

  test("a dangling symlink in place of a model directory is an error naming it", async () => {
    const root = await rootWith(manifest());
    const ghost = path.join(root, "formal", "tla", "ghost");
    await symlink(path.join(root, "nowhere"), ghost);
    assertDiscoveryError(await run(["--root", root]), ghost);
  });

  test("a dangling symlink in place of check.json is an error naming it", async () => {
    const root = await rootWith(manifest());
    const dir = path.join(root, "formal", "tla", "linked");
    await mkdir(dir);
    await symlink(path.join(root, "nowhere.json"), path.join(dir, "check.json"));
    assertDiscoveryError(await run(["--root", root]), path.join(dir, "check.json"));
  });

  test("control: plain files and manifest-less directories in formal/tla/ are not models", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "formal-check-all-plain-"));
    roots.push(root);
    await mkdir(path.join(root, "formal", "tla", "shared"), { recursive: true });
    await writeFile(path.join(root, "formal", "tla", "README.md"), "notes\n");
    await writeFile(
      path.join(root, "formal", "tla", "shared", "Lib.tla"),
      "---- MODULE Lib ----\n====\n",
    );
    const { code, summary } = await run(["--root", root]);
    assert.equal(code, 0, summary.error ?? "");
    assert.equal(summary.manifests, 0);
  });
});
