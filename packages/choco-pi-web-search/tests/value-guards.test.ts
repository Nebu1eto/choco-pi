import assert from "node:assert/strict";
import { test } from "node:test";

import { CredentialResolutionError, resolveCredential } from "../credential-source.ts";
import { isBooleanValue, isNumberValue, isStringValue } from "../value-guards.ts";

test("primitive guards accept primitives and reject boxed, non-finite and foreign values", () => {
  assert.ok(isStringValue("") && isStringValue("x"));
  assert.ok(!isStringValue(Object("x")) && !isStringValue(1) && !isStringValue(null));
  assert.ok(!isStringValue(undefined) && !isStringValue(Object.create(null)));
  assert.ok(isNumberValue(0) && isNumberValue(-1.5));
  assert.ok(!isNumberValue(Number.NaN) && !isNumberValue(Infinity) && !isNumberValue(-Infinity));
  assert.ok(!isNumberValue("1") && !isNumberValue(undefined) && !isNumberValue(1n));
  assert.ok(isBooleanValue(true) && isBooleanValue(false));
  assert.ok(!isBooleanValue(0) && !isBooleanValue("true") && !isBooleanValue(undefined));
});

type Thrown = {} | null | undefined;

async function categoryFor(failure: Thrown): Promise<string | undefined> {
  try {
    await resolveCredential({
      provider: "Synthetic",
      configuredValue: "!cmd",
      runCommand: async () => {
        throw failure;
      },
    });
  } catch (error) {
    if (error instanceof CredentialResolutionError) return error.category;
    throw error;
  }
  return undefined;
}

test("command failure shapes: open objects and arrays are inspected, other values are generic", async () => {
  assert.equal(await categoryFor({ killed: true, extra: 1 }), "command-timeout");
  assert.equal(await categoryFor({ code: "ETIMEDOUT" }), "command-timeout");
  assert.equal(
    await categoryFor({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    "command-output-too-large",
  );
  assert.equal(await categoryFor(Object.assign([], { killed: true })), "command-timeout");
  assert.equal(
    await categoryFor(Object.assign(Object.create(null), { killed: true })),
    "command-timeout",
  );
  assert.equal(await categoryFor({}), "command-failed");
  assert.equal(await categoryFor("boom"), "command-failed");
  assert.equal(await categoryFor(null), "command-failed");
  assert.equal(await categoryFor(undefined), "command-failed");
});
