import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { renderTraceAndOutput } from "../src/tools/code-mode/trace-rendering.ts";
import type { RuntimeToolTrace } from "../src/tools/code-mode/types.ts";

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
