// The JSON document `tlc.ts check` prints. The wrapper validates its own output
// against this schema before printing it, and tests use it to read the output.

import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  nul,
  obj,
  oneOf,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

const Step = obj({
  index: int({ minimum: 1 }),
  action: str(),
  state: map(unknown()),
});

const Loop = union([
  obj({ kind: lit("stuttering") }),
  obj({ kind: lit("back"), toIndex: int({ minimum: 1 }), action: str() }),
]);

const Rule = obj({
  name: str({ minLength: 1 }),
  status: oneOf(["holds", "violated", "not_checked"]),
  trace: opt(arr(Step)),
  loop: opt(Loop),
});

const Count = union([int({ minimum: 0 }), nul()]);

export const CheckResultSchema = obj({
  schema: lit(1),
  spec: str(),
  config: str(),
  tool: obj({
    tlcVersion: union([str(), nul()]),
    jarSha256: union([str(), nul()]),
    java: union([str(), nul()]),
  }),
  bounds: obj({ maxStates: int({ minimum: 1 }), timeoutMs: int({ minimum: 1 }) }),
  status: oneOf(["pass", "violated", "inconclusive", "error"]),
  stats: obj({ generated: Count, distinct: Count, depth: Count }),
  invariants: arr(Rule),
  properties: arr(Rule),
  deadlock: obj({ checked: bool(), found: bool(), trace: opt(arr(Step)) }),
  errors: arr(str()),
  notes: arr(str()),
});

export type CheckResult = Static<typeof CheckResultSchema>;
export type RuleResult = Static<typeof Rule>;
export type TraceStepResult = Static<typeof Step>;

export const checkResult = compile(CheckResultSchema);

export const EXIT = { pass: 0, error: 2, violated: 3, inconclusive: 4 } as const;
