import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseCoverage } from "../../.pi/skills/formal-verify/scripts/drift-coverage.ts";
import {
  extractSymbol,
  hashText,
  locateSymbol,
  parseSources,
} from "../../.pi/skills/formal-verify/scripts/drift-extract.ts";
import { main } from "../../.pi/skills/formal-verify/scripts/drift.ts";
import { findFormalRoot } from "../../.pi/skills/formal-verify/scripts/formal-root.ts";

const execFileAsync = promisify(execFile);
const DRIFT_CLI = join(
  import.meta.dirname,
  "..",
  "..",
  ".pi",
  "skills",
  "formal-verify",
  "scripts",
  "drift.ts",
);
const AGENT_MANAGER = join(
  import.meta.dirname,
  "..",
  "..",
  ".pi",
  "packages",
  "choco-pi-subagents",
  "src",
  "agent-manager.ts",
);

const SAMPLE_ADD = [
  "public add(n: number): number {",
  "    this.count += n; // closing } in a comment",
  "    return this.count;",
  "  }",
].join("\n");

const SAMPLE_LOAD = [
  "async load(): Promise<string> {",
  "    const re = /[}{]/g;",
  '    return `${await Promise.resolve("{")}${re.source}}`;',
  "  }",
].join("\n");

const FIXTURE = [
  "// header comment with a } brace",
  "export function plain(a: number): number {",
  '  const s = "}{"; // }',
  "  return a + s.length;",
  "}",
  "",
  "export const arrow = (x: string): string => `${x}-${\"}\"}` + '{';",
  "",
  "export class Sample {",
  "  private count = 0;",
  "  /* block comment { */",
  `  ${SAMPLE_ADD}`,
  "  private reset(): void {",
  "    this.count = 0;",
  "  }",
  "  static create(): Sample {",
  "    return new Sample();",
  "  }",
  `  ${SAMPLE_LOAD}`,
  "  #secret(): number {",
  "    return 1;",
  "  }",
  "}",
  "",
  "export class Other {",
  "  add(n: number): number {",
  "    return n;",
  "  }",
  "}",
  "",
  "export function over(a: string): string;",
  "export function over(a: number): number;",
  "export function over(a: string | number): string | number {",
  "  return a;",
  "}",
  "",
].join("\n");

const SYMBOLS = [
  "plain",
  "arrow",
  "Sample.count",
  "Sample.add",
  "Sample.reset",
  "Sample.create",
  "Sample.load",
  "Sample.#secret",
  "Other.add",
  "over",
] as const;

const COVERAGE_PATH = "formal/property/sample/coverage.json";

function coverageFor(covers: readonly { file: string; symbol?: string; hash: string }[]): string {
  return `${JSON.stringify(
    {
      schema: 1,
      name: "sample",
      kind: "property",
      artifact: "tests/sample.property.test.ts",
      command: "node --test tests/sample.property.test.ts",
      covers,
      assumes: [{ note: "runs on Node 24", file: "src/assumed.ts" }],
      checkedAt: { commit: "pending" },
    },
    null,
    2,
  )}\n`;
}

const DEFAULT_COVERS = [
  ...SYMBOLS.map((symbol) => ({ file: "src/sample.ts", symbol, hash: "pending" })),
  { file: "src/sample.ts", hash: "pending" },
];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=drift-test",
      "-c",
      "user.email=drift@test.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  return stdout;
}

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
}

async function makeRepo(
  t: test.TestContext,
  coverage = coverageFor(DEFAULT_COVERS),
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "formal-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRepoFile(root, "src/sample.ts", FIXTURE);
  await writeRepoFile(root, "src/assumed.ts", "export const assumed = 1;\n");
  await writeRepoFile(root, COVERAGE_PATH, coverage);
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", "fixture"]);
  return root;
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(root: string, argv: readonly string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd: root,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

interface EntryView {
  readonly file: string;
  readonly symbol?: string;
  readonly status: string;
  readonly reason?: string;
}

function entryStatuses(stdout: string): Map<string, string> {
  const report: { declarations: { entries: EntryView[] }[] } = JSON.parse(stdout);
  const statuses = new Map<string, string>();
  for (const entry of report.declarations[0]?.entries ?? []) {
    statuses.set(entry.symbol ?? `file:${entry.file}`, entry.status);
  }
  return statuses;
}

async function editFixture(root: string, edit: (text: string) => string): Promise<void> {
  const path = join(root, "src/sample.ts");
  const before = await readFile(path, "utf8");
  const after = edit(before);
  assert.notEqual(after, before, "fixture edit must change the file");
  await writeFile(path, after, "utf8");
}

test("hash normalises line endings and trailing whitespace but not indentation", () => {
  const base = "function f() {\n  return 1;\n}";
  assert.equal(hashText(base.replaceAll("\n", "\r\n")), hashText(base));
  assert.equal(hashText(base.replaceAll("\n", "\r")), hashText(base));
  assert.equal(hashText("function f() {  \n  return 1;\t\n}"), hashText(base));
  assert.notEqual(hashText("function f() {\n    return 1;\n}"), hashText(base));
  assert.match(hashText(base), /^sha256:[0-9a-f]{64}$/u);
});

test("extractor returns exact declaration text across strings, templates, regexes and comments", async () => {
  const parsed = (
    await parseSources(new Map([["fixture", { fileName: "sample.ts", text: FIXTURE }]]))
  ).get("fixture");
  assert.ok(parsed?.ok, "fixture parses");
  const text = (symbol: string): string => {
    const located = locateSymbol(parsed.sourceFile, symbol);
    assert.ok(located.ok, `${symbol}: ${located.ok ? "" : located.reason}`);
    return located.text;
  };
  assert.equal(text("Sample.add"), SAMPLE_ADD);
  assert.equal(text("Sample.load"), SAMPLE_LOAD);
  assert.equal(text("Other.add"), "add(n: number): number {\n    return n;\n  }");
  assert.equal(text("Sample.count"), "private count = 0;");
  assert.equal(text("Sample.#secret"), "#secret(): number {\n    return 1;\n  }");
  assert.equal(text("Sample.create"), "static create(): Sample {\n    return new Sample();\n  }");
  assert.equal(
    text("plain"),
    FIXTURE.slice(FIXTURE.indexOf("export function plain"), FIXTURE.indexOf("\n\nexport const")),
  );
  assert.equal(text("arrow"), "export const arrow = (x: string): string => `${x}-${\"}\"}` + '{';");
  const overloads = text("over");
  assert.ok(overloads.startsWith("export function over(a: string): string;"));
  assert.ok(overloads.endsWith("  return a;\n}"));
  for (const symbol of SYMBOLS) text(symbol);
});

test("extractor reports missing, ambiguous and unparseable symbols as errors", async () => {
  const missing = await extractSymbol("sample.ts", FIXTURE, "Sample.nope");
  assert.equal(missing.ok, false);
  const twice = "function dup() { return 1; }\nfunction dup() { return 2; }\n";
  const ambiguous = await extractSymbol("dup.ts", twice, "dup");
  assert.ok(!ambiguous.ok && ambiguous.reason.startsWith("ambiguous"));
  const staticAndInstance = "class K {\n  static m() {}\n  m() {}\n}\n";
  const mixed = await extractSymbol("k.ts", staticAndInstance, "K.m");
  assert.ok(!mixed.ok && mixed.reason.startsWith("ambiguous"));
  const broken = await extractSymbol("broken.ts", "function f( {\n", "f");
  assert.ok(!broken.ok && broken.reason.startsWith("syntax errors"));
});

async function symbolHash(
  source: string,
  symbol: string,
  fileName = "subject.ts",
): Promise<string> {
  const located = await extractSymbol(fileName, source, symbol);
  assert.ok(located.ok, `${symbol}: ${located.ok ? "" : located.reason}`);
  return hashText(located.text);
}

test("a declarator in a multi-variable statement hashes the statement keyword and modifiers", async () => {
  const recorded = await symbolHash("export const a = 1, b = 2;\n", "a");
  assert.notEqual(await symbolHash("export let a = 1, b = 2;\n", "a"), recorded, "const -> let");
  assert.notEqual(await symbolHash("const a = 1, b = 2;\n", "a"), recorded, "export removed");
  assert.equal(await symbolHash("export const a = 1, b = 3;\n", "a"), recorded, "sibling change");
  assert.notEqual(
    await symbolHash("export const a = 2, b = 2;\n", "a"),
    recorded,
    "own initialiser",
  );
});

interface HashCase {
  readonly label: string;
  readonly symbol: string;
  readonly before: string;
  readonly after: string;
  /** true: the edit must change the hash; false: documented out-of-scope edit that must not. */
  readonly changes: boolean;
}

const HASH_CASES: readonly HashCase[] = [
  {
    label: "export default removed",
    symbol: "f",
    before: "export default function f() {}",
    after: "function f() {}",
    changes: true,
  },
  {
    label: "export default class",
    symbol: "C",
    before: "export default class C {}",
    after: "export class C {}",
    changes: true,
  },
  {
    label: "abstract class",
    symbol: "C",
    before: "export abstract class C {}",
    after: "export class C {}",
    changes: true,
  },
  {
    label: "declare removed",
    symbol: "x",
    before: "declare let x: number;",
    after: "let x: number;",
    changes: true,
  },
  {
    label: "declare removed, multi",
    symbol: "a",
    before: "declare let a: number, b: number;",
    after: "let a: number, b: number;",
    changes: true,
  },
  {
    label: "var to let, multi",
    symbol: "b",
    before: "var a = 1, b = 2;",
    after: "let a = 1, b = 2;",
    changes: true,
  },
  {
    label: "static removed",
    symbol: "K.s",
    before: "class K { static s() {} }",
    after: "class K { s() {} }",
    changes: true,
  },
  {
    label: "readonly removed",
    symbol: "K.x",
    before: "class K { static readonly x = 1; }",
    after: "class K { static x = 1; }",
    changes: true,
  },
  {
    label: "accessibility",
    symbol: "K.m",
    before: "class K { private m() {} }",
    after: "class K { public m() {} }",
    changes: true,
  },
  {
    label: "abstract member",
    symbol: "K.m",
    before: "abstract class K { abstract m(): void; }",
    after: "abstract class K { m(): void; }",
    changes: true,
  },
  {
    label: "accessor keyword",
    symbol: "K.v",
    before: "class K { accessor v = 1; }",
    after: "class K { v = 1; }",
    changes: true,
  },
  {
    label: "override",
    symbol: "K.m",
    before: "class K extends B { override m() {} }",
    after: "class K extends B { m() {} }",
    changes: true,
  },
  {
    label: "member decorator",
    symbol: "K.m",
    before: "class K {\n  @dec\n  m() {}\n}",
    after: "class K {\n  m() {}\n}",
    changes: true,
  },
  {
    label: "class decorator",
    symbol: "K",
    before: "@dec\nclass K {}",
    after: "class K {}",
    changes: true,
  },
  {
    label: "async method",
    symbol: "K.m",
    before: "class K { async m() {} }",
    after: "class K { m() {} }",
    changes: true,
  },
  {
    label: "generator method",
    symbol: "K.m",
    before: "class K { *m() {} }",
    after: "class K { m() {} }",
    changes: true,
  },
  {
    label: "async function",
    symbol: "f",
    before: "async function f() {}",
    after: "function f() {}",
    changes: true,
  },
  {
    label: "generator function",
    symbol: "f",
    before: "function* f() {}",
    after: "function f() {}",
    changes: true,
  },
  {
    label: "setter of a get/set pair",
    symbol: "K.g",
    before: "class K {\n  get g() { return 1; }\n  set g(v: number) {}\n}",
    after: "class K {\n  get g() { return 1; }\n  set g(v: number) { void v; }\n}",
    changes: true,
  },
  {
    label: "overload signature",
    symbol: "o",
    before: "function o(a: string): string;\nfunction o(a: unknown) { return a; }",
    after: "function o(a: number): number;\nfunction o(a: unknown) { return a; }",
    changes: true,
  },
  // Out of scope by design: a member entry covers the member, not its class's
  // heritage (cover the class itself for that), and export lists separate from
  // the declaration are not part of its text.
  {
    label: "heritage, member entry",
    symbol: "K.m",
    before: "class K extends A { m() {} }",
    after: "class K extends B { m() {} }",
    changes: false,
  },
  {
    label: "heritage, class entry",
    symbol: "K",
    before: "class K extends A { m() {} }",
    after: "class K extends B { m() {} }",
    changes: true,
  },
  {
    label: "separate export list",
    symbol: "a",
    before: "const a = 1;\nexport { a };",
    after: "const a = 1;",
    changes: false,
  },
];

test("hashed text covers keywords, modifiers, decorators and markers of every declaration form", async () => {
  const sources = new Map<string, { fileName: string; text: string }>();
  HASH_CASES.forEach((item, index) => {
    sources.set(`${index}:before`, { fileName: "case.ts", text: `${item.before}\n` });
    sources.set(`${index}:after`, { fileName: "case.ts", text: `${item.after}\n` });
  });
  const parsed = await parseSources(sources);
  const hashOf = (key: string, symbol: string): string => {
    const outcome = parsed.get(key);
    assert.ok(outcome?.ok, `${key}: ${outcome?.ok === false ? outcome.reason : "not parsed"}`);
    const located = locateSymbol(outcome.sourceFile, symbol);
    assert.ok(located.ok, `${key} ${symbol}: ${located.ok ? "" : located.reason}`);
    return hashText(located.text);
  };
  HASH_CASES.forEach((item, index) => {
    const before = hashOf(`${index}:before`, item.symbol);
    const after = hashOf(`${index}:after`, item.symbol);
    assert.equal(before !== after, item.changes, item.label);
  });
});

test("destructured declarations are not resolvable symbols", async () => {
  const located = await extractSymbol("d.ts", "const { a, b } = { a: 1, b: 2 };\n", "a");
  assert.equal(located.ok, false);
});

test("check reports pending, update records hashes, then check is fresh", async (t) => {
  const root = await makeRepo(t);
  const pending = await run(root, ["check"]);
  assert.equal(pending.code, 3, pending.stderr);
  assert.ok([...entryStatuses(pending.stdout).values()].every((status) => status === "pending"));

  const updated = await run(root, ["update", "--file", COVERAGE_PATH]);
  assert.equal(updated.code, 0, updated.stderr);
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  const written = await readFile(join(root, COVERAGE_PATH), "utf8");
  assert.ok(written.endsWith("}\n"));
  const record: { checkedAt: { commit: string }; covers: { hash: string }[] } = JSON.parse(written);
  assert.equal(written, `${JSON.stringify(record, null, 2)}\n`);
  assert.deepEqual(
    Object.keys(JSON.parse(written)),
    Object.keys(JSON.parse(coverageFor(DEFAULT_COVERS))),
  );
  assert.equal(record.checkedAt.commit, head);
  assert.ok(record.covers.every((entry) => /^sha256:[0-9a-f]{64}$/u.test(entry.hash)));

  const fresh = await run(root, ["check"]);
  assert.equal(fresh.code, 0, fresh.stdout);
  const report: { declarations: { status: string }[] } = JSON.parse(fresh.stdout);
  assert.equal(report.declarations[0]?.status, "fresh");
});

test("a one-character change in a method makes only that entry and the whole file stale", async (t) => {
  const root = await makeRepo(t);
  assert.equal((await run(root, ["update", "--file", COVERAGE_PATH])).code, 0);
  await editFixture(root, (text) => text.replace("this.count += n;", "this.count -= n;"));
  const result = await run(root, ["check"]);
  assert.equal(result.code, 3);
  const statuses = entryStatuses(result.stdout);
  assert.equal(statuses.get("Sample.add"), "stale");
  assert.equal(statuses.get("file:src/sample.ts"), "stale");
  for (const symbol of SYMBOLS.filter((name) => name !== "Sample.add")) {
    assert.equal(statuses.get(symbol), "fresh", symbol);
  }
});

test("a change outside covered symbols leaves symbol entries fresh but the whole-file entry stale", async (t) => {
  const root = await makeRepo(t);
  assert.equal((await run(root, ["update", "--file", COVERAGE_PATH])).code, 0);
  await editFixture(root, (text) => `${text}export const unrelated = 2;\n`);
  const result = await run(root, ["check"]);
  assert.equal(result.code, 3);
  const statuses = entryStatuses(result.stdout);
  assert.equal(statuses.get("file:src/sample.ts"), "stale");
  for (const symbol of SYMBOLS) assert.equal(statuses.get(symbol), "fresh", symbol);
});

test("CRLF conversion keeps entries fresh", async (t) => {
  const root = await makeRepo(t);
  assert.equal((await run(root, ["update", "--file", COVERAGE_PATH])).code, 0);
  await editFixture(root, (text) => text.replaceAll("\n", "\r\n"));
  const result = await run(root, ["check"]);
  assert.equal(result.code, 0, result.stdout);
});

test("missing symbols and files are reported missing, and update refuses to write", async (t) => {
  const covers = [
    { file: "src/sample.ts", symbol: "Sample.nope", hash: "pending" },
    { file: "src/absent.ts", hash: "pending" },
    { file: "src/sample.ts", symbol: "plain", hash: "pending" },
  ];
  const root = await makeRepo(t, coverageFor(covers));
  const result = await run(root, ["check"]);
  assert.equal(result.code, 3);
  const statuses = entryStatuses(result.stdout);
  assert.equal(statuses.get("Sample.nope"), "missing");
  assert.equal(statuses.get("file:src/absent.ts"), "missing");
  assert.equal(statuses.get("plain"), "pending");
  const before = await readFile(join(root, COVERAGE_PATH), "utf8");
  const update = await run(root, ["update", "--file", COVERAGE_PATH]);
  assert.equal(update.code, 3);
  assert.equal(await readFile(join(root, COVERAGE_PATH), "utf8"), before);
});

test("malformed declarations exit 2", async (t) => {
  const root = await makeRepo(t);
  await writeRepoFile(
    root,
    "formal/tla/bad/coverage.json",
    '{ "schema": 1, "name": "bad", "kind": "model" }\n',
  );
  await writeRepoFile(root, "formal/tla/broken/coverage.json", "{ not json\n");
  const result = await run(root, ["check"]);
  assert.equal(result.code, 2);
  const report: { declarations: { path: string; status: string; error?: string }[] } = JSON.parse(
    result.stdout,
  );
  const byPath = new Map(report.declarations.map((declaration) => [declaration.path, declaration]));
  assert.equal(byPath.get("formal/tla/bad/coverage.json")?.status, "error");
  assert.equal(byPath.get("formal/tla/broken/coverage.json")?.status, "error");

  assert.equal(parseCoverage(coverageFor([{ file: "../outside.ts", hash: "pending" }])).ok, false);
  assert.equal(
    parseCoverage(coverageFor([{ file: "src/a.ts", symbol: "a.b.c", hash: "pending" }])).ok,
    false,
  );
  assert.equal(parseCoverage(coverageFor([])).ok, false);
  assert.equal(parseCoverage(coverageFor(DEFAULT_COVERS)).ok, true);
});

test("a symbol entry in a language without an extractor is malformed and names the whole-file fallback", async (t) => {
  const root = await makeRepo(
    t,
    coverageFor([{ file: "src/lease.py", symbol: "LeaseKeeper.renew", hash: "pending" }]),
  );
  await writeRepoFile(
    root,
    "src/lease.py",
    "class LeaseKeeper:\n    def renew(self):\n        pass\n",
  );
  const result = await run(root, ["check"]);
  assert.equal(result.code, 2, result.stdout);
  const report: { declarations: { status: string; error?: string }[] } = JSON.parse(result.stdout);
  assert.equal(report.declarations[0]?.status, "error");
  assert.match(report.declarations[0]?.error ?? "", /TypeScript or JavaScript/u);
  assert.match(
    report.declarations[0]?.error ?? "",
    /remove "symbol" to hash the whole of "src\/lease\.py"/u,
  );
  const affected = await run(root, ["affected", "--files", "src/lease.py"]);
  assert.equal(affected.code, 2, affected.stdout);
});

test("a whole-file entry works for a file in any language", async (t) => {
  const root = await makeRepo(t, coverageFor([{ file: "src/lease.py", hash: "pending" }]));
  await writeRepoFile(root, "src/lease.py", "def renew():\n    return True\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "--quiet", "-m", "python"]);
  assert.equal((await run(root, ["update", "--file", COVERAGE_PATH])).code, 0);
  assert.equal((await run(root, ["check"])).code, 0);
  await writeRepoFile(root, "src/lease.py", "def renew():\n    return False\n");
  const result = await run(root, ["check"]);
  assert.equal(result.code, 3);
  assert.equal(entryStatuses(result.stdout).get("file:src/lease.py"), "stale");
});

test("from a subdirectory the root is the nearest parent with formal/", async (t) => {
  const root = await makeRepo(t);
  const io = (cwd: string) => {
    const out = { stdout: "", stderr: "" };
    return {
      out,
      io: {
        cwd,
        stdout: (text: string) => {
          out.stdout += text;
        },
        stderr: (text: string) => {
          out.stderr += text;
        },
      },
    };
  };
  const check = io(join(root, "src"));
  assert.equal(await main(["check"], check.io), 3, check.out.stderr);
  const report: { root: string; declarations: unknown[] } = JSON.parse(check.out.stdout);
  assert.equal(report.root, root);
  assert.equal(report.declarations.length, 1);
  const affected = io(join(root, "src"));
  assert.equal(await main(["affected", "--files", "sample.ts"], affected.io), 3);
  assert.deepEqual(JSON.parse(affected.out.stdout).files, ["src/sample.ts"]);
});

test("a project with no formal/ gets a short error; an empty formal/ has nothing to report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formal-drift-bare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRepoFile(root, "src/app.py", "print(1)\n");
  await git(root, ["init", "--quiet"]);
  const bare = await run(join(root, "src"), ["affected", "--files", "app.py"]);
  assert.equal(bare.code, 2);
  assert.match(
    bare.stderr,
    /no formal\/ directory in .* or its parents up to the repository root/u,
  );
  assert.doesNotMatch(bare.stderr, /Usage:/u);
  await mkdir(join(root, "formal"));
  const empty = await run(join(root, "src"), ["check"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).declarations.length, 0);
});

test("affected lists declarations covering explicit files with per-symbol change", async (t) => {
  const root = await makeRepo(t);
  assert.equal((await run(root, ["update", "--file", COVERAGE_PATH])).code, 0);

  const unrelated = await run(root, ["affected", "--files", "src/other.ts"]);
  assert.equal(unrelated.code, 0, unrelated.stdout);
  assert.deepEqual(JSON.parse(unrelated.stdout).declarations, []);

  await editFixture(root, (text) => text.replace("this.count = 0;\n  }", "this.count = 1;\n  }"));
  const affected = await run(root, ["affected", "--files", "src/sample.ts", "src/assumed.ts"]);
  assert.equal(affected.code, 3);
  const report: {
    declarations: {
      name: string;
      changed: boolean;
      matches: { symbol?: string; via: string; changed: boolean | null }[];
    }[];
  } = JSON.parse(affected.stdout);
  assert.equal(report.declarations.length, 1);
  const declaration = report.declarations[0];
  assert.equal(declaration?.name, "sample");
  assert.equal(declaration?.changed, true);
  const changed = new Map(
    declaration?.matches.map((match) => [match.symbol ?? match.via, match.changed]),
  );
  assert.equal(changed.get("Sample.reset"), true);
  assert.equal(changed.get("Sample.add"), false);
  assert.equal(changed.get("covers"), true);
  assert.equal(changed.get("assumes"), null);
});

test("affected --base includes uncommitted and untracked changes", async (t) => {
  const root = await makeRepo(t);
  const clean = await run(root, ["affected", "--base", "HEAD"]);
  assert.equal(clean.code, 0, clean.stderr);
  await writeRepoFile(root, "src/new.ts", "export {};\n");
  assert.equal((await run(root, ["affected", "--base", "HEAD"])).code, 0);
  await editFixture(root, (text) => `${text}// trailing note\n`);
  const dirty = await run(root, ["affected", "--base", "HEAD"]);
  assert.equal(dirty.code, 3);
  assert.deepEqual(JSON.parse(dirty.stdout).files, ["src/new.ts", "src/sample.ts"]);
});

test("CLI exit codes through a child process", async (t) => {
  const root = await makeRepo(t);
  const runCli = async (args: readonly string[]): Promise<number> => {
    try {
      await execFileAsync(process.execPath, [DRIFT_CLI, ...args], { cwd: root, encoding: "utf8" });
      return 0;
    } catch (error) {
      if (error instanceof Error && "code" in error && Number.isInteger(error.code))
        return Number(error.code);
      throw error;
    }
  };
  assert.equal(await runCli(["check"]), 3);
  assert.equal(await runCli(["update", "--file", COVERAGE_PATH]), 0);
  assert.equal(await runCli(["check"]), 0);
  assert.equal(await runCli(["check", "--bogus"]), 2);
  assert.equal(await runCli(["affected"]), 2);
  assert.equal(await runCli(["check", "--root", join(root, "src")]), 2);
  const help = await execFileAsync(process.execPath, [DRIFT_CLI, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /only after the artefact has been re-run/iu);
  assert.match(help.stdout, /TEXTUAL change only|textual change/iu);
});

test("AgentManager.transition extracts from its declaration to its closing brace", async () => {
  const source = await readFile(AGENT_MANAGER, "utf8");
  const located = await extractSymbol(AGENT_MANAGER, source, "AgentManager.transition");
  assert.ok(located.ok, located.ok ? "" : located.reason);
  const start = source.indexOf("  private transition(record: AgentRecord") + 2;
  assert.ok(start > 2);
  const end = source.indexOf("\n  }\n", start) + "\n  }".length;
  assert.equal(located.start, start);
  assert.equal(located.end, end);
  assert.equal(located.text, source.slice(start, end));
  assert.ok(located.text.startsWith("private transition("));
  assert.ok(located.text.endsWith("}"));
});

/** A pattern matching `text` literally. */
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

const ROOT_SKIP = process.getuid?.() === 0 ? "running as root, which ignores file modes" : false;

/** Run `body` with `target` at `mode`, restoring `restore` afterwards so cleanup works. */
async function withMode(
  target: string,
  mode: number,
  restore: number,
  body: () => Promise<void>,
): Promise<void> {
  await chmod(target, mode);
  try {
    await body();
  } finally {
    await chmod(target, restore);
  }
}

test(
  "an unreadable formal/ is an error naming it, for check and affected",
  { skip: ROOT_SKIP },
  async (t) => {
    const root = await makeRepo(t);
    const formal = join(root, "formal");
    await withMode(formal, 0o000, 0o755, async () => {
      for (const argv of [["check"], ["affected", "--files", "src/sample.ts"]]) {
        const result = await run(root, argv);
        assert.equal(result.code, 2, `${argv.join(" ")}: ${result.stdout}`);
        assert.ok(result.stderr.includes(formal), result.stderr);
      }
    });
  },
);

test(
  "an unreadable directory below formal/ is an error naming it",
  { skip: ROOT_SKIP },
  async (t) => {
    const root = await makeRepo(t);
    const locked = join(root, "formal", "tla", "locked");
    await writeRepoFile(root, "formal/tla/locked/coverage.json", coverageFor(DEFAULT_COVERS));
    await withMode(locked, 0o000, 0o755, async () => {
      const result = await run(root, ["check"]);
      assert.equal(result.code, 2, result.stdout);
      assert.ok(result.stderr.includes(locked), result.stderr);
    });
  },
);

test(
  "an unreadable coverage.json is a declaration error, not skipped",
  { skip: ROOT_SKIP },
  async (t) => {
    const root = await makeRepo(t);
    const file = join(root, COVERAGE_PATH);
    await withMode(file, 0o000, 0o644, async () => {
      const result = await run(root, ["check"]);
      assert.equal(result.code, 2, result.stdout);
      const report: { declarations: { path: string; status: string; error?: string }[] } =
        JSON.parse(result.stdout);
      assert.equal(report.declarations[0]?.path, COVERAGE_PATH);
      assert.equal(report.declarations[0]?.status, "error");
      assert.match(report.declarations[0]?.error ?? "", /EACCES/u);
    });
  },
);

test("a coverage.json that is a symlink is an error naming it, dangling or not", async (t) => {
  for (const target of ["sample/coverage.json", "nowhere.json"]) {
    const root = await makeRepo(t);
    const link = join(root, "formal", "tla", "linked", "coverage.json");
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(root, "formal", "property", target), link);
    const result = await run(root, ["check"]);
    assert.equal(result.code, 2, `${target}: ${result.stdout}`);
    assert.ok(result.stderr.includes(link), result.stderr);
  }
});

test(
  "the root search reports a directory it cannot inspect instead of skipping it",
  { skip: ROOT_SKIP },
  async (t) => {
    const base = await mkdtemp(join(tmpdir(), "formal-root-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(base, "formal"));
    await mkdir(join(base, "a", "b"), { recursive: true });
    await withMode(join(base, "a"), 0o600, 0o755, async () => {
      await assert.rejects(findFormalRoot(join(base, "a", "b"), undefined), {
        message: literal(`cannot inspect ${join(base, "a", "b", "formal")}: `),
      });
    });
  },
);
