import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import test from "node:test";

import { resolveInstalledDocsPaths } from "../extensions/agent-browser/lib/runtime-extension.ts";

test("deferred runtime resolves the installed package README", async () => {
  const { readmePath } = resolveInstalledDocsPaths();
  const metadata = await stat(readmePath);

  assert.equal(metadata.isFile(), true);
  assert.match(readmePath, /choco-pi-agent-browser[/\\\\]README\.md$/u);
});
