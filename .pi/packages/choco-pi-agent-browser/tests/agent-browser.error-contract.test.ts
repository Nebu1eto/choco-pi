import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentBrowserResultCategoryDetails,
  classifyAgentBrowserDiagnostic,
} from "../extensions/agent-browser/lib/results/categories.ts";
import { extractUpstreamErrorCode } from "../extensions/agent-browser/lib/results/envelope.ts";
import type {
  AgentBrowserDiagnostic,
  AgentBrowserFailureCategory,
} from "../extensions/agent-browser/lib/results/contracts.ts";
import {
  buildErrorPresentation,
  formatAgentBrowserDiagnosticText,
  parseAgentBrowserDiagnostic,
} from "../extensions/agent-browser/lib/results/presentation/errors.ts";
import { addDiagnosticToJsonContent } from "../extensions/agent-browser/lib/orchestration/browser-run/final-result.ts";
import { buildValidationFailureResult } from "../extensions/agent-browser/lib/orchestration/input-plan.ts";
import {
  buildScriptBrowserEnvelope,
  buildScriptToolResult,
} from "../extensions/agent-browser/lib/orchestration/script-mode.ts";
import { isRecord } from "../extensions/agent-browser/lib/parsing.ts";
import { buildAgentBrowserToolResultPatch } from "../extensions/agent-browser/lib/pi-tool-rendering.ts";
import { RUNTIME_PROMPT_GUIDELINES } from "../extensions/agent-browser/lib/playbook.ts";

function detailsDiagnostic<Details>(details: Details): AgentBrowserDiagnostic | undefined {
  return isRecord(details) ? parseAgentBrowserDiagnostic(details.diagnostic) : undefined;
}

function diagnose(
  failureCategory: AgentBrowserFailureCategory,
  extra: Partial<Parameters<typeof classifyAgentBrowserDiagnostic>[0]> = {},
): AgentBrowserDiagnostic {
  return classifyAgentBrowserDiagnostic({ failureCategory, ...extra });
}

test("every diagnostic code carries its documented origin, outcome, and retryability", () => {
  const cases: Array<[string, AgentBrowserDiagnostic, string, string, string, boolean]> = [
    [
      "wrapper_timeout",
      diagnose("timeout", { command: "click", timedOut: true }),
      "wrapper_timeout",
      "wrapper",
      "unknown",
      true,
    ],
    [
      "condition_timeout",
      diagnose("timeout", { command: "wait", errorText: "wait timed out" }),
      "condition_timeout",
      "cli",
      "completed",
      true,
    ],
    [
      "navigation_timeout",
      diagnose("timeout", { command: "open", errorText: "Navigation timed out" }),
      "navigation_timeout",
      "cli",
      "unknown",
      true,
    ],
    [
      "ipc_timeout",
      diagnose("timeout", {
        command: "click",
        errorText:
          "agent-browser hit the upstream CLI 30s IPC read timeout while waiting for the daemon response.",
      }),
      "ipc_timeout",
      "daemon",
      "unknown",
      true,
    ],
    [
      "daemon_unavailable",
      diagnose("upstream-error", {
        command: "snapshot",
        errorText: "Failed to connect to daemon: ECONNREFUSED",
      }),
      "daemon_unavailable",
      "daemon",
      "unknown",
      true,
    ],
    [
      "session_dead (tab gone)",
      diagnose("tab-gone", { command: "click", errorText: "tab_gone: bound tab closed" }),
      "session_dead",
      "session",
      "unknown",
      false,
    ],
    [
      "session_dead (text)",
      diagnose("upstream-error", { command: "click", errorText: "browser has been closed" }),
      "session_dead",
      "session",
      "unknown",
      false,
    ],
    [
      "target_missing",
      diagnose("selector-not-found", { command: "click" }),
      "target_missing",
      "cli",
      "not-executed",
      false,
    ],
    [
      "target_missing (stale ref)",
      diagnose("stale-ref", { command: "click" }),
      "target_missing",
      "cli",
      "not-executed",
      false,
    ],
    [
      "invalid_arguments",
      diagnose("validation-error", { validationError: "bad" }),
      "invalid_arguments",
      "validation",
      "not-executed",
      false,
    ],
    [
      "invalid_arguments (selector)",
      diagnose("selector-unsupported", { command: "click" }),
      "invalid_arguments",
      "cli",
      "not-executed",
      false,
    ],
    [
      "upstream_unknown",
      diagnose("upstream-error", { command: "click", errorText: "something odd" }),
      "upstream_unknown",
      "unknown",
      "unknown",
      false,
    ],
    [
      "cli_unavailable",
      diagnose("missing-binary", { spawnError: "spawn agent-browser ENOENT" }),
      "cli_unavailable",
      "cli",
      "not-executed",
      false,
    ],
  ];
  for (const [label, diagnostic, code, origin, outcome, retryable] of cases) {
    assert.equal(diagnostic.code, code, label);
    assert.equal(diagnostic.origin, origin, label);
    assert.equal(diagnostic.outcome, outcome, label);
    assert.equal(diagnostic.retryable, retryable, label);
    assert.ok(diagnostic.hint.length > 0, label);
  }
});

test("a nonzero exit or unclassified failure stays unknown and never gets a precise code", () => {
  const diagnostic = diagnose("upstream-error", {
    command: "click",
    errorText: "agent-browser click exited with code 1.",
  });
  assert.equal(diagnostic.code, "upstream_unknown");
  assert.equal(diagnostic.origin, "unknown");
  assert.equal(diagnostic.outcome, "unknown");
  assert.equal(diagnostic.retryable, false);
});

test("timeout hints warn that a mutation may already have executed, but not for read-only commands", () => {
  const mutation = diagnose("timeout", { command: "click", timedOut: true });
  assert.match(mutation.hint, /may already have taken effect/);
  assert.match(mutation.hint, /retryable does not authorize replaying a mutation/);
  const read = diagnose("timeout", { command: "snapshot", timedOut: true });
  assert.doesNotMatch(read.hint, /may already have taken effect/);
  assert.match(
    diagnose("upstream-error", { command: "eval" }).hint,
    /may already have taken effect/,
  );
});

test("validated upstream error codes are preserved; invalid ones are dropped", () => {
  const preserved = diagnose("upstream-error", {
    command: "click",
    errorText: "boom",
    upstreamErrorCode: "EBROWSER_CRASH",
  });
  assert.equal(preserved.code, "EBROWSER_CRASH");
  assert.equal(preserved.origin, "cli");
  assert.equal(preserved.outcome, "unknown");

  const dropped = diagnose("upstream-error", {
    command: "click",
    upstreamErrorCode: "has spaces and secret=hunter2",
  });
  assert.equal(dropped.code, "upstream_unknown");

  const keepsOrigin = diagnose("selector-not-found", {
    command: "click",
    upstreamErrorCode: "element_not_found",
  });
  assert.equal(keepsOrigin.code, "element_not_found");
  assert.equal(keepsOrigin.outcome, "not-executed");

  const watchdog = diagnose("timeout", {
    command: "click",
    timedOut: true,
    upstreamErrorCode: "E_SOMETHING",
  });
  assert.equal(watchdog.code, "wrapper_timeout");
});

test("extractUpstreamErrorCode reads nested error.code and batch step errors only from failures", () => {
  assert.equal(
    extractUpstreamErrorCode({ error: { code: "E_TOP", message: "x" }, success: false }),
    "E_TOP",
  );
  assert.equal(
    extractUpstreamErrorCode({
      error: { error: { cause: { code: "E_NESTED" } }, message: "x" },
      success: false,
    }),
    "E_NESTED",
  );
  assert.equal(
    extractUpstreamErrorCode({
      data: [{ error: { code: "E_STEP" }, success: false }],
      success: false,
    }),
    "E_STEP",
  );
  assert.equal(extractUpstreamErrorCode({ error: { code: "E_X" }, success: true }), undefined);
  assert.equal(extractUpstreamErrorCode({ error: "plain text", success: false }), undefined);
  assert.equal(
    extractUpstreamErrorCode({ error: { code: "not a code!" }, success: false }),
    undefined,
  );
  assert.equal(extractUpstreamErrorCode(undefined), undefined);
});

test("retryAfterMs is kept only when finite and bounded", () => {
  assert.equal(diagnose("timeout", { retryAfterMs: 1500.9, timedOut: true }).retryAfterMs, 1500);
  assert.equal(
    diagnose("timeout", { retryAfterMs: Number.POSITIVE_INFINITY, timedOut: true }).retryAfterMs,
    undefined,
  );
  assert.equal(diagnose("timeout", { retryAfterMs: -1, timedOut: true }).retryAfterMs, undefined);
  assert.equal(
    diagnose("timeout", { retryAfterMs: 10 ** 9, timedOut: true }).retryAfterMs,
    undefined,
  );
});

test("category details attach a diagnostic to failures only", () => {
  const failed = buildAgentBrowserResultCategoryDetails({
    command: "click",
    errorText: "Unknown ref @e9",
    succeeded: false,
  });
  assert.equal(failed.failureCategory, "stale-ref");
  assert.equal(failed.diagnostic?.code, "target_missing");
  const ok = buildAgentBrowserResultCategoryDetails({ succeeded: true });
  assert.equal(ok.diagnostic, undefined);
});

test("parseAgentBrowserDiagnostic validates shape and round-trips", () => {
  const diagnostic = diagnose("timeout", { command: "wait", errorText: "timed out" });
  assert.deepEqual(parseAgentBrowserDiagnostic(JSON.parse(JSON.stringify(diagnostic))), diagnostic);
  assert.equal(parseAgentBrowserDiagnostic({ ...diagnostic, origin: "elsewhere" }), undefined);
  assert.equal(parseAgentBrowserDiagnostic({ ...diagnostic, retryable: "yes" }), undefined);
  assert.equal(parseAgentBrowserDiagnostic("nope"), undefined);
  assert.match(formatAgentBrowserDiagnosticText(diagnostic), /^Diagnostic: code=condition_timeout/);
});

test("validation failures expose the diagnostic in details and model-visible text without echoing input", () => {
  const result = buildValidationFailureResult({
    kind: "invalid",
    redactedArgs: ["fill", "@e1", "[REDACTED]"],
    status: "invalid",
    toolArgs: ["fill", "@e1", "hunter2-secret"],
    toolStdin: "stdin-secret",
    validationError: "Unsupported combination of input modes.",
  });
  assert.equal(result.isError, true);
  const diagnostic = detailsDiagnostic(result.details);
  assert.equal(diagnostic?.code, "invalid_arguments");
  assert.equal(diagnostic?.origin, "validation");
  assert.equal(diagnostic?.outcome, "not-executed");
  const visible = result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
  assert.match(
    visible,
    /Diagnostic: code=invalid_arguments origin=validation outcome=not-executed/,
  );
  assert.doesNotMatch(visible + JSON.stringify(result.details), /hunter2-secret|stdin-secret/);
});

test("error presentation carries the diagnostic for upstream errors", () => {
  const presentation = buildErrorPresentation({
    commandInfo: { command: "click" },
    errorText: "Unknown ref @e9",
  });
  assert.equal(presentation.failureCategory, "stale-ref");
  assert.equal(presentation.diagnostic?.code, "target_missing");
});

test("JSON-mode failures stay parseable and gain a diagnostic; successes and non-JSON are untouched", () => {
  const diagnostic = diagnose("timeout", { command: "click", timedOut: true });
  const failure = [
    { type: "text" as const, text: JSON.stringify({ error: "x", success: false }, null, 2) },
  ];
  const patched = addDiagnosticToJsonContent(failure, diagnostic, []);
  const first = patched[0];
  assert.equal(first?.type, "text");
  const parsed: { diagnostic?: AgentBrowserDiagnostic; error?: string; success?: boolean } =
    JSON.parse(first?.type === "text" ? first.text : "");
  assert.equal(parsed.success, false);
  assert.equal(parsed.error, "x");
  assert.equal(parsed.diagnostic?.code, "wrapper_timeout");

  const success = [{ type: "text" as const, text: JSON.stringify({ success: true }) }];
  assert.deepEqual(addDiagnosticToJsonContent(success, diagnostic, []), success);
  const prose = [{ type: "text" as const, text: "not json" }];
  assert.deepEqual(addDiagnosticToJsonContent(prose, diagnostic, []), prose);
  assert.deepEqual(addDiagnosticToJsonContent(failure, undefined, []), failure);
});

test("script inner envelope and top-level script result carry the diagnostic", async () => {
  const inner = buildValidationFailureResult({
    kind: "invalid",
    redactedArgs: ["get", "title"],
    status: "invalid",
    toolArgs: ["get", "title"],
    validationError: "bad input",
  });
  const envelope = await buildScriptBrowserEnvelope(inner, ["get", "title"]);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.diagnostic?.code, "invalid_arguments");
  assert.deepEqual(detailsDiagnostic(envelope.details), envelope.diagnostic);

  const timedOut = buildScriptToolResult({
    innerResults: [],
    run: {
      callCount: 1,
      emitCount: 0,
      error: "Script timed out.",
      failureCategory: "timeout",
      ok: false,
      rejectedCallCount: 0,
      steps: [],
      timedOut: true,
    },
  });
  assert.equal(timedOut.isError, true);
  const timedOutDiagnostic = detailsDiagnostic(timedOut.details);
  assert.equal(timedOutDiagnostic?.code, "wrapper_timeout");
  assert.match(timedOutDiagnostic?.hint ?? "", /may already have taken effect/);
  const text = timedOut.content[0]?.type === "text" ? timedOut.content[0].text : "";
  assert.match(text, /Diagnostic: code=wrapper_timeout/);

  const ok = buildScriptToolResult({
    innerResults: [],
    run: { callCount: 0, emitCount: 1, data: 1, ok: true, rejectedCallCount: 0, steps: [] },
  });
  assert.equal(detailsDiagnostic(ok.details), undefined);
});

test("tool_result patch surfaces the diagnostic code and still marks isError", () => {
  const diagnostic = diagnose("timeout", { command: "click", timedOut: true });
  const patch = buildAgentBrowserToolResultPatch({
    content: [{ text: "boom", type: "text" }],
    details: { diagnostic, failureCategory: "timeout", resultCategory: "failure" },
    input: { args: ["click", "@e1"] },
    isError: false,
    toolCallId: "call-1",
    toolName: "agent_browser",
    type: "tool_result",
  });
  assert.equal(patch?.isError, true);
  const text = patch?.content?.[0]?.type === "text" ? patch.content[0].text : "";
  assert.match(text, /diagnostic\.code: wrapper_timeout; diagnostic\.outcome: unknown/);
});

test("Tier-A prompt guideline tells the model to act on diagnostics and not repeat failures", () => {
  const rule = RUNTIME_PROMPT_GUIDELINES.find((item) => item.includes("diagnostic.code"));
  assert.ok(rule);
  assert.match(rule, /Do not repeat an unchanged failing action/);
  assert.match(rule, /A timed-out action may already have executed/);
});
