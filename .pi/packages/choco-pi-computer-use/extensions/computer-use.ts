import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Properties } from "@earendil-works/pi-schema";
import { arr, int, lit, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import {
  ensureComputerUseSetup,
  executeAct,
  executeEvaluateBrowser,
  executeExpandUi,
  executeInspectUi,
  executeLaunchBrowser,
  executeFind,
  executeNavigateBrowser,
  executeObserve,
  executeReadText,
  executeSearchUi,
  executeWaitFor,
  reconstructStateFromBranch,
  shutdownComputerUseSession,
} from "../src/bridge.ts";
import {
  clearSessionGrants,
  foregroundPromptMode,
  getLoadedComputerUseConfig,
  getSessionDenials,
  getSessionForegroundPromptMode,
  getSessionGrants,
  loadComputerUseConfig,
  sessionGrantGeneration,
  type ForegroundPromptMode,
} from "../src/config.ts";
import {
  describePersist,
  notifyUnlessStale,
  setForegroundPromptMode,
} from "../src/grant-prompt.ts";
import { hostParams } from "../src/schema-bridge.ts";
import {
  toActParams,
  toEvaluateBrowserParams,
  toExpandUiParams,
  toFindParams,
  toInspectUiParams,
  toNavigateBrowserParams,
  toReadTextParams,
  toSearchUiParams,
  toWaitForParams,
} from "../src/tool-params.ts";

/** Closed objects: a former camelCase parameter name fails validation instead of being ignored. */
const object = <const P extends Properties>(properties: P) => obj(properties);
const toolParams = <const P extends Properties>(properties: P) => hostParams(object(properties));

const stateId = str({
  description: "Required state id owning every @e ref used by this operation",
});
const optionalInspectionStateId = opt(
  str({
    description: "Cached state id; omit to establish a read-only semantic observation first",
  }),
);
const actionStateId = opt(
  str({
    description: "Fresh state id owning every @e ref; omission returns an observe_ui requirement",
  }),
);
const point = { x: num(), y: num() };
const mouseButton = opt(oneOf(["left", "right", "middle"]));
const click = object({
  action: lit("click"),
  ref: opt(str({ description: "Exactly one target is required: ref or both x and y" })),
  x: opt(num({ description: "Target x; requires y and no ref" })),
  y: opt(num({ description: "Target y; requires x and no ref" })),
  button: mouseButton,
  click_count: opt(int({ minimum: 1, maximum: 3 })),
});
const uiAction = union([
  object({
    action: lit("press"),
    ref: str({ description: "Actionable outline ref" }),
  }),
  click,
  object({
    action: lit("set_text"),
    ref: str({ description: "Editable outline ref" }),
    text: str(),
  }),
  object({
    action: lit("type_text"),
    ref: opt(
      str({
        description:
          "Input to focus first; omit to type into the target app's focused element (headless desktop mode requires ref)",
      }),
    ),
    text: str(),
  }),
  object({
    action: lit("keypress"),
    ref: opt(
      str({
        description:
          "Control to focus first; omit to send keys to the target app's focused element (headless desktop mode requires ref)",
      }),
    ),
    keys: arr(str(), {
      minItems: 1,
      description:
        'Modifiers then one key form one chord, e.g. ["cmd","shift","z"]; otherwise keys are pressed in order. Chord strings like "cmd+a" are desktop-only; browser pages reject them and take DOM key values (one character or a name such as "Enter" or "ArrowRight") with modifiers as separate keys. On macOS, Cmd editing shortcuts (select all, copy, cut, paste, undo, redo) do not run on browser pages; use set_text to replace a field\'s text',
    }),
  }),
  object({
    action: lit("scroll"),
    ref: opt(
      str({
        description:
          "Target ref or both x and y required; at least one non-zero scroll_x/scroll_y required",
      }),
    ),
    x: opt(num({ description: "Target x; requires y; omit when using ref" })),
    y: opt(num({ description: "Target y; requires x; omit when using ref" })),
    scroll_x: opt(
      num({
        description: "Horizontal delta; at least one non-zero scroll_x/scroll_y required",
      }),
    ),
    scroll_y: opt(
      num({
        description: "Vertical delta; at least one non-zero scroll_x/scroll_y required",
      }),
    ),
  }),
  object({
    action: lit("drag"),
    path: arr(object(point), { minItems: 2 }),
  }),
  object({ action: lit("move_mouse"), ...point }),
]);

const conditionProperties = {
  ref: opt(str({ description: "Specific @e ref to test", maxLength: 128 })),
  scope_ref: opt(str({ description: "Restrict matching to this @e subtree", maxLength: 128 })),
  text: opt(str({ description: "Text that must match", maxLength: 512 })),
  role: opt(str({ description: "Exact normalized role", maxLength: 128 })),
  value: opt(str({ description: "Exact normalized value; normally pair with ref" })),
  until: opt(
    oneOf(["present", "absent"], {
      description: "Desired condition, default present",
    }),
  ),
  timeout_ms: opt(
    num({ description: "Maximum wait, default 10000ms", minimum: 100, maximum: 60000 }),
  ),
};

const findTool = defineTool({
  name: "find_roots",
  label: "Find Roots",
  description:
    "Find a bounded, ranked set of controllable UI roots with refs, geometry, and focus state.",
  promptSnippet: "Find a target root before observe_ui when needed.",
  parameters: toolParams({
    text: opt(str({ description: "Ranked app or title text", maxLength: 256 })),
    app: opt(str({ description: "Exact normalized app name", maxLength: 256 })),
    bundle_id: opt(str({ description: "Exact bundle id" })),
    pid: opt(num({ description: "Exact process id" })),
    kind: opt(
      oneOf(["window", "menu", "sheet", "popover", "dialog", "browser_page"], {
        description: "Exact root kind",
      }),
    ),
  }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeFind(id, toFindParams(params), signal, onUpdate, ctx),
});

const observeTool = defineTool({
  name: "observe_ui",
  label: "Observe UI",
  description:
    "Capture the current/frontmost root or one exact @r root and return a bounded UI outline.",
  promptSnippet:
    "Primary UI observation tool. Follow with search_ui, expand_ui, inspect_ui, or act_ui.",
  promptGuidelines: [
    "Use mode=semantic to skip OCR and images, visual to force them, and fused for automatic selection.",
    "Use @e outline refs from observe_ui/search_ui for act_ui; picture_only refs are coordinate-only and blocked by UI-tree-only policy.",
  ],
  parameters: toolParams({
    root: opt(str({ description: "Exact @r ref issued by find_roots" })),
    mode: opt(
      oneOf(["semantic", "visual", "fused"], {
        description: "Observation mode, default fused",
      }),
    ),
  }),
  execute: executeObserve,
});

const searchUiTool = defineTool({
  name: "search_ui",
  label: "Search UI",
  description:
    "Search the current outline, establishing a read-only semantic observation when state_id is omitted. At least one predicate is required.",
  promptSnippet:
    "Find targets not shown in the compact observe_ui output; refine broad searches instead of paging matches.",
  parameters: toolParams({
    text: opt(str({ description: "Human-readable text or label", maxLength: 256 })),
    role: opt(str({ description: "Exact normalized role, e.g. button", maxLength: 128 })),
    capability: opt(
      str({
        description: "Exact capability, e.g. press, focus, set_value, text_input, or scroll",
        maxLength: 128,
      }),
    ),
    state_id: optionalInspectionStateId,
  }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeSearchUi(id, toSearchUiParams(params), signal, onUpdate, ctx),
});

const expandUiTool = defineTool({
  name: "expand_ui",
  label: "Expand UI",
  description:
    "Unfold bounded local outline context for one @e ref, establishing a read-only semantic observation when state_id is omitted.",
  promptSnippet: "Expand a specific ref instead of dumping unrelated UI.",
  parameters: toolParams({
    ref: str(),
    depth: opt(num({ minimum: 1, maximum: 8, description: "Subtree depth, default 3" })),
    state_id: optionalInspectionStateId,
  }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeExpandUi(id, toExpandUiParams(params), signal, onUpdate, ctx),
});

const inspectUiTool = defineTool({
  name: "inspect_ui",
  label: "Inspect UI",
  description:
    "Inspect one exact outline ref, establishing a read-only semantic observation when state_id is omitted.",
  promptSnippet: "Use when a target's evidence or provenance matters.",
  parameters: toolParams({ ref: str(), state_id: optionalInspectionStateId }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeInspectUi(id, toInspectUiParams(params), signal, onUpdate, ctx),
});

const actTool = defineTool({
  name: "act_ui",
  label: "Act",
  description:
    "Perform one or more precisely targeted checked actions and return the successor state.",
  promptSnippet:
    "Pass dependent click/type steps together and use expect for observable completion.",
  promptGuidelines: [
    'Action shapes: {action:"press",ref}; {action:"click",ref|x,y,button?,click_count?}; {action:"set_text",ref,text}; {action:"type_text",text,ref?}; {action:"keypress",keys:[key,…],ref?}; {action:"scroll",ref|x,y,scroll_x?,scroll_y?}; {action:"drag",path:[{x,y},…]}; {action:"move_mouse",x,y}. Click requires exactly one target; scroll requires a target and at least one non-zero delta.',
    "type_text/keypress without ref go to the target app's focused element, which must be in this state's window; pass ref to focus a specific input first. They take no x/y: click the point first. Headless desktop mode requires ref.",
    'Every action is validated before anything is sent; an invalid one rejects the whole call ("act_ui action N (<action>): … Nothing was sent.") and the state_id stays usable. Result status "partial": the action named in "act_ui stopped at action N" failed during delivery after the earlier ones ran (that message says why); continue from the returned state and do not resend delivered actions. foreground_required, cancelled, owned_by_other_session, target_closed, and post_action_observation_failed return no successor state: call observe_ui before acting again.',
  ],
  parameters: toolParams({
    state_id: actionStateId,
    expect: opt(object(conditionProperties)),
    actions: arr(uiAction, { minItems: 1, maxItems: 20 }),
  }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeAct(id, toActParams(params), signal, onUpdate, ctx),
});

const readTextTool = defineTool({
  name: "read_text",
  label: "Read Text",
  description: "Read a fixed-size page from an @e UI ref or immutable @o truncated-output ref.",
  promptSnippet: "Use @e with its state_id; @o continuation refs don't need state_id.",
  parameters: toolParams({
    ref: str(),
    offset: opt(num({ minimum: 0 })),
    state_id: opt(stateId),
  }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeReadText(id, toReadTextParams(params), signal, onUpdate, ctx),
});

const waitForTool = defineTool({
  name: "wait_for",
  label: "Wait For",
  description: "Wait for one scoped UI condition and return the successor state.",
  promptSnippet: "Use after asynchronous UI changes instead of polling observe_ui.",
  parameters: toolParams({ ...conditionProperties, state_id: stateId }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeWaitFor(id, toWaitForParams(params), signal, onUpdate, ctx),
});

const launchBrowserTool = defineTool({
  name: "launch_browser",
  label: "Launch Browser Context",
  description:
    "Launch the configured Pi-managed CDP browser and return an observed browser-page state.",
  promptSnippet: "Use for browser work that needs a managed CDP context.",
  promptGuidelines: ["Prefer curl through bash when the page is directly fetchable."],
  parameters: toolParams({ url: opt(str({ maxLength: 8192 })) }),
  execute: executeLaunchBrowser,
});

const navigateBrowserTool = defineTool({
  name: "navigate_browser",
  label: "Navigate Browser",
  description: "Navigate an observed CDP browser-page state to an HTTP(S) URL.",
  promptSnippet: "Native browser windows use act_ui; this tool is CDP-only.",
  parameters: toolParams({ url: str({ maxLength: 8192 }), state_id: stateId }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeNavigateBrowser(id, toNavigateBrowserParams(params), signal, onUpdate, ctx),
});

const evaluateBrowserTool = defineTool({
  name: "evaluate_browser",
  label: "Evaluate Browser",
  description:
    "Evaluate targeted JavaScript in a CDP browser-page state; returned output is strictly bounded.",
  promptSnippet:
    "Prefer observe/search/read; return selected fields, aggregates, or bounded slices.",
  parameters: toolParams({ state_id: stateId, expression: str({ maxLength: 65_536 }) }),
  execute: (id, params, signal, onUpdate, ctx) =>
    executeEvaluateBrowser(id, toEvaluateBrowserParams(params), signal, onUpdate, ctx),
});

function formatConfigStatus(): string {
  const loaded = getLoadedComputerUseConfig();
  const sessionMode = getSessionForegroundPromptMode();
  return [
    "pi-computer-use configuration",
    `browser_use: ${loaded.config.browser_use ? "enabled" : "disabled"}`,
    `managed_browser: ${loaded.config.managed_browser}`,
    `headless: ${loaded.config.headless ? "enabled" : "disabled"}`,
    `cursor_overlay: ${loaded.config.cursor_overlay ? "enabled" : "disabled"}`,
    `foreground_grant: ${loaded.config.foreground_grant.join(", ") || "none"}`,
    `foreground_prompt: ${foregroundPromptMode()}${sessionMode ? " (set for this session)" : ""}`,
    `restore_focus: ${loaded.config.restore_focus ? "enabled" : "disabled"}`,
    `session grants: ${getSessionGrants().join(", ") || "none"}`,
    `session denials: ${getSessionDenials().join(", ") || "none"}`,
    "Change the prompt mode with /computer-use grant ask|always|off.",
    "",
    "Sources:",
    ...loaded.sources.map(
      (source) =>
        `- ${source.path}: ${source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found"}`,
    ),
    `- env overrides: ${Object.keys(loaded.env).join(", ") || "none"}`,
  ].join("\n");
}

const PROMPT_MODE_EFFECTS = {
  ask: "pi asks once per app in the TUI before foreground input",
  always:
    "the agent may activate and send input to any app after a background refusal, without asking",
  off: "pi never asks; only foreground_grant entries and earlier session grants apply",
} satisfies Record<ForegroundPromptMode, string>;

function promptModeArgument(words: string[]): ForegroundPromptMode | undefined {
  if (words.length !== 2 || words[0] !== "grant") return undefined;
  const value = words[1];
  return value === "ask" || value === "always" || value === "off" ? value : undefined;
}

/**
 * `/computer-use` shows the status; `/computer-use grant ask|always|off` sets
 * the foreground prompt mode for this session and saves it to the user config.
 */
export async function runComputerUseCommand(
  args: string,
  cwd: string,
): Promise<{ message: string; level: "info" | "warning" | "error" }> {
  loadComputerUseConfig(cwd);
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return { message: formatConfigStatus(), level: "info" };
  const mode = promptModeArgument(words);
  if (!mode) return { message: "Usage: /computer-use [grant ask|always|off]", level: "error" };
  const persisted = await setForegroundPromptMode(mode);
  return {
    message: `foreground_prompt: ${mode} for this session (${PROMPT_MODE_EFFECTS[mode]}); ${describePersist(persisted)}.`,
    level: persisted.persisted && !persisted.shadowedBy ? "info" : "warning",
  };
}

export default function computerUseExtension(pi: ExtensionAPI): void {
  for (const tool of [
    findTool,
    observeTool,
    searchUiTool,
    expandUiTool,
    inspectUiTool,
    actTool,
    readTextTool,
    waitForTool,
    launchBrowserTool,
    navigateBrowserTool,
    evaluateBrowserTool,
  ])
    pi.registerTool(tool);

  pi.registerCommand("computer-use", {
    description: "Show pi-computer-use configuration; 'grant ask|always|off' sets the prompt mode",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const ui = ctx.ui;
      const generation = sessionGrantGeneration();
      const { message, level } = await runComputerUseCommand(args, cwd);
      // The session may have ended while saving; its UI must not be touched then.
      if (sessionGrantGeneration() !== generation) return;
      notifyUnlessStale(ui, message, level);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearSessionGrants();
    loadComputerUseConfig(ctx.cwd);
    reconstructStateFromBranch(ctx);
    if (!ctx.hasUI) return;
    try {
      await ensureComputerUseSetup(ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    await shutdownComputerUseSession();
  });
}
