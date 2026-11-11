import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import {
  delegationRenderers,
  NOTIFICATION_REPLY_MAX_BYTES,
  notificationVerdictReply,
  renderVerdictNotification,
} from "../src/delegation-render.ts";
import type { NotificationDetails } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

initTheme("dark", false);

const FENCE = "\u0060\u0060\u0060";
const FINDINGS = {
  schema: 1,
  verdict: "FINDINGS",
  bundleDigest: "sha256:u26bundle",
  findings: [
    {
      id: "F1",
      class: "finding",
      severity: "high",
      path: "notes.txt",
      startLine: 1,
      endLine: 2,
      invariant: "notes.txt keeps two lines",
      evidence: "reproduction",
      reproduction: "wc -l notes.txt",
    },
    {
      id: "C1",
      class: "candidate",
      severity: "low",
      path: "notes.txt",
      invariant: "line two stays last",
      evidence: "code_path",
      reproduction: "",
    },
  ],
};
const BLOCK = FENCE + "choco-pi-review\n" + JSON.stringify(FINDINGS, null, 2) + "\n" + FENCE;
const REPLY = "## Findings\n\n1. HIGH notes.txt:1-2 loses a line.\n\n" + BLOCK;
const PARSED_LINE =
  "Verdict record: parsed (FINDINGS, 1 finding, 1 candidate) -> /tmp/verdicts/t/a.json";
const HEADER = "Agent completed in 1.0s (2 tool uses).\n\n";

const renderContext = {
  args: { subagent_type: "reviewer", description: "Review" },
  toolCallId: "verdict-card",
  invalidate: () => {},
  lastComponent: undefined,
  state: undefined,
  cwd: process.cwd(),
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError: false,
  durationMs: undefined,
  outputPad: 0,
  keyText: (keybinding: string) => keybinding,
  keyHint: (keybinding: string, description: string) => `${keybinding} ${description}`,
};

const details = {
  displayName: "Reviewer",
  description: "Review",
  subagentType: "reviewer",
  toolUses: 2,
  tokens: "",
  durationMs: 1000,
  status: "completed" as const,
};

let theme: Theme | undefined;
let dispose: (() => void) | undefined;
test.before(async () => {
  const fixture = await createSdkFixture();
  theme = fixture.ctx.ui.theme;
  dispose = () => fixture.session.dispose();
});
test.after(() => dispose?.());

function hostTheme(): Theme {
  assert.ok(theme);
  return theme;
}

function card(text: string, expanded: boolean, width = 170): string[] {
  return delegationRenderers
    .renderResult(
      { content: [{ type: "text", text }], details },
      { expanded, isPartial: false },
      hostTheme(),
      renderContext,
    )
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd());
}

test("a recorded review card shows the summary collapsed and the raw block expanded", () => {
  const text = HEADER + REPLY + "\n\n" + PARSED_LINE;
  const collapsedLines = card(text, false);
  const doneAt = collapsedLines.findIndex((line) => line === "  ⎿  Done");
  assert.ok(doneAt > 0, collapsedLines.join("\n"));
  assert.deepEqual(collapsedLines.slice(doneAt + 1), [
    "    Review FINDINGS: 1 finding (1 high); 1 candidate (1 low)",
    "    - HIGH finding · notes.txt:1-2 · notes.txt keeps two lines",
    "    - low CANDIDATE (unconfirmed) · notes.txt · line two stays last",
    "    bundle sha256:u26bundle",
  ]);
  const collapsed = collapsedLines.join("\n");
  assert.match(collapsed, /Review FINDINGS: 1 finding \(1 high\); 1 candidate \(1 low\)/);
  assert.match(collapsed, /- HIGH finding · notes\.txt:1-2 · notes\.txt keeps two lines/);
  assert.match(collapsed, /- low CANDIDATE \(unconfirmed\) · notes\.txt · line two stays last/);
  assert.match(collapsed, /bundle sha256:u26bundle/);
  assert.doesNotMatch(collapsed, /"verdict"|choco-pi-review/);
  const expanded = card(text, true).join("\n");
  assert.match(expanded, /"verdict": "FINDINGS"/);
  assert.match(expanded, /Verdict record: parsed/);
  assert.doesNotMatch(expanded, /Review FINDINGS:/);
});

test("collapsed card lines stay within narrow widths", () => {
  const long = { ...FINDINGS.findings[0], invariant: "a very long invariant ".repeat(12) };
  const block =
    FENCE + "choco-pi-review\n" + JSON.stringify({ ...FINDINGS, findings: [long] }) + "\n" + FENCE;
  for (const width of [30, 90]) {
    for (const line of card(HEADER + block + "\n\n" + PARSED_LINE, false, width)) {
      assert.ok(visibleWidth(line) <= width, JSON.stringify(line));
    }
  }
});

test("a MISSING, INVALID or FAILED record is shown prominently and never as a summary", () => {
  const missing = card(
    HEADER +
      "No block.\n\nVerdict record: MISSING - no choco-pi-review block; this review is unrecorded and must not be reported as clean -> /x",
    false,
  ).join("\n");
  assert.match(missing, /Verdict record: MISSING/);
  const broken = FENCE + "choco-pi-review\n{ nope\n" + FENCE;
  const invalid = card(
    HEADER + broken + "\n\nVerdict record: INVALID - not valid JSON; unrecorded -> /x",
    false,
  ).join("\n");
  assert.match(invalid, /Verdict record: INVALID/);
  assert.match(
    invalid,
    /Invalid choco-pi-review block, not summarised: the verdict record above gives the parser's reason/,
  );
  assert.equal(
    invalid.split("not valid JSON").length,
    2,
    "the reason appears once, in the record line",
  );
  const failed = card(
    HEADER + REPLY + "\n\nVerdict record: FAILED - could not write the record (EACCES); unrecorded",
    false,
  ).join("\n");
  assert.match(failed, /Verdict record: FAILED - could not write the record/);
  assert.match(
    failed,
    /Invalid choco-pi-review block, not summarised: the verdict record says FAILED/,
  );
  for (const output of [missing, invalid, failed])
    assert.doesNotMatch(output, /Review FINDINGS:|HIGH finding/);
  const expandedFailed = card(
    HEADER + REPLY + "\n\nVerdict record: FAILED - x; unrecorded",
    true,
  ).join("\n");
  assert.ok(
    expandedFailed.indexOf("Verdict record: FAILED") < expandedFailed.indexOf("## Findings"),
  );
});

test("an invalid block without a record line gets the notice and no summary", () => {
  const output = card(HEADER + REPLY + "\n\nThat is all.", false).join("\n");
  assert.match(
    output,
    /Invalid choco-pi-review block, not summarised: text follows the choco-pi-review block/,
  );
  assert.doesNotMatch(output, /Review FINDINGS:/);
});

test("a reply without a block or record renders exactly as before", () => {
  const t = hostTheme();
  for (const text of [
    HEADER + "General task done. No verdict here.",
    HEADER + "Mentions choco-pi-review in prose.",
  ]) {
    for (const expanded of [false, true]) {
      const head =
        t.fg("success", "✓") +
        " " +
        t.fg("dim", "2 tool uses") +
        " " +
        t.fg("dim", "·") +
        " " +
        t.fg("dim", "1.0s");
      const rest = expanded
        ? text
            .split("\n")
            .map((line) => "\n" + t.fg("dim", `  ${line}`))
            .join("")
        : "\n" + t.fg("dim", "  ⎿  Done");
      const actual = delegationRenderers
        .renderResult(
          { content: [{ type: "text", text }], details },
          { expanded, isPartial: false },
          t,
          renderContext,
        )
        .render(120);
      const expected = new Text(head + rest, 0, 0).render(120);
      assert.equal(actual.join("\n"), expected.join("\n"));
    }
  }
});

function notification(
  resultPreview: string,
  overrides: Partial<NotificationDetails> = {},
): NotificationDetails {
  return {
    id: "agent-1",
    description: "Review the change",
    type: "reviewer",
    status: "completed",
    toolUses: 2,
    turnCount: 1,
    totalTokens: 0,
    durationMs: 1000,
    resultPreview,
    ...overrides,
  };
}

function lines(component: { render(width: number): string[] } | undefined, width = 170): string[] {
  assert.ok(component);
  return component.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
}

test("a review notification shows the summary inside its band, raw when expanded", () => {
  const details = notification(REPLY + "\n\n" + PARSED_LINE);
  const collapsed = lines(renderVerdictNotification(details, false, hostTheme()));
  const text = collapsed.join("\n");
  assert.match(text, /Delegation: Completed/);
  assert.match(text, /Review FINDINGS: 1 finding \(1 high\); 1 candidate \(1 low\)/);
  assert.match(text, /HIGH finding · notes\.txt:1-2/);
  assert.doesNotMatch(text, /^\s*\{$/m);
  assert.equal(collapsed.at(-1), "");
  const expanded = lines(renderVerdictNotification(details, true, hostTheme())).join("\n");
  assert.match(expanded, /"verdict": "FINDINGS"/);
  assert.doesNotMatch(expanded, /Review FINDINGS:/);
  // A reply that is only the block: the one-line preview is the record line, not the block's first line.
  const bare = lines(
    renderVerdictNotification(notification(BLOCK + "\n\n" + PARSED_LINE), false, hostTheme()),
  );
  const detailAt = bare.findIndex((line) => line.includes("Review the change"));
  assert.equal(bare[detailAt + 1]?.trim(), PARSED_LINE, bare.join("\n"));
  for (const line of lines(renderVerdictNotification(details, false, hostTheme()), 50)) {
    assert.ok(visibleWidth(line) <= 50, JSON.stringify(line));
  }
});

test("a notification with a failed record shows it and no summary; a plain one is unchanged", () => {
  const failed = lines(
    renderVerdictNotification(
      notification(REPLY + "\n\nVerdict record: INVALID - x; unrecorded"),
      false,
      hostTheme(),
    ),
  ).join("\n");
  assert.match(failed, /Verdict record: INVALID - x; unrecorded/);
  assert.match(failed, /the verdict record says INVALID/);
  assert.doesNotMatch(failed, /Review FINDINGS:/);
  assert.equal(
    renderVerdictNotification(notification("General task done."), false, hostTheme()),
    undefined,
  );
  const grouped = notification("Plain.", {
    others: [notification(REPLY + "\n\n" + PARSED_LINE, { id: "agent-2" })],
  });
  const groupedText = lines(renderVerdictNotification(grouped, false, hostTheme())).join("\n");
  assert.equal(groupedText.split("Review FINDINGS:").length, 2);
});

test("a truncated notification preview is summarised only from the reply kept with it", () => {
  const full = REPLY + "\n\n" + PARSED_LINE;
  const preview = full.slice(0, 300) + "…";
  const kept = notificationVerdictReply(full, preview);
  assert.equal(kept === full, true);
  assert.equal(notificationVerdictReply(full, full), undefined, "a whole preview needs no copy");
  assert.equal(notificationVerdictReply("x".repeat(600), "x".repeat(500) + "…"), undefined);
  const huge = REPLY + "\n\n" + "y".repeat(NOTIFICATION_REPLY_MAX_BYTES);
  assert.equal(notificationVerdictReply(huge, huge.slice(0, 500) + "…"), undefined);
  const truncated = notification(preview);
  assert.equal(renderVerdictNotification(truncated, false, hostTheme()), undefined);
  const withReply = Object.assign(notification(preview), { verdictReply: full });
  const own = lines(renderVerdictNotification(withReply, false, hostTheme())).join("\n");
  assert.match(own, /Review FINDINGS: 1 finding \(1 high\); 1 candidate \(1 low\)/);
  const otherRun = Object.assign(notification(preview), {
    verdictReply: "A later run.\n\n" + BLOCK + "\n\n" + PARSED_LINE,
  });
  assert.equal(renderVerdictNotification(otherRun, false, hostTheme()), undefined);
  const notText = Object.assign(notification(preview), { verdictReply: 42 });
  assert.equal(renderVerdictNotification(notText, false, hostTheme()), undefined);
  const expanded = lines(renderVerdictNotification(withReply, true, hostTheme())).join("\n");
  assert.doesNotMatch(expanded, /Review FINDINGS:/);
  assert.doesNotMatch(expanded, /bundle sha256/);
});
