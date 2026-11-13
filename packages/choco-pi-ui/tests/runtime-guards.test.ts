import assert from "node:assert/strict";
import test from "node:test";
import { inSubagentChildLoad } from "../extensions/zentui/child-load.ts";
import {
  isBigInt,
  isBoolean,
  isBoundaryValue,
  isCallable,
  isNumber,
  isObjectValue,
  isString,
  isSymbol,
  parseBoundaryValue,
} from "../extensions/zentui/runtime-values.ts";

const KEY = Symbol.for("pi-subagents:manager");

type FakeRegistry = Record<string, number | boolean | null | (() => boolean | number)>;

function withRegistry(value: FakeRegistry | undefined, body: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, KEY);
  Object.defineProperty(globalThis, KEY, { configurable: true, writable: true, value });
  try {
    body();
  } finally {
    if (previous) Object.defineProperty(globalThis, KEY, previous);
    else Reflect.deleteProperty(globalThis, KEY);
  }
}

test("zentui runtime-value primitives accept raw values and reject boxed wrappers", () => {
  assert.ok(isString("a") && !isString(Object("a")) && !isString(1));
  assert.ok(isBoolean(true) && isBoolean(false) && !isBoolean(Object(true)) && !isBoolean(0));
  assert.ok(isBigInt(1n) && !isBigInt(Object(1n)) && !isBigInt(1));
  const symbol = Symbol("s");
  assert.ok(isSymbol(symbol) && !isSymbol(Object(symbol)) && !isSymbol("s"));
  assert.ok(isCallable(() => 1) && !isCallable({}));
});

test("zentui isNumber admits NaN and infinities but not boxed or numeric strings", () => {
  for (const n of [0, -0, 1.5, Number.NaN, Infinity, -Infinity]) assert.ok(isNumber(n));
  assert.ok(!isNumber(Object(1)) && !isNumber("1") && !isNumber(1n));
});

test("zentui object/boundary guards keep their shallow behaviour", () => {
  assert.ok(isObjectValue({}) && isObjectValue(new Date()));
  assert.ok(!isObjectValue([]) && !isObjectValue(null) && !isObjectValue(() => 1));
  for (const v of [undefined, null, 1, "s", true, 1n, Symbol("x"), [], {}, () => 1]) {
    assert.ok(isBoundaryValue(v));
  }
  assert.equal(parseBoundaryValue("x"), "x");
});

test("inSubagentChildLoad accepts open registries and rejects malformed ones", () => {
  withRegistry({ isChildSessionContext: () => true, extra: 1 }, () => {
    assert.equal(inSubagentChildLoad(), true);
  });
  withRegistry({ isChildSessionContext: () => false }, () => {
    assert.equal(inSubagentChildLoad(), false);
  });
  // Non-boolean result is "not a child".
  withRegistry({ isChildSessionContext: () => 1 }, () => {
    assert.equal(inSubagentChildLoad(), false);
  });
  const malformed: FakeRegistry[] = [
    {},
    { isChildSessionContext: true },
    { isChildSessionContext: null },
  ];
  for (const bad of malformed) {
    withRegistry(bad, () => assert.equal(inSubagentChildLoad(), false));
  }
  withRegistry(undefined, () => assert.equal(inSubagentChildLoad(), false));
});
