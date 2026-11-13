import assert from "node:assert/strict";
import test from "node:test";

import { parseCustomTool } from "../src/tools/code-mode/custom-tools.ts";

const DEFINITION = 'usage = "tool(x)"\ncommand = "/opt/tools/run.mjs"\nargs = ["--flag"]\n';

test("a JavaScript custom tool runs on Node: execPath under Node, CHOCO_PI_NODE under Bun", () => {
  const underNode = parseCustomTool("/defs/run_tool.toml", DEFINITION);
  assert.equal(underNode.command, process.execPath);
  assert.deepEqual(underNode.args, ["/opt/tools/run.mjs", "--flag"]);
  const previous = process.env.CHOCO_PI_NODE;
  Object.defineProperty(process.versions, "bun", {
    value: "1.4.4",
    configurable: true,
    enumerable: true,
  });
  process.env.CHOCO_PI_NODE = "/choco/runtime/node/bin/node";
  try {
    const underBun = parseCustomTool("/defs/run_tool.toml", DEFINITION);
    assert.equal(underBun.command, "/choco/runtime/node/bin/node");
    assert.deepEqual(underBun.args, ["/opt/tools/run.mjs", "--flag"]);
    const native = parseCustomTool(
      "/defs/native_tool.toml",
      'usage = "u"\ncommand = "/bin/echo"\n',
    );
    assert.equal(native.command, "/bin/echo", "non-JavaScript commands are unchanged");
  } finally {
    Reflect.deleteProperty(process.versions, "bun");
    if (previous === undefined) delete process.env.CHOCO_PI_NODE;
    else process.env.CHOCO_PI_NODE = previous;
  }
});
