import assert from "node:assert/strict";
import test from "node:test";
import {
  isBigInt,
  isBoolean,
  isFunction,
  isJsonRecord,
  isNumber,
  isObject,
  isString,
  isSymbol,
  runtimeTypeOf,
} from "../.pi/extensions/lib/runtime-values.ts";

class Sample {}

type Row = readonly [
  label: string,
  value: unknown,
  bigint: boolean,
  boolean: boolean,
  fn: boolean,
  number: boolean,
  string: boolean,
  symbol: boolean,
  type: string,
];

const rows: readonly Row[] = [
  ["string", "a", false, false, false, false, true, false, "string"],
  ["empty string", "", false, false, false, false, true, false, "string"],
  ["zero", 0, false, false, false, true, false, false, "number"],
  ["NaN", Number.NaN, false, false, false, true, false, false, "number"],
  ["Infinity", Number.POSITIVE_INFINITY, false, false, false, true, false, false, "number"],
  ["-Infinity", Number.NEGATIVE_INFINITY, false, false, false, true, false, false, "number"],
  ["negative zero", -0, false, false, false, true, false, false, "number"],
  ["true", true, false, true, false, false, false, false, "boolean"],
  ["false", false, false, true, false, false, false, false, "boolean"],
  ["bigint", 1n, true, false, false, false, false, false, "bigint"],
  ["symbol", Symbol("s"), false, false, false, false, false, true, "symbol"],
  ["arrow", () => {}, false, false, true, false, false, false, "function"],
  ["class instance", new Sample(), false, false, false, false, false, false, "object"],
  ["null", null, false, false, false, false, false, false, "object"],
  ["undefined", undefined, false, false, false, false, false, false, "undefined"],
  ["array", [], false, false, false, false, false, false, "object"],
  ["object", {}, false, false, false, false, false, false, "object"],
  ["boxed bigint", Object(1n), false, false, false, false, false, false, "object"],
  ["boxed symbol", Object(Symbol("b")), false, false, false, false, false, false, "object"],
  ["boxed string", new String("a"), false, false, false, false, false, false, "object"],
  ["boxed number", new Number(1), false, false, false, false, false, false, "object"],
  ["boxed boolean", new Boolean(true), false, false, false, false, false, false, "object"],
];

test("runtime predicates and runtimeTypeOf match the table", () => {
  for (const [label, value, big, bool, fn, num, str, sym, type] of rows) {
    assert.equal(isBigInt(value), big, `isBigInt ${label}`);
    assert.equal(isBoolean(value), bool, `isBoolean ${label}`);
    assert.equal(isFunction(value), fn, `isFunction ${label}`);
    assert.equal(isNumber(value), num, `isNumber ${label}`);
    assert.equal(isString(value), str, `isString ${label}`);
    assert.equal(isSymbol(value), sym, `isSymbol ${label}`);
    assert.equal(runtimeTypeOf(value), type, `runtimeTypeOf ${label}`);
  }
});

test("isObject and isJsonRecord keep their semantics", () => {
  assert.equal(isObject(null), true);
  assert.equal(isObject({}), true);
  assert.equal(isObject([]), true);
  assert.equal(
    isObject(() => {}),
    false,
  );
  assert.equal(isObject("a"), false);
  assert.equal(isJsonRecord(null), false);
  assert.equal(isJsonRecord([]), false);
  assert.equal(isJsonRecord({}), true);
  assert.equal(isJsonRecord(new Sample()), true);
});
