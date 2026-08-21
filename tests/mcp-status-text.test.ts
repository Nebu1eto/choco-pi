import assert from "node:assert/strict";
import test from "node:test";

import {
  createStatusWriteFailureReporter,
  formatAccentStatusText,
  writeAccentStatus,
  writeStatus,
  type StatusWriteFailureReporter,
} from "../.pi/packages/choco-pi-mcp/status-text.ts";

function describeError<BoundaryValue>(error: BoundaryValue): string {
  return error instanceof Error ? error.message : String(error);
}

function collectFailures(into: string[]): StatusWriteFailureReporter {
  return (error) => {
    into.push(describeError(error));
  };
}

test("a usable theme colours the status text", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
  assert.equal(formatAccentStatusText(theme, "2 servers enabled"), "<accent>2 servers enabled");
});

test("the plain text survives a theme that cannot colour it", () => {
  assert.equal(formatAccentStatusText(undefined, "2 servers"), "2 servers");
  assert.equal(formatAccentStatusText({}, "2 servers"), "2 servers");
  assert.equal(
    formatAccentStatusText({ fg: undefined }, "2 servers"),
    "2 servers",
    "a theme without a callable fg must not throw",
  );
});

test("a theme that throws or answers with a non-string falls back", () => {
  const throwing = {
    fg: () => {
      throw new Error("Unknown theme color: accent");
    },
  };
  assert.equal(formatAccentStatusText(throwing, "2 servers"), "2 servers");

  const blank = { fg: () => "" };
  assert.equal(formatAccentStatusText(blank, "2 servers"), "2 servers");

  // A host theme answering every member from a trap, the way Pi's global theme
  // does, can hand back something that is not the string the caller expects.
  const wrongType = new Proxy({}, { get: () => () => 7 });
  assert.equal(formatAccentStatusText(wrongType, "2 servers"), "2 servers");
});

test("the theme keeps its receiver when the status is coloured", () => {
  const theme = {
    prefix: "nord",
    fg(color: string, text: string): string {
      return `${this.prefix}:${color}:${text}`;
    },
  };
  assert.equal(formatAccentStatusText(theme, "ok"), "nord:accent:ok");
});

test("a host that refuses the status write cannot fail the caller", () => {
  // `updateStatusBar` runs from nineteen call sites, only one of which used to
  // have a boundary. A footer write must never be able to fail initialization,
  // a lifecycle callback, a slash command, or a tool call.
  const failures: string[] = [];
  const ui = {
    setStatus(): void {
      throw new Error("ui.setStatus is not a function");
    },
  };
  const reportFailure = collectFailures(failures);
  assert.doesNotThrow(() => writeStatus(ui, "mcp", "2 servers", reportFailure));
  assert.doesNotThrow(() => writeAccentStatus(ui, "mcp", "2 servers", reportFailure));
  assert.deepEqual(failures, ["ui.setStatus is not a function", "ui.setStatus is not a function"]);
});

test("a theme the host cannot resolve cannot fail the caller", () => {
  // The theme arrives as a property on a host object, so resolving it can
  // throw before `formatAccentStatusText` ever sees a value.
  const failures: string[] = [];
  const written: (string | undefined)[] = [];
  const ui = {
    get theme(): undefined {
      throw new Error("theme is unavailable");
    },
    setStatus(_key: string, content: string | undefined): void {
      written.push(content);
    },
  };
  assert.doesNotThrow(() => writeAccentStatus(ui, "mcp", "2 servers", collectFailures(failures)));
  assert.deepEqual(written, [], "the write never reached the host");
  assert.deepEqual(failures, ["theme is unavailable"]);
});

test("a successful write reaches the host unchanged", () => {
  const failures: string[] = [];
  const written: string[] = [];
  const ui = {
    theme: { fg: (color: string, text: string) => `<${color}>${text}` },
    setStatus(key: string, content: string | undefined): void {
      written.push(`${key}=${content ?? ""}`);
    },
  };
  writeStatus(ui, "mcp", "connecting to 2 servers...", collectFailures(failures));
  writeStatus(ui, "mcp", undefined, collectFailures(failures));
  writeAccentStatus(ui, "mcp", "2 servers", collectFailures(failures));
  assert.deepEqual(written, ["mcp=connecting to 2 servers...", "mcp=", "mcp=<accent>2 servers"]);
  assert.deepEqual(failures, []);
});

test("a repeating status failure is reported once per distinct message", () => {
  // The status bar repaints on every server state change, so an unusable host
  // UI would otherwise repeat one warning for the whole session.
  const reported: string[] = [];
  const reportFailure = createStatusWriteFailureReporter(describeError, (message) => {
    reported.push(message);
  });
  const ui = {
    setStatus(): void {
      throw new Error("ui.setStatus is not a function");
    },
  };
  for (let repaint = 0; repaint < 5; repaint++) writeStatus(ui, "mcp", "2 servers", reportFailure);
  assert.deepEqual(reported, ["ui.setStatus is not a function"]);

  reportFailure(new Error("theme is unavailable"));
  assert.deepEqual(reported, ["ui.setStatus is not a function", "theme is unavailable"]);
});

test("the reported-failure record stays bounded", () => {
  const reported: string[] = [];
  const reportFailure = createStatusWriteFailureReporter(describeError, (message) => {
    reported.push(message);
  });
  for (let attempt = 0; attempt < 40; attempt++) reportFailure(new Error(`failure ${attempt}`));
  assert.equal(reported.length, 40, "every distinct failure is reported once");

  reportFailure(new Error("failure 0"));
  assert.equal(
    reported.at(-1),
    "failure 0",
    "a message dropped from the bounded record can be reported again",
  );
});
