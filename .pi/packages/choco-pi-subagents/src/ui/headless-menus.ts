/**
 * headless-menus.ts — dialog-only fallbacks for `/agents` and `/btw` outside the TUI.
 *
 * Pi's RPC mode forwards select/input/confirm/notify to the host, but
 * `ctx.ui.custom()` resolves to `undefined` there. The `/agents` list, settings
 * panel, and conversation viewer are custom components, so without these
 * fallbacks an RPC host would see the menu silently reopen. Each helper keeps
 * to dialogs and notices a host can render.
 */

import type { SettingItem } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.ts";
import { selectItem, type SelectUI } from "./select-item.ts";

export interface HeadlessUI extends SelectUI {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Longest answer body placed in one notice; longer text is cut with a marker. */
const NOTICE_BODY_LIMIT = 4000;

function clip(text: string): string {
  return text.length > NOTICE_BODY_LIMIT ? `${text.slice(0, NOTICE_BODY_LIMIT)}…` : text;
}

/** Choose an agent type from a numbered dialog instead of the settings list. */
export async function pickAgentType(
  ui: SelectUI,
  items: readonly SettingItem[],
): Promise<string | undefined> {
  const item = await selectItem(
    ui,
    "Agent types",
    items,
    (entry) => `${entry.label.trim()} · ${entry.currentValue}`,
  );
  return item?.id;
}

/**
 * Edit subagent settings through dialogs. Each pass offers every row with its
 * current value; numeric rows take typed input and the rest a value picker.
 * Cancelling the row picker ends the loop.
 */
export async function editSettingsWithDialogs(
  ui: HeadlessUI,
  buildItems: () => SettingItem[],
  applyValue: (id: string, value: string) => void,
  numeric: { ids: ReadonlySet<string>; label: (item: SettingItem) => string },
): Promise<void> {
  for (;;) {
    const item = await selectItem(
      ui,
      "Subagent settings",
      buildItems(),
      (entry) => `${entry.label}: ${entry.currentValue}`,
    );
    if (!item) return;
    if (numeric.ids.has(item.id)) {
      let input = await ui.input(numeric.label(item), item.currentValue);
      while (input !== undefined) {
        const trimmed = input.trim();
        if (trimmed !== "" && Number.isInteger(Number(trimmed))) {
          applyValue(item.id, String(Number(trimmed)));
          break;
        }
        ui.notify(`${item.label} needs a whole number.`, "warning");
        input = await ui.input(numeric.label(item), trimmed);
      }
      continue;
    }
    const values = item.values ?? [];
    if (values.length === 0) continue;
    const value = await ui.select(`${item.label} (current: ${item.currentValue})`, values);
    if (value !== undefined) applyValue(item.id, value);
  }
}

/** The agent's latest answer, or why there is none yet. */
export function describeAgentResult(record: AgentRecord): string {
  const answer = record.result?.trim();
  if (answer) return clip(answer);
  if (record.error) return `Error: ${clip(record.error)}`;
  return record.status === "running" || record.status === "queued"
    ? "No answer yet."
    : "No answer was recorded.";
}

/** Notice text standing in for the live conversation viewer. */
export function headlessConversationNotice(record: AgentRecord, label: string): string {
  return `${label} · ${record.status}\n\n${describeAgentResult(record)}\n\nThe live conversation view needs the terminal UI.`;
}
