/**
 * The exec bridge applies the calling session's published per-call guard
 * (`toolCallBlock` on the `choco-pi.tool-scope.v1` registry) on both dispatch
 * paths: `ctx.executeTool()` for callable tools and the direct `execute()`
 * fallback for reachable but inactive ones, which gets no `tool_call` hooks.
 * choco-pi-subagents publishes the guard for children without edit and write.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createSyntheticSourceInfo,
  SessionManager,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { hostParams } from "../src/schema-bridge.ts";
import type { BoundaryValue } from "../src/tools/boundary.ts";
import { isJsonObject } from "../src/adapter/runtime-values.ts";
import { collectBridgedTools } from "../src/tools/code-mode/registered-tool-bridge.ts";
import { createToolContextFixture } from "./tool-context-fixture.ts";

const TOOL_SCOPE_SYMBOL = Symbol.for("choco-pi.tool-scope.v1");
type Owner = ExtensionToolContext["sessionManager"];

/** The tool-scope registry members this test publishes. */
interface PublishedToolScope {
  isToolAllowed(): boolean;
  restrict(): void;
  toolCallBlock?(owner: Owner, name: string, input: BoundaryValue): string | undefined;
}

/** The guard choco-pi-subagents installs for a read-only child, reduced to the cases tested. */
function readOnlyReason(name: string, input: BoundaryValue): string | undefined {
  if (name !== "lsp_navigation" || !isJsonObject(input)) return undefined;
  const operation = input["operation"];
  if (operation === "rename" || (input["apply"] !== undefined && input["apply"] !== false)) {
    return `read-only agent: lsp_navigation/${String(operation)} can change files`;
  }
  return undefined;
}

/** Publish a registry that guards only `guarded`'s calls; returns the restore function. */
function publishRegistry(guarded: Owner, withGuard = true): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, TOOL_SCOPE_SYMBOL);
  const registry: PublishedToolScope = { isToolAllowed: () => true, restrict: () => undefined };
  if (withGuard) {
    registry.toolCallBlock = (owner, name, input) =>
      owner === guarded ? readOnlyReason(name, input) : undefined;
  }
  Object.defineProperty(globalThis, TOOL_SCOPE_SYMBOL, {
    configurable: true,
    writable: true,
    value: registry,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, TOOL_SCOPE_SYMBOL, previous);
    else Reflect.deleteProperty(globalThis, TOOL_SCOPE_SYMBOL);
  };
}

interface Probe {
  direct: string[];
  session: string[];
  invoke(input: BoundaryValue): Promise<BoundaryValue>;
}

/** A bridged `lsp_navigation` in `owner`'s session, active (session-callable) or not. */
function probe(owner: Owner, active: boolean): Probe {
  const direct: string[] = [];
  const session: string[] = [];
  const definition: ToolDefinition = {
    name: "lsp_navigation",
    label: "lsp_navigation",
    description: "lsp_navigation",
    parameters: hostParams(obj({}, { open: true })),
    async execute(_id, params) {
      direct.push(JSON.stringify(params));
      return { content: [{ type: "text", text: "direct ran" }], details: undefined };
    },
  };
  const [tool] = collectBridgedTools({
    getAllRegisteredTools: () => [
      { definition, sourceInfo: createSyntheticSourceInfo("test", { source: "test" }) },
    ],
  });
  assert.ok(tool);
  const extensionContext = createToolContextFixture({
    sessionManager: owner,
    // Session-callable only when listed; the listed copy itself is never run.
    tools: active
      ? [{ ...definition, execute: async () => ({ content: [], details: undefined }) }]
      : [],
    async executeTool(name, args) {
      session.push(JSON.stringify(args));
      return {
        toolCall: { type: "toolCall", id: "exec-1/1", name, arguments: {} },
        result: { content: [{ type: "text", text: "session ran" }], details: {} },
        isError: false,
      };
    },
  });
  return {
    direct,
    session,
    invoke: (input) =>
      tool.invoke(
        input,
        { cwd: "/tmp", toolCallId: "exec-1", extensionContext },
        new AbortController().signal,
      ),
  };
}

const RENAME = { operation: "rename", path: "a.ts", new_name: "b", apply: true };
const BLOCKED =
  /^Error: Code mode tool error \[blocked\]: read-only agent: lsp_navigation\/rename can change files$/;

test("a guarded session's mutating call is refused on the direct execute path", async () => {
  const owner = SessionManager.inMemory("/tmp");
  const restore = publishRegistry(owner);
  try {
    const inactive = probe(owner, false);
    await assert.rejects(inactive.invoke(RENAME), BLOCKED);
    assert.deepEqual(inactive.direct, [], "execute never ran");
    assert.equal(await inactive.invoke({ operation: "definition", path: "a.ts" }), "direct ran");
    assert.equal(inactive.direct.length, 1);
  } finally {
    restore();
  }
});

test("a guarded session's mutating call is refused before ctx.executeTool", async () => {
  const owner = SessionManager.inMemory("/tmp");
  const restore = publishRegistry(owner);
  try {
    const active = probe(owner, true);
    await assert.rejects(active.invoke(RENAME), BLOCKED);
    assert.deepEqual(active.session, []);
    assert.equal(await active.invoke({ operation: "references", path: "a.ts" }), "session ran");
    assert.deepEqual(active.direct, []);
  } finally {
    restore();
  }
});

test("unguarded sessions and registries without a call guard are unaffected", async () => {
  const guarded = SessionManager.inMemory("/tmp");
  const other = SessionManager.inMemory("/tmp");
  let restore = publishRegistry(guarded);
  try {
    const inactive = probe(other, false);
    assert.equal(await inactive.invoke(RENAME), "direct ran");
    const active = probe(other, true);
    assert.equal(await active.invoke(RENAME), "session ran");
  } finally {
    restore();
  }
  restore = publishRegistry(guarded, false);
  try {
    assert.equal(await probe(guarded, false).invoke(RENAME), "direct ran");
  } finally {
    restore();
  }
  // No registry at all (a root session without choco-pi-subagents).
  assert.equal(await probe(guarded, false).invoke(RENAME), "direct ran");
});
