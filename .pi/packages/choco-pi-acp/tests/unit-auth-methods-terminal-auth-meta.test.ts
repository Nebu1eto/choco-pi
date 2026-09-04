import test from "node:test";
import assert from "node:assert/strict";
import { getAuthMethods, PI_SETUP_METHOD_ID } from "../src/acp/auth.ts";
import { isBoundaryRecord, isString, parseJsonLine } from "../src/boundary.ts";

test("getAuthMethods: includes Zed terminal-auth metadata when enabled", () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true });
  assert.equal(methods.length, 1);
  const m = methods[0];

  assert.equal(m.id, PI_SETUP_METHOD_ID);
  assert.ok(m._meta);
  const terminalAuth = parseJsonLine(JSON.stringify(m._meta?.["terminal-auth"]) ?? "");
  assert.ok(isBoundaryRecord(terminalAuth));
  if (!isBoundaryRecord(terminalAuth)) throw new Error("terminal-auth metadata is missing");
  assert.ok(isString(terminalAuth.command));
  assert.deepEqual(terminalAuth.args, ["--terminal-login"]);
  assert.equal(terminalAuth.label, "Launch pi");
});

test("getAuthMethods: omits Zed terminal-auth metadata when disabled", () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: false });
  const m = methods[0];
  assert.ok(!m._meta || !m._meta["terminal-auth"]);
});
