import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHookWatchers } from "../src/index.ts";
import type { HookSource, MergedHookResult } from "../src/index.ts";

function emptyResult(): MergedHookResult {
  return {
    invocations: [],
    blocked: false,
    continue: true,
    systemMessages: [],
    terminalSequences: [],
    additionalContext: [],
  };
}

test("FileChanged and ConfigChange fire from actual filesystem changes", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hook-watch-"));
  fs.mkdirSync(path.join(cwd, ".claude"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source: HookSource = {
    id: "project",
    kind: "project",
    hooks: { FileChanged: [{ matcher: ".env", hooks: [] }] },
  };
  const events: string[] = [];
  // SAFETY: Watcher uses hasUI and ui.notify only; hasUI false prevents the latter.
  const ctx = { hasUI: false, ui: {} } as ExtensionContext;
  const watcher = createHookWatchers(
    cwd,
    ctx,
    [source],
    async (event) => {
      events.push(event);
      return emptyResult();
    },
    () => undefined,
  );
  t.after(() => watcher.dispose());
  await new Promise((resolve) => setTimeout(resolve, 30));
  fs.writeFileSync(path.join(cwd, ".env"), "A=1\n");
  fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}\n");
  const deadline = Date.now() + 2000;
  while (
    Date.now() < deadline &&
    !(events.includes("FileChanged") && events.includes("ConfigChange"))
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.includes("FileChanged"));
  assert.ok(events.includes("ConfigChange"));
});
