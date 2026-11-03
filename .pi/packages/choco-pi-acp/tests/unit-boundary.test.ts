import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BoundaryValue,
  isBoolean,
  isBoundaryArray,
  isBoundaryRecord,
  isFiniteNumber,
  isNumber,
  isObjectValue,
  isString,
  parseJsonLine,
} from "../src/boundary.ts";

const samples: BoundaryValue[] = [
  undefined,
  null,
  true,
  false,
  0,
  -0,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  10n,
  "",
  "a",
  Symbol("s"),
  () => undefined,
  [],
  {},
  new String("a"),
  new Number(1),
  new Boolean(true),
  Object(10n),
  Object.create(null),
  {
    toString() {
      throw new Error("x");
    },
  },
];

function accepted(guard: (value: BoundaryValue) => boolean): BoundaryValue[] {
  return samples.filter(guard);
}

test("primitive guards return false without throwing for hostile objects", () => {
  const hostile: BoundaryValue[] = [
    Object.create(null),
    {
      toString() {
        throw new Error("x");
      },
    },
    Symbol("s"),
    new String("a"),
  ];
  for (const guard of [isString, isNumber, isFiniteNumber, isBoolean]) {
    for (const value of hostile) assert.equal(guard(value), false);
  }
});

test("isString accepts primitive strings only", () => {
  assert.deepEqual(accepted(isString), ["", "a"]);
});

test("isNumber accepts primitive numbers including NaN and infinities", () => {
  assert.deepEqual(accepted(isNumber), [
    0,
    -0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]);
});

test("isFiniteNumber rejects NaN, infinities, bigint and boxed numbers", () => {
  assert.deepEqual(accepted(isFiniteNumber), [0, -0, 1.5]);
});

test("isBoolean accepts primitive booleans only", () => {
  assert.deepEqual(accepted(isBoolean), [true, false]);
});

test("object guards: unknown keys allowed, null/array/function rejected", () => {
  assert.equal(isObjectValue({ extra: 1 }), true);
  assert.equal(isBoundaryRecord({ a: null, b: undefined }), true);
  assert.equal(isObjectValue(null), false);
  assert.equal(isObjectValue([]), false);
  assert.equal(
    isObjectValue(() => undefined),
    false,
  );
  assert.equal(isBoundaryArray([1]), true);
  assert.equal(isBoundaryArray({}), false);
});

test("parseJsonLine returns undefined on malformed input", () => {
  assert.deepEqual(parseJsonLine('{"a":null}'), { a: null });
  assert.equal(parseJsonLine("{"), undefined);
});
