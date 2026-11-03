import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { finiteNum } from "../.pi/extensions/lib/finite-number.ts";
import { AgentRecordSchema } from "../.pi/extensions/lib/host-bridge/sources.ts";
import {
  CodexUsageLimitEntrySchema,
  SubagentUsageLimitSchema,
} from "../.pi/extensions/lib/usage-limit-contract.ts";

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

test("finiteNum rejects NaN and the infinities, keeps ordinary bounds", () => {
  const check = compile(finiteNum({ minimum: 0 })).check;
  assert.equal(check(5), true);
  assert.equal(check(-1), false);
  for (const value of NON_FINITE) assert.equal(check(value), false);
  assert.equal(compile(finiteNum()).check(-3.5), true);
});

test("in-process records reject non-finite numbers", () => {
  const record = {
    id: "a",
    type: "t",
    description: "d",
    status: "running",
    toolUses: 1,
    startedAt: 2,
    lifetimeUsage: { input: 1, output: 1, cacheWrite: 1 },
  };
  const checkRecord = compile(AgentRecordSchema).check;
  assert.equal(checkRecord(record), true);
  for (const value of NON_FINITE) {
    assert.equal(checkRecord({ ...record, startedAt: value }), false);
    assert.equal(checkRecord({ ...record, toolUses: value }), false);
  }
  const limit = {
    provider: "p",
    accountId: "a",
    kind: "quota",
    status: "reported",
  };
  assert.equal(compile(SubagentUsageLimitSchema).check({ ...limit, resetAt: 5 }), true);
  for (const value of NON_FINITE) {
    assert.equal(compile(SubagentUsageLimitSchema).check({ ...limit, resetAt: value }), false);
    assert.equal(
      compile(CodexUsageLimitEntrySchema).check({ observedAt: 1, resetAt: value }),
      false,
    );
  }
});
