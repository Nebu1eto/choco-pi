import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadHookSources } from "../src/index.ts";

test("loads and merges user, project, and local settings in precedence order", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choco-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, "user.json");
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(
    user,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user" }] }] } }),
  );
  fs.writeFileSync(
    path.join(root, ".claude/settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "project" }] }] } }),
  );
  fs.writeFileSync(
    path.join(root, ".claude/settings.local.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "local" }] }] } }),
  );
  const loaded = loadHookSources({ cwd: root, userSettingsPath: user });
  assert.deepEqual(
    loaded.sources.map((item) => item.kind),
    ["user", "project", "local"],
  );
});

test("disableAllHooks preserves only managed hooks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choco-hooks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const managed = path.join(root, "managed.json");
  const user = path.join(root, "user.json");
  fs.writeFileSync(
    managed,
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "managed" }] }] } }),
  );
  fs.writeFileSync(
    user,
    JSON.stringify({
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user" }] }] },
    }),
  );
  const loaded = loadHookSources({
    cwd: root,
    userSettingsPath: user,
    managedSettingsPaths: [managed],
  });
  assert.equal(loaded.disabled, true);
  assert.deepEqual(
    loaded.sources.map((item) => item.kind),
    ["managed"],
  );
});
