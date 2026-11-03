import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  BoundaryValueSchema,
  JsonObjectSchema,
  isBoundaryValue,
  isJsonObject,
  jsonValueType,
} from "../src/adapter/runtime-values.ts";
import {
  isBigIntValue,
  isBooleanValue,
  isFunctionValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
  isSymbolValue,
  isUndefinedValue,
} from "../src/tools/boundary.ts";

class Sample {}

const nullPrototype = Object.assign(Object.create(null), { a: 1 });
const throwingToString = {
  toString() {
    throw new Error("toString must not run");
  },
  valueOf() {
    throw new Error("valueOf must not run");
  },
};
const throwingGetter = {
  get a(): never {
    throw new Error("getter must not run");
  },
};

// [label, value, bigint, boolean, function, finite number, string, symbol, undefined,
//  object(non-array, non-function), jsonValueType]
type Row = readonly [
  string,
  unknown,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  string,
];

const rows: readonly Row[] = [
  ["string", "a", false, false, false, false, true, false, false, false, "string"],
  ["empty string", "", false, false, false, false, true, false, false, false, "string"],
  ["zero", 0, false, false, false, true, false, false, false, false, "number"],
  ["negative zero", -0, false, false, false, true, false, false, false, false, "number"],
  // Finite-only: the old TypeBox Number check rejected these and jsonValueType fell through to "object".
  ["NaN", Number.NaN, false, false, false, false, false, false, false, false, "object"],
  ["Infinity", Infinity, false, false, false, false, false, false, false, false, "object"],
  ["-Infinity", -Infinity, false, false, false, false, false, false, false, false, "object"],
  ["true", true, false, true, false, false, false, false, false, false, "boolean"],
  ["false", false, false, true, false, false, false, false, false, false, "boolean"],
  ["bigint", 1n, true, false, false, false, false, false, false, false, "bigint"],
  ["symbol", Symbol("s"), false, false, false, false, false, true, false, false, "symbol"],
  ["arrow", () => {}, false, false, true, false, false, false, false, false, "function"],
  ["class instance", new Sample(), false, false, false, false, false, false, false, true, "object"],
  ["null", null, false, false, false, false, false, false, false, false, "object"],
  ["undefined", undefined, false, false, false, false, false, false, true, false, "undefined"],
  ["array", [], false, false, false, false, false, false, false, false, "object"],
  ["object", {}, false, false, false, false, false, false, false, true, "object"],
  [
    "boxed string",
    new String("a"),
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    "object",
  ],
  ["boxed number", new Number(1), false, false, false, false, false, false, false, true, "object"],
  [
    "boxed boolean",
    new Boolean(true),
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    "object",
  ],
  ["boxed bigint", Object(1n), false, false, false, false, false, false, false, true, "object"],
  [
    "boxed symbol",
    Object(Symbol("b")),
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    "object",
  ],
  [
    "null prototype",
    nullPrototype,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    "object",
  ],
  [
    "throwing toString",
    throwingToString,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    "object",
  ],
  [
    "throwing getter",
    throwingGetter,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    "object",
  ],
];

test("boundary predicates and jsonValueType match the table without throwing", () => {
  for (const [label, value, big, bool, fn, num, str, sym, undef, obj, type] of rows) {
    assert.equal(isBigIntValue(value), big, `isBigIntValue ${label}`);
    assert.equal(isBooleanValue(value), bool, `isBooleanValue ${label}`);
    assert.equal(isFunctionValue(value), fn, `isFunctionValue ${label}`);
    assert.equal(isNumberValue(value), num, `isNumberValue ${label}`);
    assert.equal(isStringValue(value), str, `isStringValue ${label}`);
    assert.equal(isSymbolValue(value), sym, `isSymbolValue ${label}`);
    assert.equal(isUndefinedValue(value), undef, `isUndefinedValue ${label}`);
    assert.equal(isObjectValue(value), obj, `isObjectValue ${label}`);
    assert.equal(isJsonObject(value), obj, `isJsonObject ${label}`);
    assert.equal(isBoundaryValue(value), true, `isBoundaryValue ${label}`);
    assert.equal(jsonValueType(value), type, `jsonValueType ${label}`);
  }
});

test("compat schemas keep their TypeBox Check behaviour for non-throwing values", () => {
  for (const [label, value, , , , , , , , obj] of rows) {
    if (value === throwingGetter) continue;
    assert.equal(Value.Check(JsonObjectSchema, value), obj, `JsonObjectSchema ${label}`);
    // NaN/Infinity are the documented difference: the old cyclic schema rejected them.
    assert.equal(Value.Check(BoundaryValueSchema, value), true, `BoundaryValueSchema ${label}`);
  }
});
