import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEventBus,
  type CustomEntry,
  DefaultResourceLoader,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerScratchRoot,
  scratchDirFor,
  unregisterScratchRoot,
} from "../../../extensions/lib/scratch-path.ts";
import chocoPiHooks from "../src/extension.ts";
import { HookEngine, mergeResults } from "../src/engine.ts";
import { isJsonRecord, isString, type JsonRecord } from "../../../extensions/lib/runtime-values.ts";
import type { HookInput } from "../src/types.ts";

async function activate() {
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "scratch", factory: chocoPiHooks }],
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
  const extension = loaded.extensions.find((entry) => entry.path === "<inline:scratch>");
  assert.ok(extension);
  return {
    async emit(event: string, payload: JsonRecord, ctx: ExtensionContext) {
      let last: JsonRecord | undefined;
      for (const handler of extension.handlers.get(event) ?? []) {
        const returned = await handler(payload, ctx);
        if (isJsonRecord(returned)) last = returned;
      }
      return last;
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
    getSessionName(): undefined;
    getEntries(): CustomEntry[];
  };
}

function sessionContext(sessionId: string): ExtensionContext {
  const double: SessionContextDouble = {
    cwd: process.cwd(),
    mode: "json",
    thinkingLevel: "off",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
      getEntries: () => [],
    },
  };
  // SAFETY: The double supplies every context member the handlers under test read.
  return double as ExtensionContext;
}

function textOf(result: JsonRecord | undefined): string[] {
  const content = isJsonRecord(result) ? result["content"] : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    isJsonRecord(item) && isString(item["text"]) ? [item["text"]] : [],
  );
}

test("PreToolUse warns once per tool and directory about /tmp writes outside scratch, without blocking", async (t) => {
  t.mock.method(HookEngine.prototype, "run", async (input: HookInput) =>
    mergeResults(input.hook_event_name, []),
  );
  // The scratch root comes from the registry here, not from a host session's environment.
  for (const name of ["PI_SCRATCH_DIR", "PI_ROOT_SESSION_ID", "PI_PREVIOUS_SCRATCH_DIR"]) {
    const previous = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (previous !== undefined) process.env[name] = previous;
    });
  }
  const home = await mkdtemp(join(tmpdir(), "hooks-scratch-home-"));
  const previousHome = process.env["HOME"];
  process.env["HOME"] = home;
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ scratchGrants: ["/tmp/hooks-scratch-granted"] }),
  );
  registerScratchRoot("child", "root");
  const hooks = await activate();
  const scratchDir = scratchDirFor("root");
  const ctx = sessionContext("child");
  const run = async (id: string, toolName: string, input: Record<string, string>) => {
    const call = await hooks.emit("tool_call", { toolCallId: id, toolName, input }, ctx);
    assert.equal(call, undefined, "a warning never blocks the call");
    return textOf(
      await hooks.emit(
        "tool_result",
        {
          toolCallId: id,
          toolName,
          input,
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
        ctx,
      ),
    );
  };
  try {
    await hooks.emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(await run("a", "write", { path: `${scratchDir}x.txt` }), []);
    assert.deepEqual(await run("b", "write", { path: "/tmp/hooks-scratch-granted/x.txt" }), []);
    assert.deepEqual(await run("c", "write", { path: "/tmp/hooks-scratch-stray/x.txt" }), [
      "ok",
      `Scratch path warning: /tmp/hooks-scratch-stray/x.txt is outside this session's scratch directory ${scratchDir}. Use ${scratchDir} for temporary files unless the user granted this path.`,
    ]);
    assert.deepEqual(await run("d", "write", { path: "/tmp/hooks-scratch-stray/y.txt" }), []);
    const patch =
      "*** Begin Patch\n*** Add File: /tmp/hooks-scratch-patch/z.txt\n+z\n*** End Patch";
    assert.equal((await run("e", "apply_patch", { input: patch })).length, 2);
  } finally {
    await hooks.emit("session_shutdown", { reason: "quit" }, ctx);
    hooks.dispose();
    unregisterScratchRoot("child");
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
