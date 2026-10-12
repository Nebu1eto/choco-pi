import type { SessionRefSnapshot } from "../session-page-state.ts";
import { buildNextToolAction, type AgentBrowserNextAction } from "./next-actions.ts";

interface SelectorHintInput {
  commandTokens: string[];
  sessionName?: string;
}

interface SelectorHintTarget {
  action: "click" | "fill";
  selector: string;
  text: string | undefined;
}

function getTarget(input: SelectorHintInput): SelectorHintTarget | undefined {
  const [action, selector, text] = input.commandTokens;
  if ((action !== "click" && action !== "fill") || !selector) return undefined;
  if (action === "fill" && text === undefined) return undefined;
  return { action, selector, text };
}

export function buildPlaywrightSelectorHint(input: SelectorHintInput): AgentBrowserNextAction[] {
  const target = getTarget(input);
  if (!target || !/^text=|:has-text\(|^role=|^label=/u.test(target.selector)) return [];
  const prefix = /^(text|role|label)=(.+)$/u.exec(target.selector);
  const hasText = /:has-text\((["'])(.*?)\1\)$/u.exec(target.selector);
  const value = prefix?.[2] ?? hasText?.[2];
  if (!value) return [];
  let locator: "role" | "label" | "text" = "text";
  if (prefix?.[1] === "role") locator = "role";
  else if (prefix?.[1] === "label") locator = "label";
  const semanticAction: NonNullable<
    NonNullable<AgentBrowserNextAction["params"]>["semanticAction"]
  > = {
    action: target.action,
    locator,
  };
  if (locator === "role") semanticAction.role = value;
  else semanticAction.value = value;
  if (target.action === "fill") semanticAction.text = target.text;
  if (input.sessionName) semanticAction.session = input.sessionName;
  return [
    {
      id: "use-semantic-action-for-playwright-selector",
      params: { semanticAction },
      reason: "Playwright selector dialect is not supported by agent-browser",
      safety:
        "Inspect the current snapshot to confirm the intended target; CSS constraints are not carried into the text locator.",
      tool: "agent_browser",
    },
  ];
}

function normalizeSnapshotName(value: string): string {
  return value
    .replaceAll("...", "…")
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll(/[“”]/gu, '"');
}

export function buildUnicodeSelectorHint(
  input: SelectorHintInput & {
    snapshot?: SessionRefSnapshot;
  },
): AgentBrowserNextAction[] {
  const target = getTarget(input);
  if (!target || !input.snapshot?.refs) return [];
  const attribute = /\[(?:placeholder|aria-label|title|alt)\s*=\s*(["'])(.*?)\1\]/u.exec(
    target.selector,
  );
  const value = attribute?.[2];
  if (!value) return [];
  const matches = Object.entries(input.snapshot.refs).filter(
    ([ref, details]) =>
      input.snapshot?.refIds.includes(ref) &&
      details.name !== value &&
      normalizeSnapshotName(details.name) === normalizeSnapshotName(value) &&
      (target.action !== "fill" ||
        details.isEditable ||
        details.isContentEditable ||
        details.role === "textbox" ||
        details.role === "searchbox" ||
        details.role === "combobox"),
  );
  if (matches.length !== 1) return [];
  const args = [target.action, `@${matches[0][0]}`];
  if (target.action === "fill" && target.text !== undefined) args.push(target.text);
  if (input.sessionName) args.unshift("--session", input.sessionName);
  return [
    buildNextToolAction({
      args,
      id: "use-unicode-snapshot-ref",
      reason: "placeholder uses Unicode ellipsis",
      safety: "Use only while this snapshot remains current; re-snapshot after rerendering.",
    }),
  ];
}
