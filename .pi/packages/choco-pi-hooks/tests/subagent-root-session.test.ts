import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type CustomEntry,
  DefaultResourceLoader,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import chocoPiHooks from "../src/extension.ts";
import { HookEngine, mergeResults } from "../src/engine.ts";
import type { HookInput, JsonObject } from "../src/types.ts";

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** One activation per session, as Pi binds extensions separately for each subagent. */
async function activate(name: string) {
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: createEventBus(),
    extensionFactories: [{ name, factory: chocoPiHooks }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((entry) => entry.path === `<inline:${name}>`);
  assert.ok(extension);
  return {
    emit: async (event: string, payload: JsonObject, ctx: ExtensionContext) => {
      for (const handler of extension.handlers.get(event) ?? []) await handler(payload, ctx);
    },
    dispose: () => loaded.runtime.invalidate(),
  };
}

interface SessionContextDouble {
  readonly cwd: string;
  readonly mode: "json";
  readonly thinkingLevel: "off";
  readonly hasUI: false;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): undefined;
    getEntries(): CustomEntry[];
  };
}

function sessionContext(sessionId: string, parentSessionId?: string): ExtensionContext {
  const entries: CustomEntry[] = parentSessionId
    ? [
        {
          type: "custom",
          id: "marker",
          parentId: null,
          timestamp: "",
          customType: "choco-pi:subagent",
          data: { parentSessionId },
        },
      ]
    : [];
  const double: SessionContextDouble = {
    cwd: process.cwd(),
    mode: "json",
    thinkingLevel: "off",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getEntries: () => entries,
    },
  };
  // SAFETY: The double supplies every context member the session lifecycle handlers read.
  return double as ExtensionContext;
}

test("subagent hook input names its top-level session through shutdown", async (t) => {
  const inputs: HookInput[] = [];
  t.mock.method(HookEngine.prototype, "run", async (input: HookInput) => {
    inputs.push(input);
    return mergeResults(input.hook_event_name, []);
  });
  const children = new Set<string>();
  Object.defineProperty(globalThis, SUBAGENTS_MANAGER_KEY, {
    configurable: true,
    value: { isChildSessionId: (id: string) => children.has(id) },
  });
  t.after(() => Reflect.deleteProperty(globalThis, SUBAGENTS_MANAGER_KEY));

  const sessions = [
    ["root", undefined],
    ["child", "root"],
    ["grandchild", "child"],
    // A subagent transcript resumed as an ordinary session keeps its marker.
    ["resumed", "root"],
  ] as const;
  children.add("child");
  children.add("grandchild");
  const hooks = await Promise.all(sessions.map(([id]) => activate(id)));
  try {
    for (const [index, [id, parent]] of sessions.entries())
      await hooks[index]?.emit("session_start", { reason: "startup" }, sessionContext(id, parent));
    // The subagents manager drops a child id before emitting its shutdown.
    children.clear();
    for (const [index, [id, parent]] of sessions.entries())
      await hooks[index]?.emit("session_shutdown", { reason: "quit" }, sessionContext(id, parent));
  } finally {
    for (const hook of hooks) hook.dispose();
  }

  const roots = (event: string) =>
    Object.fromEntries(
      inputs
        .filter((input) => input.hook_event_name === event)
        .map((input) => [input.session_id, input.root_session_id ?? null]),
    );
  const expected = { root: null, child: "root", grandchild: "root", resumed: null };
  assert.deepEqual(roots("SessionStart"), expected);
  assert.deepEqual(roots("SessionEnd"), expected);
});
