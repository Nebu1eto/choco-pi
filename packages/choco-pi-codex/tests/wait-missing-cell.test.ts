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
import type { CodeModeToolDefinition } from "../src/tools/code-mode/types.ts";
import { WAIT_DESCRIPTION } from "../src/tools/code-mode/custom-tool-prompt.ts";

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

interface StubRegisterApi {
  registerTool(tool: WaitTool): void;
  events: ExtensionAPI["events"];
  on(event: string, handler: () => void): void;
}

type StubEvents = Pick<ExtensionAPI["events"], "on" | "emit">;

type RuntimeStub = Pick<
  SharedCodeModeRuntime,
  "getClient" | "collectTools" | "collectRenderTools" | "useRichRendering"
>;

function registerWaitTool(
  client: CodeModeExecutionClient,
  nestedTools: CodeModeToolDefinition[] = [],
): WaitTool {
  const tools: WaitTool[] = [];
  const stubEvents: StubEvents = {
    on: () => () => {},
    emit() {},
  };
  const stubPi: StubRegisterApi = {
    registerTool(tool) {
      tools.push(tool);
    },
    // SAFETY: The fixture supplies the on and emit members the preflight broker exercises.
    events: stubEvents as ExtensionAPI["events"],
    on() {},
  };
  // SAFETY: The fixture supplies the registerTool member registerPublicCodeModeTools exercises.
  const pi = stubPi as ExtensionAPI;
  const runtimeStub: RuntimeStub = {
    getClient: () => Promise.resolve(client),
    collectTools: () => nestedTools,
    collectRenderTools: () => [],
    useRichRendering: () => false,
  };
  // SAFETY: The fixture supplies every SharedCodeModeRuntime member the wait tool exercises.
  const runtime = runtimeStub as SharedCodeModeRuntime;

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
  assert.equal("isError" in missing, false);
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
  assert.equal("isError" in result, false);
});

test("wait distinguishes exec cells from managed command sessions", () => {
  assert.match(WAIT_DESCRIPTION, /Cell IDs do not survive restart/);
  assert.match(WAIT_DESCRIPTION, /exec_command session IDs belong to write_stdin/);
});

test("numeric missing cell resumes an available exec session exactly once", async () => {
  const invocations: unknown[] = [];
  const writeStdin: CodeModeToolDefinition = {
    name: "write_stdin",
    usage: "await tools.write_stdin({ session_id: 7 })",
    deferLoading: false,
    kind: "function",
    async invoke(input) {
      invocations.push(input);
      return { output: "resumed output", exit_code: 0 };
    },
  };
  const client: CodeModeExecutionClient = {
    execute() {
      throw new Error("execute not used");
    },
    wait(cellId) {
      return Promise.resolve({
        ...response("result", cellId),
        missingCell: true,
        errorText: `exec cell ${cellId} not found`,
      });
    },
    terminate() {
      throw new Error("terminate not used");
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  const wait = registerWaitTool(client, [writeStdin]);
  const resumed = await wait.execute(
    "wait-resume",
    { cell_id: "7", yield_time_ms: 1_000 },
    undefined,
    undefined,
    { cwd: "/work" },
  );

  assert.deepEqual(invocations, [{ session_id: 7, yield_time_ms: 1_000 }]);
  assert.deepEqual(
    resumed.content.map((item) => item.text),
    [
      "Recovered wait cell_id 7 as exec_command session_id 7 and continued it with write_stdin",
      "resumed output",
      "Process exited with code 0",
    ],
  );

  const denied = registerWaitTool(client);
  const missing = await denied.execute(
    "wait-denied",
    { cell_id: "7", yield_time_ms: 1_000 },
    undefined,
    undefined,
    { cwd: "/work" },
  );
  assert.match(missing.content[0]?.text ?? "", /does not exist in this session/);
  assert.equal(invocations.length, 1);
});
