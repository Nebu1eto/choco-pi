import assert from "node:assert/strict";
import test from "node:test";
import { Container, getCapabilities, setCapabilities, Text } from "@earendil-works/pi-tui";
import { toNestedTool } from "../src/adapter/code-mode/nested-tool-adapter.ts";
import { createCodeModeRenderTracker } from "../src/tools/code-mode/render-tracker.ts";
import { renderTrackedCodeModeResult } from "../src/tools/code-mode/result-rendering.ts";
import { createViewImageTool } from "../src/tools/view-image/tool.ts";
import { renderTraceAndOutput } from "../src/tools/code-mode/trace-rendering.ts";
import type {
  CodeModeRenderContext,
  ProgrammaticCodeModeToolDefinition,
  RuntimeToolResult,
  RuntimeToolTrace,
} from "../src/tools/code-mode/types.ts";

const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};

function renderCommand(
  cmd: string,
  options: {
    description?: string;
    expanded?: boolean;
    status?: RuntimeToolTrace["status"];
    error?: string;
  } = {},
): string {
  const trace: RuntimeToolTrace = {
    id: "trace-1",
    name: "exec_command",
    input: { cmd, description: options.description },
    status: options.status ?? "done",
    error: options.error,
  };
  return renderTraceAndOutput(
    [trace],
    0,
    [],
    new Container(),
    false,
    { expanded: options.expanded ?? false, isPartial: false },
    PLAIN_THEME,
    { toolCallId: "call-1", cwd: "/workspace" },
    new Map(),
  )
    .render(240)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("collapsed exec items keep their description but hide shell command summaries", () => {
  const rendered = renderCommand("mise run check && git status --short", {
    description: "Validate workspace",
  });
  assert.match(rendered, /Ran Exec command · Validate workspace$/);
  assert.doesNotMatch(rendered, /mise|git/);
});

test("collapsed exec items do not show a shell summary without a description", () => {
  const rendered = renderCommand("printf done");
  assert.equal(rendered, "1. • Ran Exec command");
});

test("expanded exec items retain the full shell command and errors", () => {
  const cmd = "mise run check -- --fix";
  const expanded = renderCommand(cmd, {
    expanded: true,
    status: "error",
    error: "task failed",
  });
  assert.match(expanded, /Failed exec_command/);
  assert.match(expanded, /mise run check -- --fix/);
  assert.match(expanded, /task failed/);
});

function renderNestedResult(
  trace: RuntimeToolTrace,
  tool: ProgrammaticCodeModeToolDefinition,
  context: CodeModeRenderContext = {},
): string {
  return renderTrackedCodeModeResult(
    { content: [], details: { status: "result", traces: [trace] } },
    { expanded: true, isPartial: false },
    PLAIN_THEME,
    context,
    createCodeModeRenderTracker(),
    [tool],
  )
    .render(240)
    .join("\n");
}

test("throwing custom result renderers retain generic output, call headers and errors", () => {
  for (const status of ["done", "error"] as const) {
    let renderedAsError: boolean | undefined;
    const tool: ProgrammaticCodeModeToolDefinition = {
      name: "synthetic",
      usage: "",
      kind: "function",
      deferLoading: false,
      invoke: async () => undefined,
      renderCall: () => new Text("custom call header", 0, 0),
      renderResult: (_result, _options, _theme, context) => {
        renderedAsError = context.isError;
        throw new Error("renderer failed");
      },
    };
    const rendered = renderNestedResult(
      {
        id: "nested",
        name: tool.name,
        input: {},
        status,
        result: { content: [{ type: "text", text: "generic result body" }] },
        error: status === "error" ? "tool execution failed" : undefined,
      },
      tool,
    );
    assert.equal(renderedAsError, status === "error");
    assert.match(rendered, /^1\. custom call header/);
    assert.match(rendered, /generic result body/);
    if (status === "error") assert.match(rendered, /tool execution failed/);
  }
});

test("successful custom result renderers do not duplicate generic output", () => {
  const tool: ProgrammaticCodeModeToolDefinition = {
    name: "synthetic",
    usage: "",
    kind: "function",
    deferLoading: false,
    invoke: async () => undefined,
    renderResult: () => new Text("custom result body", 0, 0),
  };
  const rendered = renderNestedResult(
    {
      id: "nested",
      name: tool.name,
      input: {},
      status: "done",
      result: { content: [{ type: "text", text: "generic result body" }] },
    },
    tool,
  );
  assert.match(rendered, /custom result body/);
  assert.doesNotMatch(rendered, /generic result body/);
});

test("nested view_image preserves the outer image preference and matches direct rendering", () => {
  const capabilities = getCapabilities();
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const colorterm = process.env.COLORTERM;
  const mosaic = process.env.CHOCO_PI_IMAGE_MOSAIC;
  try {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    process.env.COLORTERM = "truecolor";
    delete process.env.CHOCO_PI_IMAGE_MOSAIC;
    const tool = toNestedTool(createViewImageTool(), "");
    assert.ok(tool.renderResult);
    const result: RuntimeToolResult = {
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAH0lEQVR4AQXBAQEAAACAEP9PFyIqolARFYmoiEJFVDQsUB/hTURbbQAAAABJRU5ErkJggg==",
        },
      ],
    };
    for (const showImages of [false, true, undefined]) {
      const context = { showImages, cwd: "/workspace", args: { path: "checkerboard.png" } };
      const direct = tool
        .renderResult(result, { expanded: true, isPartial: false }, PLAIN_THEME, context)
        .render(240)
        .join("\n");
      const nested = renderNestedResult(
        { id: "nested", name: tool.name, input: context.args, status: "done", result },
        tool,
        context,
      );
      assert.ok(nested.endsWith(direct));
      assert.match(nested, /checkerboard\.png/);
      if (showImages === false) {
        assert.doesNotMatch(direct, /▀/);
        assert.doesNotMatch(nested, /▀/);
      } else {
        assert.match(direct, /▀/);
        assert.match(nested, /▀/);
      }
    }
  } finally {
    setCapabilities(capabilities);
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    if (colorterm === undefined) delete process.env.COLORTERM;
    else process.env.COLORTERM = colorterm;
    if (mosaic === undefined) delete process.env.CHOCO_PI_IMAGE_MOSAIC;
    else process.env.CHOCO_PI_IMAGE_MOSAIC = mosaic;
  }
});
