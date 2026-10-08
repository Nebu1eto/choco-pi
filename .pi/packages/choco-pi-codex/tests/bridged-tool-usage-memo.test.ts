import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { bridgedToolUsage } from "../src/tools/code-mode/registered-tool-bridge.ts";

const definition = (parameters: TSchema): ToolDefinition => ({
  name: "probe",
  label: "Probe",
  description: "probe",
  parameters,
  execute: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
});

test("bridgedToolUsage memoizes per definition and recomputes when parameters change", () => {
  const first = definition(Type.Object({ query: Type.String() }));
  const usage = bridgedToolUsage(first);
  assert.equal(usage, "await tools.probe({query})");
  assert.equal(bridgedToolUsage(first), usage);

  first.parameters = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) });
  assert.equal(bridgedToolUsage(first), "await tools.probe({query, limit?})");

  const second = definition(Type.Object({ other: Type.String() }));
  assert.equal(bridgedToolUsage(second), "await tools.probe({other})");
});
