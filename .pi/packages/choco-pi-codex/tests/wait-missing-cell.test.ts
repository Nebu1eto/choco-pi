import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CodeModeExecutionClient,
  SharedCodeModeRuntime,
} from "../src/tools/code-mode/shared-runtime.ts";
import type { RuntimeResponse } from "../src/tools/code-mode/types.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const sourceUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
      if (existsSync(sourceUrl)) return nextResolve(sourceUrl.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { registerPublicCodeModeTools } = await import("../src/tools/code-mode/public-tools.ts");

type WaitResult = {
  content: Array<{ type: string; text?: string }>;
  details: { codeMode: boolean; cellId: string; status: string };
  isError?: boolean;
};

type WaitTool = {
  name: string;
  execute(
    id: string,
    params: { cell_id: string; yield_time_ms?: number; terminate?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ): Promise<WaitResult>;
};

function registerWaitTool(client: CodeModeExecutionClient): WaitTool {
  const tools: WaitTool[] = [];
  // SAFETY: The fixture supplies every ExtensionAPI member exercised by tool registration.
  const pi = {
    registerTool(tool: WaitTool) {
      tools.push(tool);
    },
    events: {
      emit() {},
      on() {},
    },
    on() {},
  } as ExtensionAPI;
  // SAFETY: The fixture supplies every SharedCodeModeRuntime member exercised by the wait tool.
  const runtime = {
    getClient: () => Promise.resolve(client),
    collectTools: () => [],
    collectRenderTools: () => [],
    useRichRendering: () => false,
  } as SharedCodeModeRuntime;

  registerPublicCodeModeTools(pi, runtime);
  const wait = tools.find((tool) => tool.name === "wait");
  assert.ok(wait);
  return wait;
}

function response(kind: RuntimeResponse["kind"], cellId: string): RuntimeResponse {
  if (kind === "yielded") return { kind, cellId, contentItems: [] };
  if (kind === "terminated") return { kind, cellId, contentItems: [] };
  return { kind, cellId, contentItems: [] };
}

test("missing wait cell returns guidance and clears adaptive wait attempts", async () => {
  const waits: number[] = [];
  let waitCount = 0;
  // SAFETY: The fixture implements every execution-client method and each exercised response shape.
  const client = {
    execute: () => Promise.reject(new Error("not used")),
    wait(cellId: string, yieldTimeMs: number) {
      waits.push(yieldTimeMs);
      waitCount += 1;
      if (waitCount === 1) return Promise.resolve(response("yielded", cellId));
      return Promise.resolve({
        ...response("result", cellId),
        missingCell: true as const,
        errorText: `exec cell ${cellId} not found`,
      });
    },
    terminate: () => Promise.reject(new Error("not used")),
    shutdown: () => Promise.resolve(),
  } as CodeModeExecutionClient;
  const wait = registerWaitTool(client);

  await wait.execute(
    "wait-1",
    { cell_id: "stale-cell", yield_time_ms: 1_000 },
    undefined,
    undefined,
    { cwd: "/work" },
  );
  const missing = await wait.execute(
    "wait-2",
    { cell_id: "stale-cell", yield_time_ms: 1_000 },
    undefined,
    undefined,
    { cwd: "/work" },
  );
  await wait.execute(
    "wait-3",
    { cell_id: "stale-cell", yield_time_ms: 1_000 },
    undefined,
    undefined,
    { cwd: "/work" },
  );

  assert.deepEqual(waits, [5_000, 10_000, 5_000]);
  assert.deepEqual(missing, {
    content: [
      {
        type: "text",
        text: 'Exec cell "stale-cell" does not exist in this session. Exec cells do not survive a session restart and cannot be referenced across sessions. Re-run the script with exec instead of waiting.',
      },
    ],
    details: {
      codeMode: true,
      cellId: "stale-cell",
      status: "result",
    },
  });
  assert.equal(missing.isError, undefined);
});

test("terminating a missing cell reports that it is already gone", async () => {
  // SAFETY: The fixture implements every execution-client method and the exercised response shape.
  const client = {
    execute: () => Promise.reject(new Error("not used")),
    wait: () => Promise.reject(new Error("not used")),
    terminate(cellId: string) {
      return Promise.resolve({
        ...response("result", cellId),
        missingCell: true as const,
        errorText: `exec cell ${cellId} not found`,
      });
    },
    shutdown: () => Promise.resolve(),
  } as CodeModeExecutionClient;
  const wait = registerWaitTool(client);

  const result = await wait.execute(
    "wait-terminate",
    { cell_id: "gone-cell", terminate: true },
    undefined,
    undefined,
    { cwd: "/work" },
  );

  assert.deepEqual(result, {
    content: [{ type: "text", text: 'Exec cell "gone-cell" is already gone.' }],
    details: {
      codeMode: true,
      cellId: "gone-cell",
      status: "terminated",
    },
  });
  assert.equal(result.isError, undefined);
});
