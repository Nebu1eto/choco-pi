import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ManifestSchema = Type.Object({
  tools: Type.Array(
    Type.Object({
      metadata: Type.Object({
        name: Type.String(),
        defaultActive: Type.Optional(Type.Boolean()),
        parameters: Type.Unknown(),
      }),
    }),
  ),
});

const ActivateParametersSchema = Type.Object({
  properties: Type.Object({
    tools: Type.Object({ items: Type.Object({ enum: Type.Array(Type.String()) }) }),
  }),
});

// Pi 1.4.0 activates every extension tool a branch never recorded when it restores tools on
// resume or `/tree`, unless the tool registers with `defaultActive: false`.
test("every tool lsp_activate_tools can activate registers inactive, and only those", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../registration-manifest.json", import.meta.url), "utf-8"),
  );
  assert.ok(Value.Check(ManifestSchema, manifest));
  const activator = manifest.tools.find((tool) => tool.metadata.name === "lsp_activate_tools");
  assert.ok(activator);
  const parameters = activator.metadata.parameters;
  assert.ok(Value.Check(ActivateParametersSchema, parameters));
  const activatable = [...parameters.properties.tools.items.enum].sort();
  const inactive = manifest.tools
    .filter((tool) => tool.metadata.defaultActive === false)
    .map((tool) => tool.metadata.name)
    .sort();

  assert.equal(activatable.length, 6);
  assert.deepEqual(inactive, activatable);
});
