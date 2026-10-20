import assert from "node:assert/strict";
import test from "node:test";

import { BRIDGE_EXCLUDED_TOOLS } from "../src/tools/code-mode/registered-tool-bridge.ts";

test("read-only subagent tree tools bridge while consume-once result stays direct-only", () => {
  assert.deepEqual(
    ["subagent_tree", "get_subagent_status", "get_subagent_result"].map((name) =>
      BRIDGE_EXCLUDED_TOOLS.has(name),
    ),
    [false, false, true],
  );
});
