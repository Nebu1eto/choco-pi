import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../src/agent-types.ts";
import type { AgentConfig } from "../src/types.ts";
import type { NotificationDetails } from "../src/types.ts";
import { renderSubagentNotification } from "../src/ui/notification-render.ts";

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the named slice exercised by its subject.
  return fixture as T;
}

const theme = partialFixture<Theme>({
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
});

function notificationFixture(overrides: Partial<NotificationDetails> = {}): NotificationDetails {
  return {
    id: "agent-1",
    description: "Review notification rendering",
    status: "completed",
    toolUses: 2,
    turnCount: 3,
    maxTurns: 5,
    totalTokens: 1_500,
    durationMs: 2_500,
    resultPreview: "All done.",
    ...overrides,
  };
}

test("renders a successful completion in the shared transcript style", () => {
  const output = renderSubagentNotification(
    notificationFixture({ outputFile: "/var/folders/cache/tasks/agent-1.output" }),
    { expanded: false },
    theme,
  );

  assert.equal(
    output,
    [
      "✓ Agent completed",
      "  └ Review notification rendering · ↻3≤5 · 2 tool uses · 1.5k token · 2.5s",
      "    All done.",
      "    Transcript · …/tasks/agent-1.output",
    ].join("\n"),
  );
});

test("carries the agent role badge, falling back to a generic label", () => {
  // The badge comes from the agent registry, exactly as the launch row resolves it.
  registerAgents(
    new Map([
      [
        "implementer",
        partialFixture<AgentConfig>({
          name: "implementer",
          displayName: "implementer",
          description: "implementation leaf",
        }),
      ],
    ]),
  );
  const typed = renderSubagentNotification(
    notificationFixture({ type: "implementer" }),
    { expanded: false },
    theme,
  );
  assert.match(typed.split("\n")[0] ?? "", /implementer completed$/);

  const untyped = renderSubagentNotification(notificationFixture(), { expanded: false }, theme);
  assert.match(untyped.split("\n")[0] ?? "", /Agent completed$/);
  registerAgents(new Map());
});

test("distinguishes error, stopped, and aborted outcomes", () => {
  const error = renderSubagentNotification(
    notificationFixture({
      status: "error",
      error: "model unavailable",
      resultPreview: "No output.",
    }),
    { expanded: false },
    theme,
  );
  const stopped = renderSubagentNotification(
    notificationFixture({ status: "stopped", resultPreview: "Partial answer" }),
    { expanded: false },
    theme,
  );
  const aborted = renderSubagentNotification(
    notificationFixture({ status: "aborted", resultPreview: "Turn limit reached" }),
    { expanded: false },
    theme,
  );

  assert.match(error, /^✗ Agent failed$/m);
  assert.match(error, /^    Error: model unavailable$/m);
  assert.match(stopped, /^■ Agent stopped$/m);
  assert.match(stopped, /^    Partial answer$/m);
  assert.match(aborted, /^✗ Agent aborted$/m);
  assert.match(aborted, /^    Turn limit reached$/m);
});

test("labels steered completions as wrapped up", () => {
  const output = renderSubagentNotification(
    notificationFixture({ status: "steered", resultPreview: "Delivered a bounded result" }),
    { expanded: false },
    theme,
  );

  assert.match(output, /^✓ Agent wrapped up$/m);
  assert.match(output, /^    Delivered a bounded result$/m);
});

test("collapses to one result line and expands to the bounded result body", () => {
  const details = notificationFixture({ resultPreview: "first line\nsecond line\nthird line" });
  const collapsed = renderSubagentNotification(details, { expanded: false }, theme);
  const expanded = renderSubagentNotification(details, { expanded: true }, theme);

  assert.match(collapsed, /^    first line$/m);
  assert.doesNotMatch(collapsed, /second line/);
  assert.match(expanded, /^    first line$/m);
  assert.match(expanded, /^    second line$/m);
  assert.match(expanded, /^    third line$/m);
});

test("renders grouped notifications as adjacent complete blocks", () => {
  const output = renderSubagentNotification(
    notificationFixture({
      others: [
        notificationFixture({
          id: "agent-2",
          description: "Second task",
          status: "stopped",
          resultPreview: "Stopped by user",
        }),
      ],
    }),
    { expanded: false },
    theme,
  );

  assert.equal(output.match(/^(?:✓|■) Agent /gm)?.length, 2);
  assert.match(output, /    All done\.\n■ Agent stopped\n  └ Second task/);
});

test("omits the transcript row when outputFile is absent", () => {
  const output = renderSubagentNotification(notificationFixture(), { expanded: false }, theme);

  assert.doesNotMatch(output, /Transcript/);
});

test("bounds long descriptions and transcript paths", () => {
  const output = renderSubagentNotification(
    notificationFixture({
      description: "description ".repeat(40),
      outputFile: `/var/folders/${"nested/".repeat(30)}tasks/${"x".repeat(140)}.output`,
    }),
    { expanded: false },
    theme,
  );
  const detail = output.split("\n").find((line) => line.startsWith("  └ "));
  const transcript = output.split("\n").find((line) => line.includes("Transcript"));

  assert.ok(detail);
  assert.ok(transcript);
  assert.ok(detail.length <= 124);
  assert.match(detail, /\.\.\. · ↻3≤5/);
  assert.ok(transcript.length <= 119);
  assert.match(transcript, /^    Transcript · …\/tasks\/x+\.\.\.$/);
  assert.doesNotMatch(transcript, /\/var\/folders/);
});
