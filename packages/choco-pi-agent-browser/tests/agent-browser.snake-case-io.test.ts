import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";

import { compileAgentBrowserElectron } from "../extensions/agent-browser/lib/input-modes/electron.ts";
import { formatElectronProbeFocusedElement } from "../extensions/agent-browser/lib/orchestration/electron-host/index.ts";
import {
  compileAgentBrowserJob,
  compileAgentBrowserQaPreset,
} from "../extensions/agent-browser/lib/input-modes/job.ts";
import {
  compileAgentBrowserNetworkSourceLookup,
  compileAgentBrowserSourceLookup,
} from "../extensions/agent-browser/lib/input-modes/lookups.ts";
import { AGENT_BROWSER_PARAMS } from "../extensions/agent-browser/lib/input-modes/params.ts";
import { compileAgentBrowserSemanticAction } from "../extensions/agent-browser/lib/input-modes/semantic-action.ts";
import { resolveAgentBrowserInput } from "../extensions/agent-browser/lib/orchestration/input-plan.ts";
import {
  addDiagnosticToJsonContent,
  buildJsonVisibleContent,
} from "../extensions/agent-browser/lib/orchestration/browser-run/final-result.ts";
import { buildAgentBrowserToolResultPatch } from "../extensions/agent-browser/lib/pi-tool-rendering.ts";
import { buildAgentBrowserNextActions } from "../extensions/agent-browser/lib/results/action-recommendations.ts";
import { buildNextToolAction } from "../extensions/agent-browser/lib/results/next-actions.ts";
import {
  toModelVisibleData,
  toSnakeCaseKeys,
} from "../extensions/agent-browser/lib/results/tool-output-keys.ts";
import { AgentBrowserWebSearchParams } from "../extensions/agent-browser/lib/web-search-registration.ts";

const isParams = compile(AGENT_BROWSER_PARAMS).check;
const isSearchParams = compile(AgentBrowserWebSearchParams).check;

test("snake_case inputs validate at every renamed level", () => {
  const accepted = [
    { semantic_action: { action: "click", locator: "text", value: "Go" } },
    {
      qa: {
        url: "https://example.com",
        expected_text: ["A"],
        expected_selector: "#a",
        screenshot_path: "a.png",
        check_console: true,
        check_errors: true,
        check_network: false,
        load_state: "load",
      },
    },
    { qa: { attached: true, expected_text: "A", load_state: "networkidle" } },
    {
      source_lookup: {
        react_fiber_id: "1",
        component_name: "App",
        include_dom_hints: false,
        max_workspace_files: 10,
      },
    },
    { network_source_lookup: { request_id: "r1", max_workspace_files: 10 } },
    { electron: { action: "list", max_results: 3 } },
    {
      electron: {
        action: "launch",
        app_name: "Code",
        app_args: ["--x"],
        target_type: "any",
        timeout_ms: 10,
      },
    },
    { electron: { action: "launch", app_path: "/A.app" } },
    { electron: { action: "launch", bundle_id: "com.a" } },
    { electron: { action: "launch", executable_path: "/a" } },
    { electron: { action: "status", launch_id: "l1", timeout_ms: 5 } },
    { electron: { action: "probe", launch_id: "l1" } },
    {
      job: {
        fail_fast: false,
        steps: [
          { action: "open", url: "https://example.com", load_state: "load" },
          { action: "type", text: "hi", delay_ms: 5 },
          { action: "assert_text", text: "A" },
          { action: "assert_url", url: "**/a" },
          { action: "wait_for_download", path: "a.zip" },
        ],
      },
    },
    { args: ["snapshot"], output_path: "out.json", timeout_ms: 1000, session_mode: "fresh" },
  ];
  for (const params of accepted) assert.equal(isParams(params), true, JSON.stringify(params));
  assert.equal(isSearchParams({ query: "x", search_type: "deep", search_lang: "en" }), true);
});

test("old camelCase input names and values are rejected", () => {
  const rejected = [
    { semanticAction: { action: "click", locator: "text", value: "Go" } },
    { qa: { url: "https://example.com", expectedText: "A" } },
    { qa: { url: "https://example.com", expectedSelector: "#a" } },
    { qa: { url: "https://example.com", screenshotPath: "a.png" } },
    { qa: { url: "https://example.com", checkConsole: true } },
    { qa: { url: "https://example.com", checkErrors: true } },
    { qa: { url: "https://example.com", checkNetwork: true } },
    { qa: { attached: true, loadState: "load" } },
    { sourceLookup: { selector: "#a" } },
    { source_lookup: { reactFiberId: "1" } },
    { source_lookup: { componentName: "App" } },
    { source_lookup: { selector: "#a", includeDomHints: true } },
    { source_lookup: { selector: "#a", maxWorkspaceFiles: 1 } },
    { networkSourceLookup: { filter: "api" } },
    { network_source_lookup: { requestId: "r1" } },
    { network_source_lookup: { filter: "api", maxWorkspaceFiles: 1 } },
    { electron: { action: "list", maxResults: 3 } },
    { electron: { action: "launch", appName: "Code" } },
    { electron: { action: "launch", appPath: "/A.app" } },
    { electron: { action: "launch", bundleId: "com.a" } },
    { electron: { action: "launch", executablePath: "/a" } },
    { electron: { action: "launch", app_name: "Code", appArgs: ["--x"] } },
    { electron: { action: "launch", app_name: "Code", targetType: "any" } },
    { electron: { action: "launch", app_name: "Code", timeoutMs: 1 } },
    { electron: { action: "status", launchId: "l1" } },
    { electron: { action: "probe", launchId: "l1" } },
    { job: { failFast: false, steps: [{ action: "snapshot" }] } },
    { job: { steps: [{ action: "open", url: "https://a.test", loadState: "load" }] } },
    { job: { steps: [{ action: "type", text: "a", delayMs: 1 }] } },
    { job: { steps: [{ action: "assertText", text: "A" }] } },
    { job: { steps: [{ action: "assertUrl", url: "a" }] } },
    { job: { steps: [{ action: "waitForDownload", path: "a" }] } },
    { args: ["snapshot"], outputPath: "out.json" },
    { args: ["snapshot"], timeoutMs: 1000 },
    { args: ["snapshot"], sessionMode: "fresh" },
  ];
  for (const params of rejected) assert.equal(isParams(params), false, JSON.stringify(params));
  assert.equal(isSearchParams({ query: "x", searchType: "deep" }), false);
  assert.equal(isSearchParams({ query: "x", searchLang: "en" }), false);
});

test("compilers read snake_case fields and name them in errors", () => {
  assert.deepEqual(compileAgentBrowserSemanticAction({ action: "click" }), {
    error:
      "semantic_action.locator must be one of: alt, label, placeholder, role, testid, text, title.",
  });
  const job = compileAgentBrowserJob({
    fail_fast: false,
    steps: [
      { action: "open", url: "https://a.test", load_state: "load" },
      { action: "type", text: "ab", delay_ms: 5 },
      { action: "assert_text", text: "A" },
      { action: "assert_url", url: "**/a" },
      { action: "wait_for_download", path: "a.zip" },
    ],
  });
  assert.deepEqual(job.compiled?.args, ["batch"]);
  assert.deepEqual(
    job.compiled?.steps.map((step) => step.args),
    [
      ["open", "https://a.test"],
      ["wait", "--load", "load"],
      ["keyboard", "type", "a"],
      ["wait", "5"],
      ["keyboard", "type", "b"],
      ["wait", "--text", "A"],
      ["wait", "--url", "**/a"],
      ["wait", "--download", "a.zip"],
    ],
  );
  assert.equal(
    compileAgentBrowserJob({
      steps: [{ action: "open", url: "https://a.test", loadState: "load" }],
    }).error,
    "job.steps[0]: job step open does not support loadState; supported fields are load_state, url.",
  );
  assert.equal(
    compileAgentBrowserJob({ steps: [{ action: "assertText", text: "A" }] }).error,
    "job.steps[0].action must be one of: open, click, fill, type, press, select, wait, assert_text, assert_url, wait_for_download, screenshot, snapshot.",
  );
  const qa = compileAgentBrowserQaPreset({
    url: "https://a.test",
    expected_text: "A",
    check_console: false,
    check_errors: false,
    check_network: false,
    load_state: "load",
  });
  assert.equal(qa.compiled?.checks.loadState, "load");
  assert.deepEqual(qa.compiled?.checks.expectedText, ["A"]);
  assert.equal(
    compileAgentBrowserQaPreset({ url: "https://a.test", expected_selector: "" }).error,
    "qa.expected_selector must be a non-empty string when provided.",
  );
  assert.equal(
    compileAgentBrowserSourceLookup({ component_name: "App", max_workspace_files: 3 }).compiled
      ?.query.maxWorkspaceFiles,
    3,
  );
  assert.equal(
    compileAgentBrowserSourceLookup({ componentName: "App" }).error,
    "source_lookup requires selector, react_fiber_id, or component_name.",
  );
  assert.equal(
    compileAgentBrowserNetworkSourceLookup({ request_id: "r1" }).compiled?.query.requestId,
    "r1",
  );
  assert.equal(
    compileAgentBrowserNetworkSourceLookup({ requestId: "r1" }).error,
    "network_source_lookup requires request_id, filter, or url.",
  );
  const launch = compileAgentBrowserElectron({
    action: "launch",
    app_name: "Code",
    target_type: "any",
    timeout_ms: 9,
  });
  assert.equal(launch.compiled?.action, "launch");
  assert.equal(
    compileAgentBrowserElectron({ action: "launch", appName: "Code" }).error,
    "electron.launch does not support electron.appName.",
  );
  assert.equal(
    compileAgentBrowserElectron({ action: "list", maxResults: 2 }).error,
    "electron.list only supports query and max_results; remove electron.maxResults.",
  );
});

test("top-level snake_case fields drive validation messages", () => {
  const resolve = (params: Parameters<typeof resolveAgentBrowserInput>[0]["params"]) =>
    resolveAgentBrowserInput({
      getBatchPreflightValidationError: () => undefined,
      managedSessionActive: false,
      params,
    });
  assert.equal(
    resolve({ args: ["snapshot"], timeout_ms: 0 }).validationError,
    "timeout_ms must be a positive integer when provided.",
  );
  assert.equal(
    resolve({ args: ["snapshot"], output_path: " " }).validationError,
    "output_path must be a non-empty string when provided.",
  );
  assert.equal(
    resolve({ electron: { action: "probe" }, timeout_ms: 5 }).validationError,
    "Use electron.timeout_ms for electron actions; top-level timeout_ms applies only to browser CLI subprocess calls.",
  );
  assert.equal(
    resolve({ semantic_action: { action: "click", locator: "text", value: "Go" } }).kind,
    "semanticAction",
  );
  assert.equal(
    resolve({}).validationError,
    "Provide exactly one of script, args, semantic_action, job, qa, source_lookup, network_source_lookup, or electron.",
  );
});

test("replayable next-action payloads use snake_case tool params", () => {
  assert.deepEqual(
    buildNextToolAction({
      args: ["open", "about:blank"],
      id: "x",
      reason: "r",
      sessionMode: "fresh",
    }).params,
    { args: ["open", "about:blank"], session_mode: "fresh" },
  );
  const electronActions =
    buildAgentBrowserNextActions({
      electron: { launchId: "l1", sessionName: "s1", status: "active" },
      resultCategory: "success",
      successCategory: "completed",
    }) ?? [];
  const electronParams = electronActions.flatMap((action) =>
    action.params?.electron ? [action.params.electron] : [],
  );
  assert.ok(electronParams.length > 0);
  for (const params of electronParams) {
    assert.equal(params.launch_id, "l1");
    assert.equal(isParams({ electron: params }), true, JSON.stringify(params));
  }
});

test("model-visible failure notice and JSON output keys are snake_case", () => {
  const patch = buildAgentBrowserToolResultPatch({
    content: [{ text: "boom", type: "text" }],
    details: { failureCategory: "timeout", resultCategory: "failure" },
    input: { args: ["click", "@e1"] },
    isError: false,
    toolCallId: "call-1",
    toolName: "agent_browser",
    type: "tool_result",
  });
  const notice = patch?.content?.[0]?.type === "text" ? patch.content[0].text : "";
  assert.match(
    notice,
    /Result category: failure; failure_category: timeout; Pi tool is_error: true\./,
  );

  const [jsonContent] = buildJsonVisibleContent({
    error: undefined,
    presentation: {
      artifacts: [{ absolutePath: "/tmp/a.png", kind: "image", path: "a.png", sizeBytes: 3 }],
      content: [],
      data: {
        compacted: true,
        fullOutputPath: "/tmp/full.txt",
        previewSections: [{ linesShown: 1, omittedLines: 2, role: "main", title: "x" }],
        roleCounts: { button: 2 },
      },
      summary: "ok",
    },
    succeeded: true,
  });
  const payload: unknown = JSON.parse(jsonContent?.type === "text" ? jsonContent.text : "{}");
  assert.deepEqual(payload, {
    artifacts: [{ absolute_path: "/tmp/a.png", kind: "image", path: "a.png", size_bytes: 3 }],
    data: {
      compacted: true,
      full_output_path: "/tmp/full.txt",
      preview_sections: [{ lines_shown: 1, omitted_lines: 2, role: "main", title: "x" }],
      role_counts: { button: 2 },
    },
    success: true,
  });

  const [upstreamContent] = buildJsonVisibleContent({
    error: undefined,
    presentation: { content: [], data: { snapshotText: "x", noMovement: true }, summary: "ok" },
    succeeded: true,
  });
  assert.deepEqual(JSON.parse(upstreamContent?.type === "text" ? upstreamContent.text : "{}"), {
    data: { snapshotText: "x", no_movement: true },
    success: true,
  });

  const [withDiagnostic] = addDiagnosticToJsonContent(
    [{ text: JSON.stringify({ success: false }), type: "text" }],
    {
      code: "rate_limited",
      hint: "wait",
      origin: "cli",
      outcome: "not-executed",
      retryAfterMs: 5,
      retryable: true,
    },
    [],
  );
  const diagnosticText = withDiagnostic?.type === "text" ? withDiagnostic.text : "";
  assert.match(diagnosticText, /"retry_after_ms": 5/);
  assert.doesNotMatch(diagnosticText, /retryAfterMs/);
});

test("tool-output key helper converts plain-object keys only", () => {
  const date = new Date(0);
  assert.deepEqual(toSnakeCaseKeys({ fooBar: [{ bazQux: "keepThisValue" }], when: date }), {
    foo_bar: [{ baz_qux: "keepThisValue" }],
    when: date,
  });
  assert.deepEqual(toModelVisibleData({ upstreamKey: 1, wsUrl: "ws://x" }), {
    upstreamKey: 1,
    ws_url: "ws://x",
  });
});

test("electron probe focused-element labels are snake_case", () => {
  const line = formatElectronProbeFocusedElement({
    role: "textbox",
    tagName: "input",
    valueLength: 4,
    textLength: 12,
  });
  assert.equal(line, "Focused: textbox/input (value_length=4, text_length=12)");
});
