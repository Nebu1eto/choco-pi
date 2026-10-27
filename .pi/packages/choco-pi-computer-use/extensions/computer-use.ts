import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

const stateId = Type.String({
  description: "Required state id owning every @e ref used by this operation",
});
const optionalInspectionStateId = Type.Optional(
  Type.String({
    description: "Cached state id; omit to establish a read-only semantic observation first",
  }),
);
const actionStateId = Type.Optional(
  Type.String({
    description: "Fresh state id owning every @e ref; omission returns an observe_ui requirement",
  }),
);
const point = { x: Type.Number(), y: Type.Number() };
const mouseButton = Type.Optional(
  Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")]),
);
const click = Type.Object({
  action: Type.Literal("click"),
  ref: Type.Optional(
    Type.String({ description: "Exactly one target is required: ref or both x and y" }),
  ),
  x: Type.Optional(Type.Number({ description: "Target x; requires y and no ref" })),
  y: Type.Optional(Type.Number({ description: "Target y; requires x and no ref" })),
  button: mouseButton,
  clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
});
const uiAction = Type.Union([
  Type.Object({
    action: Type.Literal("press"),
    ref: Type.String({ description: "Actionable outline ref" }),
  }),
  click,
  Type.Object({
    action: Type.Literal("setText"),
    ref: Type.String({ description: "Editable outline ref" }),
    text: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("typeText"),
    ref: Type.Optional(
      Type.String({
        description:
          "Input to focus first; omit to type into the target app's focused element (headless requires ref)",
      }),
    ),
    text: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("keypress"),
    ref: Type.Optional(
      Type.String({
        description:
          "Control to focus first; omit to send keys to the target app's focused element (headless requires ref)",
      }),
    ),
    keys: Type.Array(Type.String(), {
      minItems: 1,
      description:
        'Modifiers then one key form one chord, e.g. ["cmd","shift","z"]; otherwise keys are pressed in order and each may be a chord like "cmd+a"',
    }),
  }),
  Type.Object({
    action: Type.Literal("scroll"),
    ref: Type.Optional(
      Type.String({
        description:
          "Target ref or both x and y required; at least one non-zero scrollX/scrollY required",
      }),
    ),
    x: Type.Optional(Type.Number({ description: "Target x; requires y; omit when using ref" })),
    y: Type.Optional(Type.Number({ description: "Target y; requires x; omit when using ref" })),
    scrollX: Type.Optional(
      Type.Number({
        description: "Horizontal delta; at least one non-zero scrollX/scrollY required",
      }),
    ),
    scrollY: Type.Optional(
      Type.Number({
        description: "Vertical delta; at least one non-zero scrollX/scrollY required",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("drag"),
    path: Type.Array(Type.Object(point), { minItems: 2 }),
  }),
  Type.Object({ action: Type.Literal("moveMouse"), ...point }),
]);

const conditionProperties = {
  ref: Type.Optional(Type.String({ description: "Specific @e ref to test", maxLength: 128 })),
  scopeRef: Type.Optional(
    Type.String({ description: "Restrict matching to this @e subtree", maxLength: 128 }),
  ),
  text: Type.Optional(Type.String({ description: "Text that must match", maxLength: 512 })),
  role: Type.Optional(Type.String({ description: "Exact normalized role", maxLength: 128 })),
  value: Type.Optional(
    Type.String({ description: "Exact normalized value; normally pair with ref" }),
  ),
  until: Type.Optional(
    Type.Union([Type.Literal("present"), Type.Literal("absent")], {
      description: "Desired condition, default present",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Maximum wait, default 10000ms", minimum: 100, maximum: 60000 }),
  ),
};

const findTool = defineTool({
  name: "find_roots",
  label: "Find Roots",
  description:
    "Find a bounded, ranked set of controllable UI roots with refs, geometry, and focus state.",
  promptSnippet: "Find a target root before observe_ui when needed.",
  parameters: Type.Object({
    text: Type.Optional(Type.String({ description: "Ranked app or title text", maxLength: 256 })),
    app: Type.Optional(Type.String({ description: "Exact normalized app name", maxLength: 256 })),
    bundleId: Type.Optional(Type.String({ description: "Exact bundle id" })),
    pid: Type.Optional(Type.Number({ description: "Exact process id" })),
    kind: Type.Optional(
      Type.Union(
        [
          Type.Literal("window"),
          Type.Literal("menu"),
          Type.Literal("sheet"),
          Type.Literal("popover"),
          Type.Literal("dialog"),
          Type.Literal("browser_page"),
        ],
        { description: "Exact root kind" },
      ),
    ),
  }),
  execute: executeFind,
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
    "Use @e outline refs from observe_ui/search_ui for act_ui; pictureOnly refs are coordinate-only and blocked by UI-tree-only policy.",
  ],
  parameters: Type.Object({
    root: Type.Optional(Type.String({ description: "Exact @r ref issued by find_roots" })),
    mode: Type.Optional(
      Type.Union([Type.Literal("semantic"), Type.Literal("visual"), Type.Literal("fused")], {
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
    "Search the current outline, establishing a read-only semantic observation when stateId is omitted. At least one predicate is required.",
  promptSnippet:
    "Find targets not shown in the compact observe_ui output; refine broad searches instead of paging matches.",
  parameters: Type.Object({
    text: Type.Optional(
      Type.String({ description: "Human-readable text or label", maxLength: 256 }),
    ),
    role: Type.Optional(
      Type.String({ description: "Exact normalized role, e.g. button", maxLength: 128 }),
    ),
    capability: Type.Optional(
      Type.String({ description: "Exact capability, e.g. press", maxLength: 128 }),
    ),
    stateId: optionalInspectionStateId,
  }),
  execute: executeSearchUi,
});

const expandUiTool = defineTool({
  name: "expand_ui",
  label: "Expand UI",
  description:
    "Unfold bounded local outline context for one @e ref, establishing a read-only semantic observation when stateId is omitted.",
  promptSnippet: "Expand a specific ref instead of dumping unrelated UI.",
  parameters: Type.Object({
    ref: Type.String(),
    depth: Type.Optional(
      Type.Number({ minimum: 1, maximum: 8, description: "Subtree depth, default 3" }),
    ),
    stateId: optionalInspectionStateId,
  }),
  execute: executeExpandUi,
});

const inspectUiTool = defineTool({
  name: "inspect_ui",
  label: "Inspect UI",
  description:
    "Inspect one exact outline ref, establishing a read-only semantic observation when stateId is omitted.",
  promptSnippet: "Use when a target's evidence or provenance matters.",
  parameters: Type.Object({ ref: Type.String(), stateId: optionalInspectionStateId }),
  execute: executeInspectUi,
});

const actTool = defineTool({
  name: "act_ui",
  label: "Act",
  description:
    "Perform one or more precisely targeted checked actions and return the successor state.",
  promptSnippet:
    "Pass dependent click/type steps together and use expect for observable completion.",
  promptGuidelines: [
    'Action shapes: {action:"press",ref}; {action:"click",ref|x,y,button?,clickCount?}; {action:"setText",ref,text}; {action:"typeText",text,ref?}; {action:"keypress",keys:[key,…],ref?}; {action:"scroll",ref|x,y,scrollX?,scrollY?}; {action:"drag",path:[{x,y},…]}; {action:"moveMouse",x,y}. Click requires exactly one target; scroll requires a target and at least one non-zero delta.',
    "typeText/keypress without ref go to the target app's focused element, which must be in this state's window; pass ref to focus a specific input first. They take no x/y: click the point first. Headless mode requires ref.",
    'Every action is validated before anything is sent; an invalid one rejects the whole call ("act_ui action N (<action>): … Nothing was sent.") and the stateId stays usable. Result status "partial": action stoppedAt+1 failed during delivery after the earlier ones ran (execution.error says why); continue from the returned state and do not resend delivered actions. foreground_required, cancelled, owned_by_other_session, target_closed, and post_action_observation_failed return no successor state: call observe_ui before acting again.',
  ],
  parameters: Type.Object({
    stateId: actionStateId,
    expect: Type.Optional(Type.Object(conditionProperties)),
    actions: Type.Array(uiAction, { minItems: 1, maxItems: 20 }),
  }),
  execute: executeAct,
});

const readTextTool = defineTool({
  name: "read_text",
  label: "Read Text",
  description: "Read a fixed-size page from an @e UI ref or immutable @o truncated-output ref.",
  promptSnippet: "Use @e with its stateId; @o continuation refs don't need stateId.",
  parameters: Type.Object({
    ref: Type.String(),
    offset: Type.Optional(Type.Number({ minimum: 0 })),
    stateId: Type.Optional(stateId),
  }),
  execute: executeReadText,
});

const waitForTool = defineTool({
  name: "wait_for",
  label: "Wait For",
  description: "Wait for one scoped UI condition and return the successor state.",
  promptSnippet: "Use after asynchronous UI changes instead of polling observe_ui.",
  parameters: Type.Object({ ...conditionProperties, stateId }),
  execute: executeWaitFor,
});

const launchBrowserTool = defineTool({
  name: "launch_browser",
  label: "Launch Browser Context",
  description:
    "Launch the configured Pi-managed CDP browser and return an observed browser-page state.",
  promptSnippet: "Use for browser work that needs a managed CDP context.",
  promptGuidelines: ["Prefer curl through bash when the page is directly fetchable."],
  parameters: Type.Object({ url: Type.Optional(Type.String({ maxLength: 8192 })) }),
  execute: executeLaunchBrowser,
});

const navigateBrowserTool = defineTool({
  name: "navigate_browser",
  label: "Navigate Browser",
  description: "Navigate an observed CDP browser-page state to an HTTP(S) URL.",
  promptSnippet: "Native browser windows use act_ui; this tool is CDP-only.",
  parameters: Type.Object({ url: Type.String({ maxLength: 8192 }), stateId }),
  execute: executeNavigateBrowser,
});

const evaluateBrowserTool = defineTool({
  name: "evaluate_browser",
  label: "Evaluate Browser",
  description:
    "Evaluate targeted JavaScript in a CDP browser-page state; returned output is strictly bounded.",
  promptSnippet:
    "Prefer observe/search/read; return selected fields, aggregates, or bounded slices.",
  parameters: Type.Object({ stateId, expression: Type.String({ maxLength: 65_536 }) }),
  execute: executeEvaluateBrowser,
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
