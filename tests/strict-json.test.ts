import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateKey, parseStrictJson } from "../.pi/extensions/lib/strict-json.ts";

test("findDuplicateKey finds a duplicate in any object at any depth", () => {
  assert.equal(findDuplicateKey('{"a":1,"a":2}'), "a");
  assert.equal(findDuplicateKey('{"x":{"y":[{"b":1,"c":2,"b":3}]}}'), "b");
  assert.equal(findDuplicateKey('[{"a":1},{"a":2}]'), undefined);
  assert.equal(findDuplicateKey('{"a":{"a":1}}'), undefined);
  assert.equal(findDuplicateKey('{"a":[1,"a",{"b":"a"}],"b":"a"}'), undefined);
  assert.equal(findDuplicateKey('{"a":{},"b":[],"c":{"a":{}}}'), undefined);
  assert.equal(findDuplicateKey('"a"'), undefined);
  assert.equal(findDuplicateKey("[]"), undefined);
});

test("keys are compared after unescaping", () => {
  assert.equal(findDuplicateKey('{"a":1,"\\u0061":2}'), "a");
  assert.equal(findDuplicateKey('{"\\"":1,"\\u0022":2}'), '"');
  assert.equal(findDuplicateKey('{"a\\\\":1,"a\\u005c":2}'), "a\\");
  assert.equal(findDuplicateKey('{"\\/":1,"/":2}'), "/");
  // Escaped quotes and commas inside strings do not confuse the scan.
  assert.equal(findDuplicateKey('{"k\\",\\"k":1,"k":2,"v":"\\",\\"k\\":"}'), undefined);
  assert.equal(findDuplicateKey('{"A":1,"a":2}'), undefined);
});

test("parseStrictJson rejects invalid JSON and duplicate keys and never throws", () => {
  assert.deepEqual(parseStrictJson('{"a":[1,{"b":2}]}'), { ok: true, value: { a: [1, { b: 2 }] } });
  const duplicate = parseStrictJson('{"verdict":"INCOMPLETE","verdict":"NO_FINDINGS"}');
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok ? "" : duplicate.error, /duplicate key "verdict"/);
  const deep = parseStrictJson(' { "o" : { "p" : 1 , "p" : 2 } } ');
  assert.match(deep.ok ? "" : deep.error, /duplicate key "p"/);
  for (const text of ["", "{", '{"a":1,}', "\uFEFF{}", "{'a':1}", "NaN"]) {
    assert.equal(parseStrictJson(text).ok, false, JSON.stringify(text));
  }
  assert.equal(parseStrictJson(`${"[".repeat(100_000)}${"]".repeat(100_000)}`).ok, true);
});

test("the scan stays linear on large documents", () => {
  const started = Date.now();
  const entries = Array.from({ length: 200_000 }, (_, index) => `"k${index}":"v\\"${index}"`);
  assert.equal(parseStrictJson(`{${entries.join(",")}}`).ok, true);
  const escapedKeys = Array.from({ length: 50_000 }, (_, index) => `"\\u006b${index}":0`);
  assert.equal(parseStrictJson(`{${escapedKeys.join(",")},"k7":1}`).ok, false);
  assert.ok(Date.now() - started < 10_000, "linear");
});
