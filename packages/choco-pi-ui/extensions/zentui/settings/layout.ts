import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SettingItem, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "../config.ts";
import { safeThemeFg } from "../style.ts";
import { buildSectionItems } from "./sections.ts";
import {
  type PreferencesExtraSection,
  type PreferencesLayoutTab,
  sectionLabels,
  type SettingsSection,
  settingsSections,
} from "./types.ts";
export function standaloneExtras(extras: PreferencesExtraSection[]): PreferencesExtraSection[] {
  return extras.filter((extra) => extra.mergeInto === undefined);
}

/** Source-to-target map of sections rendered inside another section. */
export type SectionMerges = Readonly<Record<string, string>>;

/** Layout entry prefix that takes every remaining row of one source section. */
const SECTION_ROW_PREFIX = "section:";

/** A section that builds rows: built-in, or contributed by the host. */
export interface RowSource {
  id: string;
  label: string;
  /** The tab an unplaced row of this source falls back to. */
  home: string;
  owner?: PreferencesExtraSection;
  build: () => SettingItem[];
}

export function rowSources(
  config: PolishedTuiConfig,
  active: ReadonlyMap<string, string>,
  extras: PreferencesExtraSection[],
): RowSource[] {
  // A standalone host section that reuses a built-in id replaces that section.
  const replaced = new Set(standaloneExtras(extras).map((extra) => extra.id));
  const builtin: RowSource[] = settingsSections
    .filter((section) => !replaced.has(section))
    .map((section) => ({
      id: section,
      label: sectionLabels[section],
      home: section,
      build: () => buildSectionItems(section, config, active),
    }));
  const hosted: RowSource[] = extras.map((extra) => ({
    id: extra.id,
    label: extra.label,
    home: extra.mergeInto ?? extra.id,
    owner: extra,
    build: () => extra.buildItems(),
  }));
  return [...builtin, ...hosted];
}

export interface PlacedGroup {
  label?: string;
  rows: SettingItem[];
}

export interface PlacedTab {
  id: string;
  label: string;
  groups: PlacedGroup[];
}

/** Every placed row by tab and group, plus where each row came from. */
export interface Placement {
  tabs: PlacedTab[];
  /** Host section that owns each contributed row; changes dispatch by row id. */
  owners: Map<string, PreferencesExtraSection>;
  rowSource: Map<string, string>;
}

/**
 * Places rows into tab groups. Explicit row ids win over `section:` entries,
 * hidden rows are dropped, and with `withFallback` every row left over is
 * appended to its source's home tab — an existing tab gains a group headed by
 * the source label, any other home becomes a tab of its own.
 *
 * Without explicit entries or fallback only the sources the given tabs name
 * are built, which keeps a single-tab placement as cheap as the tab itself.
 */
export function placeRows(
  specs: readonly PreferencesLayoutTab[],
  sources: readonly RowSource[],
  hidden: ReadonlySet<string>,
  withFallback: boolean,
): Placement {
  const built = new Map<string, SettingItem[]>();
  const rowsOf = (source: RowSource): SettingItem[] => {
    let rows = built.get(source.id);
    if (rows === undefined) {
      rows = source.build();
      built.set(source.id, rows);
    }
    return rows;
  };
  const byId = new Map<string, SettingItem>();
  const rowSource = new Map<string, string>();
  const owners = new Map<string, PreferencesExtraSection>();
  const indexed = new Set<string>();
  const index = (source: RowSource): void => {
    if (indexed.has(source.id)) return;
    indexed.add(source.id);
    for (const item of rowsOf(source)) {
      // The first source to build an id owns it; a duplicate never renders twice.
      if (rowSource.has(item.id)) continue;
      byId.set(item.id, item);
      rowSource.set(item.id, source.id);
      if (source.owner) owners.set(item.id, source.owner);
    }
  };
  const explicit = new Set(
    specs.flatMap((tab) =>
      tab.groups.flatMap((group) =>
        group.rows.filter((row) => !row.startsWith(SECTION_ROW_PREFIX)),
      ),
    ),
  );
  if (explicit.size > 0 || withFallback) for (const source of sources) index(source);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const taken = new Set<string>();
  const take = (item: SettingItem, rows: SettingItem[]): void => {
    taken.add(item.id);
    rows.push(item);
  };
  const tabs: PlacedTab[] = specs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    groups: spec.groups.map((group) => {
      const rows: SettingItem[] = [];
      for (const entry of group.rows) {
        if (entry.startsWith(SECTION_ROW_PREFIX)) {
          const source = sourceById.get(entry.slice(SECTION_ROW_PREFIX.length));
          if (source === undefined) continue;
          index(source);
          for (const item of rowsOf(source)) {
            if (rowSource.get(item.id) !== source.id) continue;
            if (taken.has(item.id) || explicit.has(item.id) || hidden.has(item.id)) continue;
            take(item, rows);
          }
          continue;
        }
        const item = byId.get(entry);
        if (item === undefined || taken.has(entry) || hidden.has(entry)) continue;
        take(item, rows);
      }
      const placed: PlacedGroup = { rows };
      if (group.label !== undefined) placed.label = group.label;
      return placed;
    }),
  }));
  if (withFallback) {
    for (const source of sources) {
      const rest = rowsOf(source).filter(
        (item) =>
          rowSource.get(item.id) === source.id && !taken.has(item.id) && !hidden.has(item.id),
      );
      if (rest.length === 0) continue;
      for (const item of rest) taken.add(item.id);
      const existing = tabs.find((tab) => tab.id === source.home);
      if (existing) {
        existing.groups.push({ label: source.label, rows: rest });
        continue;
      }
      const homeSource = sourceById.get(source.home);
      tabs.push({
        id: source.home,
        label: homeSource?.label ?? source.label,
        groups: [{ rows: rest }],
      });
    }
  }
  return { tabs, owners, rowSource };
}

/**
 * The layout the panel used before hosts could define one: one tab per
 * section, merged host sections folded into their target, and each
 * `mergeSections` source rendered as a headed block of its target.
 */
export function legacyLayout(
  extras: PreferencesExtraSection[],
  merges: SectionMerges,
  override?: readonly string[],
): PreferencesLayoutTab[] {
  const tokensFor = (section: string): string[] => [
    `${SECTION_ROW_PREFIX}${section}`,
    ...extras
      .filter((extra) => extra.mergeInto === section)
      .map((extra) => `${SECTION_ROW_PREFIX}${extra.id}`),
  ];
  return sectionOrder(extras, merges, override).map((id) => ({
    id,
    label: sectionLabel(id, extras),
    groups: [
      { rows: tokensFor(id) },
      ...Object.entries(merges)
        .filter(([, target]) => target === id)
        .map(([source]) => ({ label: sectionLabel(source, extras), rows: tokensFor(source) })),
    ],
  }));
}

/** One tab's rows in render order and the ids of its heading rows. */
export interface TabItems {
  items: SettingItem[];
  headers: Set<string>;
}

/** One tab's rows in render order; each labeled group opens with a dim heading. */
export function tabItems(
  tab: PlacedTab | undefined,
  theme: ExtensionContext["ui"]["theme"],
): TabItems {
  const items: SettingItem[] = [];
  const headers = new Set<string>();
  if (tab === undefined) return { items, headers };
  tab.groups.forEach((group, index) => {
    if (group.rows.length === 0) return;
    if (group.label !== undefined) {
      const id = `sectionHeader:${tab.id}:${index}`;
      headers.add(id);
      items.push({ id, label: safeThemeFg(theme, "dim", group.label), currentValue: "" });
    }
    items.push(...group.rows);
  });
  return { items, headers };
}

export function sectionOrder(
  extras: PreferencesExtraSection[],
  merges: SectionMerges = {},
  override?: readonly string[],
): string[] {
  const builtin = new Set<string>(settingsSections);
  const merged = new Set(Object.keys(merges));
  const available = [
    ...settingsSections,
    ...standaloneExtras(extras)
      .filter((extra) => !builtin.has(extra.id))
      .map((e) => e.id),
  ].filter((id) => !merged.has(id));
  if (!override) return available;
  const known = new Set(available);
  const ordered = override.filter((id) => known.has(id));
  const promoted = new Set(ordered);
  return [...ordered, ...available.filter((id) => !promoted.has(id))];
}
export function sectionLabel(section: string, extras: PreferencesExtraSection[]): string {
  const extra = standaloneExtras(extras).find((candidate) => candidate.id === section);
  if (extra) return extra.label;
  // SAFETY: the lookup is nullish-guarded, so a section outside the built-in union falls back to its own id.
  return sectionLabels[section as SettingsSection] ?? section;
}
export function nextSection(section: string, order: readonly string[]): string {
  return order[(order.indexOf(section) + 1) % order.length] ?? order[0] ?? "appearance";
}
export function previousSection(section: string, order: readonly string[]): string {
  return (
    order[(order.indexOf(section) - 1 + order.length) % order.length] ?? order[0] ?? "appearance"
  );
}
/** Rows the settings list shows at once; it scrolls to keep the selection in view. */
export const LIST_ROWS = 8;

/**
 * The rows the settings list draws in its window, as pi-tui's SettingsList
 * picks them: centered on the selection where the list allows. The mouse
 * maps a row back to its item with it.
 */
export function visibleListRange(selected: number, count: number) {
  const start = Math.max(0, Math.min(selected - Math.floor(LIST_ROWS / 2), count - LIST_ROWS));
  return { start, end: Math.min(start + LIST_ROWS, count) };
}

/** A forwarded mouse result without its focus request: the host keeps keyboard focus. */
export function keepHostFocus(
  result: TuiMouseEventResult | undefined,
): TuiMouseEventResult | undefined {
  if (result === undefined || !(result.handled || result.capture || result.focus)) return undefined;
  const kept: TuiMouseEventResult = { handled: true };
  if (result.capture) kept.capture = true;
  if (result.render !== undefined) kept.render = result.render;
  return kept;
}

/**
 * One cell of the section strip: a section's label, or a `‹`/`›` marker
 * that stands for the sections hidden on its side and names the nearest one.
 */
export interface StripCell {
  section: string;
  kind: "label" | "more";
  text: string;
  column: number;
}

/**
 * The section strip laid out for `width`: every label when they fit,
 * otherwise the widest run of neighbours around the active section, with a
 * marker on each side that hides sections. `undefined` when not even the
 * active label fits that way.
 */
export function sectionStrip(
  active: string,
  labelOf: (section: string) => string,
  width: number,
  order: readonly string[],
): StripCell[] | undefined {
  const count = order.length;
  const widths = order.map((section) => visibleWidth(labelOf(section)));
  const span = (low: number, high: number): number => {
    let total = 2 + (low > 0 ? 2 : 0) + (high < count - 1 ? 2 : 0) + 3 * (high - low);
    for (let index = low; index <= high; index += 1) total += widths[index] ?? 0;
    return total;
  };
  let low = 0;
  let high = count - 1;
  if (count === 0) return undefined;
  if (span(low, high) > width) {
    low = Math.max(0, order.indexOf(active));
    high = low;
    if (span(low, high) > width) return undefined;
    for (let grew = true; grew;) {
      grew = false;
      if (high < count - 1 && span(low, high + 1) <= width) {
        high += 1;
        grew = true;
      }
      if (low > 0 && span(low - 1, high) <= width) {
        low -= 1;
        grew = true;
      }
    }
  }
  const cells: StripCell[] = [];
  let column = 2;
  const before = order[low - 1];
  if (before !== undefined) {
    cells.push({ section: before, kind: "more", text: "‹", column });
    column += 2;
  }
  for (let index = low; index <= high; index += 1) {
    const section = order[index];
    if (section === undefined) continue;
    cells.push({ section, kind: "label", text: labelOf(section), column });
    column += (widths[index] ?? 0) + 3;
  }
  const after = order[high + 1];
  // The marker follows the last label after one space, not a separator.
  if (after !== undefined)
    cells.push({ section: after, kind: "more", text: "›", column: column - 2 });
  return cells;
}

export function formatSectionTabs(
  active: string,
  labelOf: (section: string) => string,
  theme: ExtensionContext["ui"]["theme"],
  width: number,
  order: readonly string[],
): string {
  const cells = sectionStrip(active, labelOf, width, order);
  if (cells === undefined)
    return `  ${theme.bold(labelOf(active))} (${order.indexOf(active) + 1}/${order.length})`;
  let strip = "  ";
  let previous: StripCell | undefined;
  for (const cell of cells) {
    if (previous !== undefined)
      strip +=
        previous.kind === "label" && cell.kind === "label"
          ? safeThemeFg(theme, "muted", " / ")
          : " ";
    strip +=
      cell.kind === "label" && cell.section === active
        ? theme.bold(cell.text)
        : safeThemeFg(theme, "muted", cell.text);
    previous = cell;
  }
  return strip;
}
/**
 * The section a click at column `x` of the strip formatSectionTabs draws
 * picks: a label's own section, or for a marker the nearest hidden one.
 */
export function sectionAtColumn(
  x: number,
  active: string,
  labelOf: (section: string) => string,
  width: number,
  order: readonly string[],
): string | undefined {
  return sectionStrip(active, labelOf, width, order)?.find(
    (cell) => x >= cell.column && x < cell.column + visibleWidth(cell.text),
  )?.section;
}
export function withSectionFooter(
  lines: readonly string[],
  theme: ExtensionContext["ui"]["theme"],
  mode: "section" | "search" = "section",
): string[] {
  const copy = [...lines];
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    if (copy[index]?.includes("Enter/Space")) {
      copy[index] = safeThemeFg(
        theme,
        "muted",
        mode === "search"
          ? "  Type to filter · Enter/Space to change · Esc to stop searching"
          : "  Enter/Space to change · ←/→ to switch sections · / to search · Esc to close",
      );
      break;
    }
  }
  return copy;
}
