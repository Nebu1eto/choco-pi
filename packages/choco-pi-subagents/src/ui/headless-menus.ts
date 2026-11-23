import type { SettingItem } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.ts";
import { selectItem, type SelectUI } from "./select-item.ts";

export interface HeadlessUI extends SelectUI {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

const NOTICE_BODY_LIMIT = 4000;

function clip(text: string): string {
  return text.length > NOTICE_BODY_LIMIT ? `${text.slice(0, NOTICE_BODY_LIMIT)}…` : text;
}

export const BACK: unique symbol = Symbol("back");

const BACK_LABEL = "Back";

export async function pickAgentType(
  ui: SelectUI,
  items: readonly SettingItem[],
): Promise<string | typeof BACK | undefined> {
  const rows: ReadonlyArray<SettingItem | typeof BACK> = [...items, BACK];
  const item = await selectItem(ui, "Agent types", rows, (entry) =>
    entry === BACK ? BACK_LABEL : `${entry.label.trim()} · ${entry.currentValue}`,
  );
  if (item === undefined) return undefined;
  return item === BACK ? BACK : item.id;
}

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

export function describeAgentResult(record: AgentRecord): string {
  const answer = record.result?.trim();
  if (answer) return clip(answer);
  if (record.error) return `Error: ${clip(record.error)}`;
  return record.status === "running" || record.status === "queued"
    ? "No answer yet."
    : "No answer was recorded.";
}

export function headlessConversationNotice(record: AgentRecord, label: string): string {
  return `${label} · ${record.status}\n\n${describeAgentResult(record)}\n\nThe live conversation view needs the terminal UI.`;
}
