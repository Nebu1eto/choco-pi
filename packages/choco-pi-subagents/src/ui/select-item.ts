export interface SelectUI {
  select(title: string, options: string[]): Promise<string | undefined>;
}

export async function selectItem<T>(
  ui: SelectUI,
  title: string,
  items: readonly T[],
  format: (item: T, index: number) => string,
): Promise<T | undefined> {
  const width = String(items.length).length;
  const rows = items.map((item, i) => ({
    item,
    label: `${String(i + 1).padStart(width)}. ${format(item, i)}`,
  }));

  const choice = await ui.select(
    title,
    rows.map((r) => r.label),
  );
  if (!choice) return undefined;
  return rows.find((r) => r.label === choice)?.item;
}
