import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { arr, bool, compile, obj, opt, str, unknown } from "@earendil-works/pi-schema";

const manifestCheck = compile(
  obj(
    {
      tools: arr(
        obj(
          {
            metadata: obj(
              { name: str(), defaultActive: opt(bool()), parameters: unknown() },
              { open: true },
            ),
          },
          { open: true },
        ),
      ),
    },
    { open: true },
  ),
);

const activateParametersCheck = compile(
  obj(
    {
      properties: obj(
        { tools: obj({ items: obj({ enum: arr(str()) }, { open: true }) }, { open: true }) },
        { open: true },
      ),
    },
    { open: true },
  ),
);

// Pi 1.4.0 activates every extension tool a branch never recorded when it restores tools on
// resume or `/tree`, unless the tool registers with `defaultActive: false`.
test("every tool lsp_activate_tools can activate registers inactive, and only those", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../registration-manifest.json", import.meta.url), "utf-8"),
  );
  assert.ok(manifestCheck.check(manifest));
  const activator = manifest.tools.find((tool) => tool.metadata.name === "lsp_activate_tools");
  assert.ok(activator);
  const parameters = activator.metadata.parameters;
  assert.ok(activateParametersCheck.check(parameters));
  const activatable = [...parameters.properties.tools.items.enum].sort();
  const inactive = manifest.tools
    .filter((tool) => tool.metadata.defaultActive === false)
    .map((tool) => tool.metadata.name)
    .sort();

  assert.equal(activatable.length, 6);
  assert.deepEqual(inactive, activatable);
});
