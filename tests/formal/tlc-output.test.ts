import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  readModelConfig,
  runConfig,
} from "../../.pi/skills/formal-verify/scripts/tlc-config.ts";
import {
  EC,
  completeRunProblem,
  hasMessage,
  parseState,
  parseValue,
  readBreak,
  readFailures,
  readMessages,
  readStats,
  readTrace,
  readVersion,
  unexpectedStderr,
} from "../../.pi/skills/formal-verify/scripts/tlc-output.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tlc");

async function fixture(name: string) {
  const { parts, malformed } = readMessages(await readFile(path.join(FIXTURES, name), "utf8"));
  assert.equal(malformed, undefined, `${name} should parse completely`);
  return parts;
}

describe("parseValue", () => {
  test("reads the values TLC prints", () => {
    assert.equal(parseValue("TRUE"), true);
    assert.equal(parseValue("-42"), -42);
    assert.equal(parseValue('"a\\"b\\nc"'), 'a"b\nc');
    assert.deepEqual(parseValue("r1"), { kind: "model", name: "r1" });
    assert.deepEqual(parseValue("1..3"), { kind: "interval", lo: 1, hi: 3 });
    assert.deepEqual(parseValue("{1, 2}"), { kind: "set", members: [1, 2] });
    assert.deepEqual(parseValue("<<>>"), {
      kind: "function",
      printedAs: "tuple",
      keys: [],
      values: [],
    });
    assert.deepEqual(parseValue('[a |-> 1, b |-> {"x"}]'), {
      kind: "function",
      printedAs: "record",
      keys: ["a", "b"],
      values: [1, { kind: "set", members: ["x"] }],
    });
    assert.deepEqual(parseValue('(r1 :> "working" @@ r2 :> <<1>>)'), {
      kind: "function",
      printedAs: "pairs",
      keys: [
        { kind: "model", name: "r1" },
        { kind: "model", name: "r2" },
      ],
      values: ["working", { kind: "function", printedAs: "tuple", keys: [1], values: [1] }],
    });
  });

  test("refuses text it does not understand", () => {
    for (const text of ["", "{1, 2", "[a |-> ]", "1 2", "LAMBDA x: x", '"open', "(a :> 1"])
      assert.throws(() => parseValue(text), /cannot read TLA\+ value/, text);
  });
});

describe("parseState", () => {
  test("reads one or several variables and keeps unreadable values raw", () => {
    assert.deepEqual(parseState("x = 0"), { x: 0 });
    assert.deepEqual(parseState('/\\ a = 1\n/\\ b = [k |-> "v"]\n/\\ f = LAMBDA y: y'), {
      a: 1,
      b: { kind: "function", printedAs: "record", keys: ["k"], values: ["v"] },
      f: { kind: "raw", text: "LAMBDA y: y" },
    });
  });

  test("stores a variable named __proto__ as data", () => {
    const state = parseState("/\\ __proto__ = 1\n/\\ y = 2");
    assert.deepEqual(Object.keys(state), ["__proto__", "y"]);
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
  });

  test("refuses lines that are not name = value", () => {
    assert.throws(() => parseState("not a state"), /cannot read the TLC state line/);
    assert.throws(() => parseState("/\\ x = 1\n/\\ x = 2"), /repeats the variable x/);
  });
});

describe("readMessages", () => {
  test("reads a flat sequence of messages and keeps text before a marker", () => {
    const { parts, malformed } = readMessages(
      ["plain", "lead@!@!@STARTMSG 2217:4 @!@!@", "inner", "@!@!@ENDMSG 2217 @!@!@"].join("\n"),
    );
    assert.equal(malformed, undefined);
    assert.deepEqual(parts, [
      { kind: "line", text: "plain" },
      { kind: "line", text: "lead" },
      { kind: "message", code: 2217, level: 4, body: [{ kind: "line", text: "inner" }] },
    ]);
  });

  test("refuses malformed framing", () => {
    const success =
      "@!@!@STARTMSG 2193:0 @!@!@\nModel checking completed. No error has been found.";
    const nested =
      "@!@!@STARTMSG 2111:1 @!@!@\nEvaluating invariant failed.\n@!@!@ENDMSG 2111 @!@!@";
    const cases: [string, RegExp][] = [
      [`${success}\n@!@!@ENDMSG 9999 @!@!@`, /ENDMSG 9999 closes message 2193/],
      [`${success}\n${nested}\n@!@!@ENDMSG 2193 @!@!@`, /message 2111 starts inside message 2193/],
      [success, /ends inside message 2193/],
      ["@!@!@ENDMSG 2193 @!@!@", /closes no message/],
      ["@!@!@STARTMSG 2193:7 @!@!@\nx\n@!@!@ENDMSG 2193 @!@!@", /unknown level 7/],
      ["@!@!@STARTMSG 2193 @!@!@", /unrecognised message marker/],
      ["@!@!@STARTMSG 1:0 @!@!@@!@!@STARTMSG 2:0 @!@!@", /two markers on one line/],
    ];
    for (const [output, why] of cases)
      assert.match(readMessages(output).malformed ?? "", why, output);
  });
});

describe("complete runs", () => {
  const msg = (code: number, level: number, text: string) =>
    `@!@!@STARTMSG ${code}:${level} @!@!@\n${text}\n@!@!@ENDMSG ${code} @!@!@`;
  const SUCCESS = msg(2193, 0, "Model checking completed. No error has been found.");
  const STATS = msg(
    2199,
    0,
    "8 states generated, 7 distinct states found, 0 states left on queue.",
  );
  const DEPTH = msg(2194, 0, "The depth of the complete state graph search is 7.");
  const FINISHED = msg(2186, 0, "Finished in 1s");
  const problem = (...messages: string[]) => {
    const { parts, malformed } = readMessages(`${messages.join("\n")}\n`);
    assert.equal(malformed, undefined);
    return completeRunProblem(parts);
  };

  test("accepts a well-formed complete run", () => {
    assert.equal(problem(SUCCESS, STATS, DEPTH, FINISHED), undefined);
  });

  test("refuses missing, repeated, misplaced or contradicting evidence", () => {
    const cases: [string[], RegExp][] = [
      [[STATS, DEPTH, FINISHED], /completing model checking 0 times/],
      [[SUCCESS, SUCCESS, STATS, FINISHED], /completing model checking 2 times/],
      [[SUCCESS, STATS, FINISHED, FINISHED], /finishing 2 times/],
      [[SUCCESS, STATS], /finishing 0 times/],
      [[STATS, FINISHED, SUCCESS], /output after its Finished message/],
      [[SUCCESS, STATS, FINISHED, "trailing text"], /output after its Finished message/],
      [[SUCCESS, FINISHED], /0 final statistics messages/],
      [[SUCCESS, STATS, STATS, FINISHED], /2 final statistics messages/],
      [[SUCCESS, msg(2199, 0, "many states"), FINISHED], /statistics are unreadable/],
      [[SUCCESS, STATS, DEPTH, DEPTH, FINISHED], /search depth twice/],
      [[SUCCESS, STATS, msg(2194, 0, "deep"), FINISHED], /search depth is unreadable/],
      [
        [msg(2111, 1, "Evaluating invariant failed."), SUCCESS, STATS, FINISHED],
        /2111 contradicts/,
      ],
      [[msg(2110, 1, "Invariant I is violated."), SUCCESS, STATS, FINISHED], /2110 contradicts/],
      [
        [msg(2217, 4, "1: <Initial predicate>\nx = 0"), SUCCESS, STATS, FINISHED],
        /counterexample state/,
      ],
    ];
    for (const [messages, why] of cases)
      assert.match(problem(...messages) ?? "", why, messages.join("|"));
  });

  test("a run reporting two violations is refused", () => {
    const { parts } = readMessages(
      `${msg(2110, 1, "Invariant A is violated.")}\n${msg(2114, 1, "Deadlock reached.")}\n`,
    );
    assert.throws(() => readBreak(parts), /more than one violation/);
  });

  test("only JVM option notices are expected on stderr", () => {
    assert.deepEqual(unexpectedStderr("Picked up JAVA_TOOL_OPTIONS: -Xmx1g\n\n"), []);
    assert.deepEqual(unexpectedStderr("Picked up JAVA_TOOL_OPTIONS: x\nException in thread main"), [
      "Exception in thread main",
    ]);
  });
});

describe("recorded TLC runs", () => {
  test("invariant violation: the named invariant and a two-state trace", async () => {
    const parts = await fixture("recorded/invariant.out");
    assert.deepEqual(readBreak(parts), { kind: "invariant", name: "Conserved" });
    const trace = readTrace(parts);
    assert.equal(trace.loop, undefined);
    assert.deepEqual(
      trace.steps.map((s) => [s.index, s.action]),
      [
        [1, "Initial predicate"],
        [2, "Withdraw"],
      ],
    );
    assert.deepEqual(trace.steps[1]?.state, { a: 1, b: 0, pc: "moving" });
    assert.deepEqual(readStats(parts), { generated: 2, distinct: 2, depth: 2 });
    assert.equal(readVersion(parts), "TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)");
    assert.deepEqual(readFailures(parts), []);
    assert.equal(hasMessage(parts, EC.TLC_FINISHED), true);
    assert.equal(hasMessage(parts, EC.TLC_SUCCESS), false);
  });

  test("invariant violated by the initial state", async () => {
    const parts = await fixture("recorded/invariant-initial.out");
    assert.deepEqual(readBreak(parts), { kind: "invariant", name: "I" });
    assert.deepEqual(readTrace(parts).steps, [
      { index: 1, action: "Initial predicate", state: { x: 0 } },
    ]);
  });

  test("deadlock with the path to the stuck state", async () => {
    const parts = await fixture("recorded/deadlock.out");
    assert.deepEqual(readBreak(parts), { kind: "deadlock" });
    const steps = readTrace(parts).steps;
    assert.equal(steps.length, 5);
    assert.deepEqual(steps.at(-1)?.state, { a: 0, b: 2, pc: "idle" });
  });

  test("liveness counterexamples end in a stutter or a loop back", async () => {
    const stutter = await fixture("recorded/temporal-stuttering.out");
    assert.deepEqual(readBreak(stutter), { kind: "temporal" });
    assert.deepEqual(readTrace(stutter).loop, { kind: "stuttering" });

    const back = await fixture("recorded/temporal-back.out");
    assert.deepEqual(readBreak(back), { kind: "temporal" });
    const trace = readTrace(back);
    assert.equal(trace.steps.length, 3);
    assert.deepEqual(trace.loop, { kind: "back", toIndex: 1, action: "Next" });

    const pstack = readTrace(await fixture("pstack/CounterLoop-verdict-1.out"));
    assert.deepEqual(pstack.loop, { kind: "back", toIndex: 2, action: "Back" });
  });

  test("action property violation is named", async () => {
    const parts = await fixture("recorded/action-property.out");
    assert.deepEqual(readBreak(parts), { kind: "property", name: "A" });
    assert.equal(readTrace(parts).steps.length, 4);
  });

  test("pstack TwoPhase: structured records, sets and functions", async () => {
    const parts = await fixture("pstack/TwoPhase-verdict-1.out");
    assert.deepEqual(readBreak(parts), { kind: "invariant", name: "TCConsistent" });
    const steps = readTrace(parts).steps;
    assert.deepEqual(
      steps.map((s) => s.action),
      [
        "Initial predicate",
        "RMPrepare",
        "TMRcvPrepared",
        "TMCommit",
        "RMRcvCommitMsg",
        "RMChooseToAbort",
      ],
    );
    const raw = JSON.stringify(steps).includes('"kind":"raw"');
    assert.equal(raw, false, "every TwoPhase value should parse");
    assert.deepEqual(steps.at(-1)?.state.rmState, {
      kind: "function",
      printedAs: "pairs",
      keys: [
        { kind: "model", name: "r1" },
        { kind: "model", name: "r2" },
      ],
      values: ["committed", "aborted"],
    });
  });

  test("pstack TypeGuard: an evaluation error is a failure, not a verdict", async () => {
    const parts = await fixture("pstack/TypeGuard-verdict-2.out");
    assert.equal(readBreak(parts), undefined);
    const failures = readFailures(parts);
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? "", /^TLC message 2111: Evaluating invariant NeedsTypeOK failed/);
  });

  test("a violation code without a rule name is refused", () => {
    const { parts } = readMessages(
      "@!@!@STARTMSG 2110:1 @!@!@\nsomething else\n@!@!@ENDMSG 2110 @!@!@\n",
    );
    assert.throws(() => readBreak(parts), /does not name the rule/);
  });

  test("a trace with a gap in its numbering is refused", () => {
    const { parts } = readMessages(
      [
        "@!@!@STARTMSG 2217:4 @!@!@",
        "1: <Initial predicate>",
        "x = 0",
        "@!@!@ENDMSG 2217 @!@!@",
        "@!@!@STARTMSG 2217:4 @!@!@",
        "3: <Next line 1, col 1 to line 1, col 2 of module M>",
        "x = 1",
        "@!@!@ENDMSG 2217 @!@!@",
      ].join("\n"),
    );
    assert.throws(() => readTrace(parts), /numbers state 3 where state 2 belongs/);
  });
});

describe("readModelConfig", () => {
  test("takes the rules out and keeps the rest", () => {
    const config = readModelConfig(
      [
        "\\* comment INVARIANT Fake",
        "CONSTANTS N = 3",
        '  Names = {"INVARIANT", "b"}',
        "(* PROPERTY Hidden *)",
        "SPECIFICATION Spec",
        "INVARIANT TypeOK",
        "  Safe",
        "PROPERTY Live",
        "CHECK_DEADLOCK FALSE",
        "CONSTRAINT Small",
      ].join("\n"),
    );
    assert.deepEqual(config.invariants, ["TypeOK", "Safe"]);
    assert.deepEqual(config.properties, ["Live"]);
    assert.equal(config.checkDeadlock, false);
    assert.equal(config.constrained, true);
    assert.doesNotMatch(config.kept, /TypeOK|Live|CHECK_DEADLOCK/);
    assert.match(config.kept, /CONSTANTS N = 3\n {2}Names = \{"INVARIANT", "b"\}/);
    assert.match(config.kept, /CONSTRAINT Small/);
    assert.equal(
      runConfig(config, ["Safe"], [], "Bound").split("\n").slice(-3).join("\n"),
      "INVARIANT Safe\nCONSTRAINT Bound\n",
    );
  });

  test("refuses rule lists it cannot read", () => {
    for (const text of [
      "INVARIANT A, B",
      "INVARIANT",
      "PROPERTY A A",
      "CHECK_DEADLOCK maybe",
      "Foo INVARIANT A",
      "(* open",
    ])
      assert.throws(() => readModelConfig(text), ConfigError, text);
  });
});
