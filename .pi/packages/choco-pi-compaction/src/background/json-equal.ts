// Structural equality of JSON-shaped values, replacing TypeBox `Value.Equal`.
// Arrays compare in order, objects by own enumerable keys regardless of order,
// primitives by `===` (so NaN differs from itself and +0 equals -0, as before).

import type { RuntimeValue } from "../guards.ts";

function isObjectValue(value: RuntimeValue): value is {} {
  return Object(value) === value;
}

export function jsonEqual(left: RuntimeValue, right: RuntimeValue): boolean {
  if (!isObjectValue(left) || !isObjectValue(right)) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => jsonEqual(item, right[index]));
  }
  const leftEntries = Object.entries(left);
  const rightEntries = new Map(Object.entries(right));
  if (leftEntries.length !== rightEntries.size) return false;
  return leftEntries.every(
    ([key, item]) => rightEntries.has(key) && jsonEqual(item, rightEntries.get(key)),
  );
}
