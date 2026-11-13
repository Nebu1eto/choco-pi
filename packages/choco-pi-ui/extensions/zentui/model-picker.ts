import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  SelectList,
  type Focusable,
  type SettingItem,
} from "@earendil-works/pi-tui";

class ModelPicker extends Container implements Focusable {
  private input = new Input({ prompt: "Filter models: " });
  private list: SelectList;

  constructor(list: SelectList) {
    super();
    this.list = list;
    // SettingsList forwards keys, but does not propagate focus to its submenu.
    this.input.focused = true;
    this.addChild(this.input);
    this.addChild(list);
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (
      keys.matches(data, "tui.select.up") ||
      keys.matches(data, "tui.select.down") ||
      keys.matches(data, "tui.select.confirm") ||
      keys.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
      return;
    }
    const previous = this.input.getValue();
    this.input.handleInput(data);
    const filter = this.input.getValue();
    if (filter !== previous) this.list.setFilter(filter);
  }
}

export function modelPickerSubmenu(args: {
  choices: readonly { provider: string; id: string }[];
  onPick: (value: string) => void;
}): NonNullable<SettingItem["submenu"]> {
  const values = [
    ...new Set(
      [...args.choices]
        .sort(
          (left, right) =>
            left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
        )
        .map(({ provider, id }) => `${provider}/${id}`),
    ),
  ];
  return (currentValue, done) => {
    const items =
      values.length > 0
        ? values.map((value) => ({ value, label: value }))
        : [{ value: "", label: "no models available" }];
    const theme = getSelectListTheme();
    const list = new SelectList(items, 8, {
      ...theme,
      noMatch: () => theme.noMatch("  No matching models"),
    });
    list.setSelectedIndex(
      values.findIndex((value) => value.toLowerCase() === currentValue.toLowerCase()),
    );
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      if (value !== undefined) args.onPick(value);
      done(value);
    };
    list.onSelect = (item) => finish(values.length > 0 ? item.value : undefined);
    list.onCancel = () => finish();
    // Keep the empty placeholder selectable only as a cancel action.
    return values.length > 0 ? new ModelPicker(list) : list;
  };
}
