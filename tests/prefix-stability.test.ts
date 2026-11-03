import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { arr, compile, num, obj, str } from "@earendil-works/pi-schema";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import toolSearch, { ALWAYS_ACTIVE_TOOL_NAMES } from "../.pi/extensions/tool-search.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const PrefixBudgetCaptureSchema = obj(
  {
    model: str(),
    before: obj({ total: num(), system: num(), tools: num() }, { open: true }),
    after: obj({ total: num(), system: num(), tools: num() }, { open: true }),
    codeModeTools: num(),
    rewrites: num(),
    toolNames: arr(str()),
  },
  { open: true },
);

const isPrefixBudgetCapture = compile(PrefixBudgetCaptureSchema).check;

async function readCapture(path: string) {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isPrefixBudgetCapture(parsed)) throw new Error("Invalid U2 prefix capture");
  return parsed;
}

test("live Opus native surface matches the capture and stays within its budget", async () => {
  const capture = await readCapture(
    fileURLToPath(new URL("./fixtures/u2-prefix-capture.json", import.meta.url)),
  );
  const codeModeOwnedDirectTools = new Set([
    "read",
    "bash",
    "edit",
    "write",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "view_image",
    "image_gen__imagegen",
  ]);
  const liveToolNames = ALWAYS_ACTIVE_TOOL_NAMES.filter(
    (toolName) => !codeModeOwnedDirectTools.has(toolName),
  );
  const toolSearchIndex = liveToolNames.indexOf("tool_search");
  if (toolSearchIndex >= 0) {
    liveToolNames.splice(toolSearchIndex, 1);
    liveToolNames.push("tool_search");
  }

  assert.ok(liveToolNames.length <= 14);
  assert.deepEqual(liveToolNames, capture.toolNames);
  assert.equal(capture.rewrites, 0);
});

/** The context members the tool-search policy reads: a fresh session with no recorded tools. */
interface FreshSessionContext {
  sessionManager: { getBranch(): [] };
}

test("never changes active tools after the first before_agent_start", async () => {
  let activeTools = ["read", "exec_command"];
  const registeredTools: Array<{
    name: string;
    description: string;
    parameters: object;
  }> = [];
  type LifecycleHandler = (event: { type: string }, ctx: FreshSessionContext) => void;
  const lifecycleHandlers = new Map<string, LifecycleHandler>();
  const emitLifecycle = (type: string) =>
    lifecycleHandlers.get(type)?.({ type }, { sessionManager: { getBranch: () => [] } });
  const eventHandlers = new Map<string, (payload: RuntimeValue) => void>();
  const commits: string[][] = [];
  const events = createEventBus();

  toolSearch(
    reinterpretHostValue<Parameters<typeof toolSearch>[0]>({
      registerTool: (tool: { name: string; description: string; parameters: object }) => {
        registeredTools.push(tool);
      },
      getAllTools: () =>
        [...activeTools, "synthetic_web_search", ...registeredTools.map((tool) => tool.name)].map(
          (name) => ({
            name,
            description: name,
            parameters: {},
            sourceInfo: { source: "extension", path: name },
          }),
        ),
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        commits.push([...names]);
        activeTools = [...names];
      },
      events: {
        on: (name: string, handler: (payload: RuntimeValue) => void) => {
          eventHandlers.set(name, handler);
          return events.on(name, handler);
        },
        emit: events.emit.bind(events),
      },
      on: (name: string, handler: LifecycleHandler) => {
        lifecycleHandlers.set(name, handler);
      },
    }),
  );

  emitLifecycle("session_start");
  emitLifecycle("before_agent_start");
  const commitsAfterFirstRequest = commits.length;

  activeTools = [...activeTools, "synthetic_web_search"];
  eventHandlers.get("pi-mcp-adapter/status/v1")?.({ servers: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    commits.length,
    commitsAfterFirstRequest,
    "setActiveTools must not be called after the first before_agent_start",
  );
});
