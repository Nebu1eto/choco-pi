import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CheckResult,
  checkResult,
} from "../../.pi/skills/formal-verify/scripts/tlc-result.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TLC = path.join(ROOT, ".pi", "skills", "formal-verify", "scripts", "tlc.ts");
const SPECS = path.join(ROOT, "tests", "fixtures", "tlc", "specs");
const JAR = process.env.CHOCO_PI_TLA2TOOLS || path.join(ROOT, "formal", ".tools", "tla2tools.jar");

type Run = { code: number | null; result: CheckResult; elapsedMs: number };

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.CHOCO_PI_TLA2TOOLS;
  if (!extra.CHOCO_PI_JAVA) delete env.CHOCO_PI_JAVA;
  return env;
}

function runTlc(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TLC, "check", ...args], {
      env: cleanEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (!checkResult.check(parsed))
          throw new Error(
            `output does not match the schema: ${JSON.stringify(checkResult.errors(parsed))}`,
          );
        resolve({ code, result: parsed, elapsedMs: Date.now() - started });
      } catch (error) {
        reject(
          new Error(
            `tlc.ts printed no valid result (exit ${code}): ${String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function spec(dir: string, name: string, cfg = name): string[] {
  return [
    "--spec",
    path.join(SPECS, dir, `${name}.tla`),
    "--config",
    path.join(SPECS, dir, `${cfg}.cfg`),
  ];
}

function rule(rules: CheckResult["invariants"], name: string) {
  const found = rules.find((r) => r.name === name);
  assert.ok(found, `missing rule ${name}`);
  return found;
}

async function probeTlc(): Promise<string | undefined> {
  try {
    await access(JAR);
  } catch {
    return `no tla2tools.jar at ${JAR}; run .pi/skills/formal-verify/scripts/tlc-setup.ts --dir formal/.tools or set CHOCO_PI_TLA2TOOLS`;
  }
  const java = await new Promise<boolean>((resolve) => {
    const child = spawn("java", ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
  return java ? undefined : "java is not on PATH";
}

const skipReason = await probeTlc();
if (skipReason) process.stdout.write(`# tlc-run: skipping real-TLC tests: ${skipReason}\n`);

describe("tlc.ts against real TLC", { skip: skipReason ?? false }, () => {
  const jar = ["--jar", JAR];

  test("a model whose rules all hold passes", async () => {
    const dir = path.join(SPECS, "pass");
    const before = await readdir(dir);
    const { code, result } = await runTlc([...spec("pass", "Turnstile"), ...jar]);
    assert.equal(code, 0);
    assert.equal(result.status, "pass");
    assert.deepEqual(
      result.invariants.map((r) => [r.name, r.status]),
      [
        ["TypeOK", "holds"],
        ["Bounded", "holds"],
      ],
    );
    assert.deepEqual(result.properties, [{ name: "LocksAgain", status: "holds" }]);
    assert.deepEqual(result.deadlock, { checked: true, found: false });
    assert.equal(result.stats.distinct, 7);
    assert.match(result.tool.tlcVersion ?? "", /^TLC2 Version 2\.19/);
    assert.ok(result.notes.some((n) => n.includes("fairness")));
    assert.deepEqual(await readdir(dir), before, "nothing is written next to the spec");
  });

  test("each violated invariant gets its own shortest trace", async () => {
    const { code, result } = await runTlc([...spec("violated", "Transfer"), ...jar]);
    assert.equal(code, 3);
    assert.equal(result.status, "violated");
    assert.equal(rule(result.invariants, "TypeOK").status, "holds");
    const conserved = rule(result.invariants, "Conserved");
    assert.equal(conserved.status, "violated");
    assert.deepEqual(
      conserved.trace?.map((s) => [s.index, s.action, s.state]),
      [
        [1, "Initial predicate", { a: 2, b: 0, pc: "idle" }],
        [2, "Withdraw", { a: 1, b: 0, pc: "moving" }],
      ],
    );
    const drained = rule(result.invariants, "NotDrained");
    assert.equal(drained.status, "violated");
    assert.deepEqual(
      drained.trace?.map((s) => s.action),
      ["Initial predicate", "Withdraw", "Deposit", "Withdraw"],
    );
    assert.deepEqual(drained.trace?.at(-1)?.state, { a: 0, b: 1, pc: "moving" });
    const moved = rule(result.properties, "AllMoved");
    assert.equal(moved.status, "violated");
    assert.deepEqual(moved.loop, { kind: "stuttering" });
    assert.equal(result.deadlock.found, true);
    assert.deepEqual(result.deadlock.trace?.at(-1)?.state, { a: 0, b: 2, pc: "idle" });
  });

  test("deadlock variant: found when checked, absent with --no-deadlock", async () => {
    const found = await runTlc([...spec("violated", "Transfer", "TransferDeadlock"), ...jar]);
    assert.equal(found.code, 3);
    assert.equal(found.result.status, "violated");
    assert.equal(found.result.deadlock.found, true);
    assert.equal(found.result.deadlock.trace?.length, 5);
    assert.equal(rule(found.result.invariants, "TypeOK").status, "holds");

    const off = await runTlc([
      ...spec("violated", "Transfer", "TransferDeadlock"),
      ...jar,
      "--no-deadlock",
    ]);
    assert.equal(off.code, 0);
    assert.equal(off.result.status, "pass");
    assert.deepEqual(off.result.deadlock, { checked: false, found: false });
  });

  test("a parse error and a semantic error are errors", async () => {
    const parse = await runTlc([...spec("broken", "Broken"), ...jar]);
    assert.equal(parse.code, 2);
    assert.equal(parse.result.status, "error");
    assert.match(parse.result.errors.join("\n"), /SANY could not parse[\s\S]*Parse Error/);

    const semantic = await runTlc([...spec("broken", "Undefined"), ...jar]);
    assert.equal(semantic.code, 2);
    assert.equal(semantic.result.status, "error");
    assert.match(semantic.result.errors.join("\n"), /Unknown operator/);
  });

  test("hitting the state bound is inconclusive", async () => {
    const { code, result } = await runTlc([
      ...spec("unbounded", "Unbounded"),
      ...jar,
      "--max-states",
      "500",
    ]);
    assert.equal(code, 4);
    assert.equal(result.status, "inconclusive");
    assert.deepEqual(result.invariants, [{ name: "NonNegative", status: "not_checked" }]);
    assert.equal(result.deadlock.checked, false);
    assert.ok(result.notes.some((n) => n.includes("bound of 500")));
  });

  test("running out of time is inconclusive and stops TLC", async () => {
    const { code, result, elapsedMs } = await runTlc([
      ...spec("unbounded", "Unbounded"),
      ...jar,
      "--max-states",
      "1000000000",
      "--timeout-ms",
      "2000",
    ]);
    assert.equal(code, 4);
    assert.equal(result.status, "inconclusive");
    assert.equal(rule(result.invariants, "NonNegative").status, "not_checked");
    assert.ok(result.notes.some((n) => n.includes("2000 ms")));
    assert.ok(elapsedMs < 15_000, `took ${elapsedMs} ms`);
  });
});

describe("tlc.ts with a fake Java", () => {
  let dir = "";
  let java = "";
  const pidFile = () => path.join(dir, "pid");

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tlc-run-test-"));
    java = path.join(dir, "fake-java.ts");
    const source = [
      `#!${process.execPath}`,
      'import { writeFile } from "node:fs/promises";',
      "const args = process.argv.slice(2);",
      "const mode = process.env.FAKE_TLC_MODE;",
      'if (args.includes("-version")) {',
      "  process.stderr.write('openjdk version \"21.0.1\" 2024-01-01\\n');",
      '} else if (args.includes("tla2sany.SANY")) {',
      '  process.stdout.write("Semantic processing of module Turnstile\\n");',
      '} else if (mode === "hang") {',
      '  await writeFile(process.env.FAKE_TLC_PID ?? "", String(process.pid));',
      "  setInterval(() => {}, 1000);",
      "} else {",
      '  process.stdout.write(process.env.FAKE_TLC_OUTPUT ?? "");',
      "  if (process.env.FAKE_TLC_STDERR) process.stderr.write(`${process.env.FAKE_TLC_STDERR}\\n`);",
      "  process.exitCode = Number(process.env.FAKE_TLC_EXIT ?? 0);",
      "}",
      "",
    ].join("\n");
    await writeFile(java, source);
    await chmod(java, 0o755);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fake = (output: string, exit: number, mode = "", stderr = "") =>
    runTlc(
      [
        ...spec("pass", "Turnstile"),
        "--jar",
        path.join(SPECS, "pass", "Turnstile.tla"),
        "--timeout-ms",
        "20000",
      ],
      {
        CHOCO_PI_JAVA: java,
        FAKE_TLC_OUTPUT: output,
        FAKE_TLC_EXIT: String(exit),
        FAKE_TLC_MODE: mode,
        FAKE_TLC_PID: pidFile(),
        FAKE_TLC_STDERR: stderr,
      },
    );

  const msg = (code: number, level: number, ...lines: string[]) =>
    [`@!@!@STARTMSG ${code}:${level} @!@!@`, ...lines, `@!@!@ENDMSG ${code} @!@!@`].join("\n");

  test("garbage output is an error, whatever the exit code", async () => {
    for (const exit of [0, 12]) {
      const { code, result } = await fake("this is not TLC output\n", exit);
      assert.equal(code, 2, `exit ${exit}`);
      assert.equal(result.status, "error");
      assert.ok(result.errors.length > 0);
      assert.ok(result.notes.some((n) => n.includes("not the pinned release")));
    }
  });

  test("exit 0 without TLC's completion message is an error", async () => {
    const output = [
      msg(2199, 0, "7 states generated, 7 distinct states found, 0 states left on queue."),
      msg(2186, 0, "Finished in 1s"),
    ].join("\n");
    const { code, result } = await fake(`${output}\n`, 0);
    assert.equal(code, 2);
    assert.match(result.errors.join("\n"), /without reporting that model checking completed/);
  });

  test("output cut inside a message is an error", async () => {
    const { code, result } = await fake(
      "@!@!@STARTMSG 2193:0 @!@!@\nModel checking completed. No error has been found.\n",
      0,
    );
    assert.equal(code, 2);
    assert.match(result.errors.join("\n"), /ends inside message 2193/);
  });

  test("a violation code that names no rule is an error", async () => {
    const output = [msg(2110, 1, "something else"), msg(2186, 0, "Finished")].join("\n");
    const { code, result } = await fake(`${output}\n`, 12);
    assert.equal(code, 2);
    assert.match(result.errors.join("\n"), /does not name the rule/);
  });

  // A well-formed complete run of Turnstile as TLC prints it; each case below breaks one part.
  const VERSION = msg(2262, 0, "TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)");
  const SUCCESS = msg(2193, 0, "Model checking completed. No error has been found.");
  const STATS = msg(
    2199,
    0,
    "8 states generated, 7 distinct states found, 0 states left on queue.",
  );
  const DEPTH = msg(2194, 0, "The depth of the complete state graph search is 7.");
  const FINISHED = msg(2186, 0, "Finished in 214ms at (2026-11-10 15:39:43)");
  const complete = (...parts: string[]) => `${parts.join("\n")}\n`;

  test("control: a well-formed complete run passes", async () => {
    const { code, result } = await fake(complete(VERSION, SUCCESS, STATS, DEPTH, FINISHED), 0);
    assert.equal(code, 0, JSON.stringify(result.errors));
    assert.equal(result.status, "pass");
  });

  test("the two reviewed inputs are errors, never a pass", async () => {
    const closedBy9999 = SUCCESS.replace("@!@!@ENDMSG 2193 @!@!@", "@!@!@ENDMSG 9999 @!@!@");
    const errorInside = [
      "@!@!@STARTMSG 2193:0 @!@!@",
      "Model checking completed. No error has been found.",
      msg(2111, 1, "Evaluating invariant TypeOK failed."),
      "@!@!@ENDMSG 2193 @!@!@",
    ].join("\n");
    const outcomes: string[] = [];
    for (const success of [closedBy9999, errorInside]) {
      const { code, result } = await fake(complete(VERSION, success, STATS, DEPTH, FINISHED), 0);
      outcomes.push(`${code} ${result.status}`);
    }
    assert.deepEqual(outcomes, ["2 error", "2 error"]);
  });

  test("other malformed or contradictory complete runs are errors", async () => {
    const cases: [string, string, string?][] = [
      [
        "an ENDMSG with nothing open",
        complete(VERSION, SUCCESS, "@!@!@ENDMSG 2193 @!@!@", STATS, DEPTH, FINISHED),
      ],
      [
        "a level outside TLC's range",
        complete(VERSION, SUCCESS.replace("2193:0", "2193:9"), STATS, DEPTH, FINISHED),
      ],
      ["the success message twice", complete(VERSION, SUCCESS, SUCCESS, STATS, DEPTH, FINISHED)],
      ["the finished message twice", complete(VERSION, SUCCESS, STATS, DEPTH, FINISHED, FINISHED)],
      ["finished before success", complete(VERSION, STATS, DEPTH, FINISHED, SUCCESS)],
      ["no statistics", complete(VERSION, SUCCESS, DEPTH, FINISHED)],
      [
        "unreadable statistics",
        complete(VERSION, SUCCESS, msg(2199, 0, "many states generated"), DEPTH, FINISHED),
      ],
      ["statistics twice", complete(VERSION, SUCCESS, STATS, STATS, DEPTH, FINISHED)],
      [
        "a message after finished",
        complete(VERSION, SUCCESS, STATS, DEPTH, FINISHED, msg(2200, 0, "Progress")),
      ],
      [
        "text after finished",
        complete(VERSION, SUCCESS, STATS, DEPTH, FINISHED, "Exception in thread main"),
      ],
      [
        "a trace state with no violation",
        complete(
          VERSION,
          msg(2217, 4, "1: <Initial predicate>", "x = 0"),
          SUCCESS,
          STATS,
          DEPTH,
          FINISHED,
        ),
      ],
      [
        "unexpected stderr",
        complete(VERSION, SUCCESS, STATS, DEPTH, FINISHED),
        "java.lang.OutOfMemoryError: Java heap space",
      ],
    ];
    const accepted: string[] = [];
    for (const [label, output, stderr] of cases) {
      const { code, result } = await fake(output, 0, "", stderr);
      if (code !== 2 || result.status !== "error")
        accepted.push(`${label}: exit ${code}, ${result.status}`);
    }
    assert.deepEqual(accepted, [], "every malformed run must be an error");
  });

  test("a JVM option notice on stderr does not spoil a complete run", async () => {
    const notice = "Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8";
    const { code, result } = await fake(
      complete(VERSION, SUCCESS, STATS, DEPTH, FINISHED),
      0,
      "",
      notice,
    );
    assert.equal(code, 0, JSON.stringify(result.errors));
  });

  test("a hung TLC is killed at the time limit", async () => {
    const { code, result, elapsedMs } = await runTlc(
      [
        ...spec("pass", "Turnstile"),
        "--jar",
        path.join(SPECS, "pass", "Turnstile.tla"),
        "--timeout-ms",
        "1500",
      ],
      { CHOCO_PI_JAVA: java, FAKE_TLC_MODE: "hang", FAKE_TLC_PID: pidFile() },
    );
    assert.equal(code, 4);
    assert.equal(result.status, "inconclusive");
    assert.ok(elapsedMs < 10_000, `took ${elapsedMs} ms`);
    const pid = Number(await readFile(pidFile(), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the fake TLC process is gone");
  });

  test("a missing jar is an error that names the setup command by absolute path", async () => {
    const { code, result } = await runTlc([...spec("pass", "Turnstile"), "--tools-dir", dir], {
      CHOCO_PI_JAVA: java,
    });
    assert.equal(code, 2);
    const setup = path.join(ROOT, ".pi", "skills", "formal-verify", "scripts", "tlc-setup.ts");
    assert.ok(
      result.errors.join("\n").includes(`run node ${setup} --dir ${dir}`),
      result.errors.join("\n"),
    );
  });

  test("Java missing from PATH is an error that says what to install", async () => {
    const { code, result } = await runTlc(
      [...spec("pass", "Turnstile"), "--jar", path.join(SPECS, "pass", "Turnstile.tla")],
      { PATH: dir },
    );
    assert.equal(code, 2);
    const errors = result.errors.join("\n");
    assert.match(errors, /cannot run Java/);
    assert.match(errors, /Java 11 or newer: install a JDK or JRE/);
    assert.match(errors, /CHOCO_PI_JAVA/);
  });

  test("a Java older than 11 is an error that says what to install", async () => {
    const old = path.join(dir, "old-java.ts");
    await writeFile(
      old,
      `#!${process.execPath}\nprocess.stderr.write('java version "1.8.0_402"\\n');\n`,
    );
    await chmod(old, 0o755);
    const { code, result } = await runTlc(
      [...spec("pass", "Turnstile"), "--jar", path.join(SPECS, "pass", "Turnstile.tla")],
      { CHOCO_PI_JAVA: old },
    );
    assert.equal(code, 2);
    assert.match(
      result.errors.join("\n"),
      /Java 8 is too old\. TLC needs Java 11 or newer: install/,
    );
  });

  test("a config rule list it cannot read is an error", async () => {
    const cfg = path.join(dir, "Bad.cfg");
    await writeFile(cfg, "SPECIFICATION Spec\nINVARIANT TypeOK, Bounded\n");
    const { code, result } = await runTlc(
      [
        "--spec",
        path.join(SPECS, "pass", "Turnstile.tla"),
        "--config",
        cfg,
        "--jar",
        path.join(SPECS, "pass", "Turnstile.tla"),
      ],
      { CHOCO_PI_JAVA: java },
    );
    assert.equal(code, 2);
    assert.match(result.errors.join("\n"), /list operator names separated by spaces/);
  });
});
