import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { createNestedTools } from "../src/adapter/code-mode.ts";
import { toNestedTool } from "../src/adapter/code-mode/nested-tool-adapter.ts";
import type { CodexExtensionRuntime } from "../src/extension/runtime.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { renderTraceAndOutput } from "../src/tools/code-mode/trace-rendering.ts";
import { createExecCommandTracker } from "../src/tools/exec/command-state.ts";
import { createExecCommandTool } from "../src/tools/exec/command-tool.ts";
import { createLazyExecSessionManager } from "../src/tools/exec/lazy-session-manager.ts";
import { renderExecCommandCall } from "../src/ui/tool-rendering/codex-rendering.ts";

const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const COMMAND_LINES = [
  "printf 'first'",
  `printf '${"x".repeat(120)}'`,
  "printf\t'third'",
  "printf 'fourth'",
  "printf 'fifth'",
  "printf 'sixth'",
];
const COMMAND = COMMAND_LINES.join("\n");

function unexpectedRuntimeAccess(): never {
  throw new Error("Rendering must not access runtime execution services");
}

function createRenderingRuntime(): CodexExtensionRuntime {
  return {
    state: {
      enabled: true,
      cwd: "/workspace",
      promptSkills: [],
      config: structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
      executionMode: "code",
      codexTurnState: createCodexTurnState(),
    },
    tracker: createExecCommandTracker(),
    sessions: createLazyExecSessionManager({ env: {} }),
    execEnv: unexpectedRuntimeAccess,
    codexSystemPrompt: unexpectedRuntimeAccess,
    startPrewarm: unexpectedRuntimeAccess,
    startCompactionPrewarm: unexpectedRuntimeAccess,
    startKeepalivePrewarm: unexpectedRuntimeAccess,
    armCacheKeepalive: unexpectedRuntimeAccess,
    cancelCacheKeepalive: unexpectedRuntimeAccess,
    captureCacheKeepaliveRequest: unexpectedRuntimeAccess,
    resetTransport: unexpectedRuntimeAccess,
    resetTransportAfterCompaction: unexpectedRuntimeAccess,
    shutdownTransport: unexpectedRuntimeAccess,
    waitForPrewarm: unexpectedRuntimeAccess,
    prewarmIdentity: unexpectedRuntimeAccess,
    configureDiagnostics: unexpectedRuntimeAccess,
    diagnosticsSink: unexpectedRuntimeAccess,
    shutdownDiagnostics: unexpectedRuntimeAccess,
  };
}

function assertCompleteSource(rendered: string): void {
  for (const line of COMMAND_LINES) {
    assert.ok(rendered.includes(line.replace(/\t/g, "   ")), `Missing source: ${line}`);
  }
  assert.doesNotMatch(rendered, /\t|\.\.\./);
}

function renderDirectCommand(expanded?: boolean): string {
  const runtime = createRenderingRuntime();
  // The production adapter exposes the native callback with its minimal render context.
  const tool = toNestedTool(createExecCommandTool(runtime.tracker, runtime.sessions), "");
  assert.ok(tool.renderCall);
  return tool
    .renderCall({ cmd: COMMAND }, PLAIN_THEME, { toolCallId: "direct", expanded })
    .render(400)
    .join("\n");
}

test("expanded native exec calls retain all six lines and the full long argument", () => {
  assertCompleteSource(renderDirectCommand(true));
});

test("collapsed and unspecified native exec calls keep the existing source limits", () => {
  for (const expanded of [false, undefined]) {
    const rendered = renderDirectCommand(expanded);
    assert.ok(rendered.includes("printf   'third'"));
    assert.doesNotMatch(rendered, /\t/);
    assert.ok(rendered.includes(COMMAND_LINES[4]!));
    assert.ok(!rendered.includes(COMMAND_LINES[5]!));
    assert.ok(!rendered.includes(COMMAND_LINES[1]!));
    assert.equal(rendered.split("\n").length, 7);
    assert.equal(rendered.split("\n").at(-1)?.trim(), "...");
  }
});

test("expanded nested exec traces use the real catalog's native renderer without truncation", () => {
  const catalog = createNestedTools(createRenderingRuntime(), new Set(["bash"]));
  const native = catalog.find((tool) => tool.name === "exec_command");
  assert.ok(native?.renderCall);
  const rendered = renderTraceAndOutput(
    [{ id: "nested", name: "exec_command", input: { cmd: COMMAND }, status: "done" }],
    0,
    catalog,
    new Container(),
    false,
    { expanded: true, isPartial: false },
    PLAIN_THEME,
    { toolCallId: "parent", cwd: "/workspace" },
    new Map(),
  )
    .render(400)
    .join("\n");
  assert.match(rendered, /^1\. • Ran\s*\n/);
  assertCompleteSource(rendered);
});

test("expanded command source normalizes tabs and bypasses exploration summaries", () => {
  assert.equal(
    renderExecCommandCall("cat\t'file'", "done", PLAIN_THEME, true),
    "• Ran\n  └ cat   'file'",
  );
});
