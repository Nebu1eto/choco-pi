import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { hostParams } from "../src/schema-bridge.ts";
import type { HostSchema } from "../src/schema-bridge.ts";
import { bridgedToolUsage } from "../src/tools/code-mode/registered-tool-bridge.ts";

const definition = (parameters: HostSchema): ToolDefinition => ({
  name: "probe",
  label: "Probe",
  description: "probe",
  parameters,
  execute: async () => ({ content: [{ type: "text", text: "" }], details: undefined }),
});

test("bridgedToolUsage memoizes per definition and recomputes when parameters change", () => {
  const first = definition(hostParams(obj({ query: str() }, { open: true })));
  const usage = bridgedToolUsage(first);
  assert.equal(usage, "await tools.probe({query})");
  assert.equal(bridgedToolUsage(first), usage);

  first.parameters = hostParams(obj({ query: str(), limit: opt(num()) }, { open: true }));
  assert.equal(bridgedToolUsage(first), "await tools.probe({query, limit?})");

  const second = definition(hostParams(obj({ other: str() }, { open: true })));
  assert.equal(bridgedToolUsage(second), "await tools.probe({other})");
});
