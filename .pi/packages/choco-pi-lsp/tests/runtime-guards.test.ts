// The guards replace TypeBox Check(); this pins the accept/reject matrix measured against typebox 1.x.
import assert from "node:assert/strict";
import test from "node:test";
import {
  hasErrorCode,
  isBigInt,
  isBoolean,
  isFiniteNumber,
  isFunction,
  isNull,
  isObjectRecord,
  isString,
  isStringArray,
  isSymbol,
  isUndefined,
} from "../clients/runtime-guards.ts";

class Instance {}

test("isObjectRecord accepts non-null non-array non-function objects only", () => {
  for (const ok of [{}, new Date(), new Map(), new Instance(), Object.create(null)]) {
    assert.equal(isObjectRecord(ok), true);
  }
  for (const bad of [null, undefined, [], () => 1, "a", 1, Symbol("x")]) {
    assert.equal(isObjectRecord(bad), false);
  }
});

test("primitive guards reject boxed values and non-finite numbers", () => {
  assert.equal(isString("a"), true);
  assert.equal(isString(new String("a")), false);
  assert.equal(isFiniteNumber(1), true);
  for (const bad of [Number.NaN, Infinity, -Infinity, new Number(1), "1"]) {
    assert.equal(isFiniteNumber(bad), false);
  }
  assert.equal(isBoolean(false), true);
  assert.equal(isBoolean(new Boolean(false)), false);
  assert.equal(isBigInt(1n), true);
  assert.equal(isBigInt(Object(1n)), false);
  assert.equal(isSymbol(Symbol("x")), true);
  assert.equal(isSymbol(Object(Symbol("x"))), false);
  assert.equal(isNull(null), true);
  assert.equal(isNull(undefined), false);
  assert.equal(isUndefined(undefined), true);
  assert.equal(
    isFunction(() => 1),
    true,
  );
  assert.equal(isFunction({}), false);
  assert.equal(isStringArray(["a"]), true);
  assert.equal(isStringArray(["a", 1]), false);
  assert.equal(isStringArray("a"), false);
});

test("hasErrorCode matches the former Object({ code: Optional(String) }) check", () => {
  assert.equal(hasErrorCode(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(hasErrorCode(new Error("x")), true);
  assert.equal(hasErrorCode({ code: 3 }), false);
  assert.equal(hasErrorCode(null), false);
  assert.equal(hasErrorCode("ENOENT"), false);
});
