import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyHookEnvironment, hookEnvironmentFile, removeHookEnvironment } from "../src/index.ts";

test("hook environment files persist exported values and clean up", () => {
  const file = hookEnvironmentFile(`test-${process.pid}`);
  fs.writeFileSync(file, "export CHOCO_HOOK_ENV='persisted'\n");
  applyHookEnvironment(file);
  assert.equal(process.env.CHOCO_HOOK_ENV, "persisted");
  removeHookEnvironment(file);
  assert.equal(fs.existsSync(file), false);
  delete process.env.CHOCO_HOOK_ENV;
});
