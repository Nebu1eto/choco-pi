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

test("project hook settings prefer .pi then .agents with .claude as fallback", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "choco-hooks-precedence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of [".claude", ".agents", ".pi"]) fs.mkdirSync(path.join(root, directory));
  const settings = (command: string, disableAllHooks?: boolean) => ({
    disableAllHooks,
    hooks: { Stop: [{ hooks: [{ type: "command", command }] }] },
  });
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify(settings("claude", true)),
  );
  fs.writeFileSync(path.join(root, ".agents", "settings.json"), JSON.stringify(settings("agents")));
  fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify(settings("pi", false)));

  const loaded = loadHookSources({ cwd: root, managedSettingsPaths: [] });
  const projectSources = loaded.sources.filter((item) => item.kind === "project");
  assert.equal(loaded.disabled, false);
  assert.deepEqual(
    projectSources.flatMap((item) =>
      (item.hooks.Stop ?? []).flatMap((group) =>
        group.hooks.map((handler) => (handler.type === "command" ? handler.command : "")),
      ),
    ),
    ["claude", "agents", "pi"],
  );
});
