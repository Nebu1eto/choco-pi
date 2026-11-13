import assert from "node:assert/strict";
import test from "node:test";

import {
  isBunRuntime,
  nodeBinDirectory,
  nodeExecutable,
} from "../profile/extensions/lib/node-runtime.ts";

const NODE_VERSIONS = { node: "24.0.0" };
const BUN_VERSIONS = { node: "26.3.0", bun: "1.4.4" };

test("under Node the child runtime is process.execPath, whatever CHOCO_PI_NODE says", () => {
  assert.equal(isBunRuntime(NODE_VERSIONS), false);
  const facts = {
    versions: NODE_VERSIONS,
    execPath: "/opt/node/bin/node",
    env: { CHOCO_PI_NODE: "/elsewhere/node" },
  };
  assert.equal(nodeExecutable(facts), "/opt/node/bin/node");
  assert.equal(nodeBinDirectory(facts), "/opt/node/bin");
  assert.equal(nodeExecutable(), process.execPath, "the defaults read the current process");
});

test("under Bun the child runtime is CHOCO_PI_NODE, else a PATH node; never the bun binary", () => {
  assert.equal(isBunRuntime(BUN_VERSIONS), true);
  const base = { versions: BUN_VERSIONS, execPath: "/opt/bun/bin/bun" };
  const launched = { ...base, env: { CHOCO_PI_NODE: "/choco/runtime/node/bin/node" } };
  assert.equal(nodeExecutable(launched), "/choco/runtime/node/bin/node");
  assert.equal(nodeBinDirectory(launched), "/choco/runtime/node/bin");
  for (const env of [{}, { CHOCO_PI_NODE: "" }, { CHOCO_PI_NODE: "relative/node" }]) {
    assert.equal(nodeExecutable({ ...base, env }), "node", JSON.stringify(env));
    assert.equal(nodeBinDirectory({ ...base, env }), undefined, JSON.stringify(env));
  }
  assert.equal(isBunRuntime({ node: "24.0.0", bun: "" }), false);
});
