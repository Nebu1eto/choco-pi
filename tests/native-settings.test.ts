import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  buildNativeSettingsSections,
  createHostCommandContext,
  installNativeSettingsBridge,
  type NativeSettingsHost,
} from "../.pi/extensions/lib/native-settings.ts";
import type { PreferencesExtraSection } from "../.pi/extensions/lib/agent-preferences.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const BRIDGE_SYMBOL = Symbol.for("choco-pi.native-settings-bridge");

type PrototypeRecord = Record<PropertyKey, RuntimeValue>;

function prototypeRecord(): PrototypeRecord {
  // SAFETY: the bridge patches these host methods by name, so the test drives the same shape.
  return reinterpretHostValue<PrototypeRecord>(InteractiveMode.prototype);
}

/**
 * Stands in for Pi's `showSettingsSelector`: it builds the rows and hands the
 * component to `showSelector`, which is the seam the bridge collects from.
 */
function fakeNativeSettings(items: SettingItem[], changes: [string, string][]) {
  return function fakeShowSettingsSelector(this: NativeSettingsHost): void {
    this.showSelector(() => ({
      component: {
        getSettingsList: () => ({
          items,
          onChange: (id: string, newValue: string) => changes.push([id, newValue]),
        }),
      },
      focus: undefined,
    }));
  };
}

function withPatchedPrototype(showSettingsSelector: RuntimeValue, run: () => void | Promise<void>) {
  return async () => {
    const prototype = prototypeRecord();
    const store = reinterpretHostValue<PrototypeRecord>(globalThis);
    const originalShow = prototype["showSettingsSelector"];
    const originalSetup = prototype["setupAutocompleteProvider"];
    const originalBridge = store[BRIDGE_SYMBOL];
    prototype["showSettingsSelector"] = showSettingsSelector;
    delete store[BRIDGE_SYMBOL];
    try {
      await run();
    } finally {
      prototype["showSettingsSelector"] = originalShow;
      prototype["setupAutocompleteProvider"] = originalSetup;
      if (originalBridge === undefined) delete store[BRIDGE_SYMBOL];
      else store[BRIDGE_SYMBOL] = originalBridge;
    }
  };
}

const ROWS: SettingItem[] = [
  { id: "theme", label: "Theme", currentValue: "nord-dark" },
  { id: "hide-thinking", label: "Hide thinking", currentValue: "false", values: ["true", "false"] },
  { id: "editor-padding", label: "Editor padding", currentValue: "0", values: ["0", "1"] },
  { id: "output-padding", label: "Output padding", currentValue: "1", values: ["0", "1"] },
  { id: "tui-mode", label: "TUI mode", currentValue: "regular", values: ["regular", "fullscreen"] },
  { id: "autocompact", label: "Auto-compact", currentValue: "true", values: ["true", "false"] },
  { id: "thinking", label: "Thinking level", currentValue: "high" },
  {
    id: "skill-commands",
    label: "Skill commands",
    currentValue: "true",
    values: ["true", "false"],
  },
  { id: "future-row", label: "Future row", currentValue: "off", values: ["off", "on"] },
];

function sectionRowIds(sections: PreferencesExtraSection[], id: string): string[] {
  return (
    sections
      .find((section) => section.id === id)
      ?.buildItems()
      .map((item) => item.id) ?? []
  );
}

test(
  "/settings opens the unified dialog and remembers the interactive mode",
  withPatchedPrototype(fakeNativeSettings(ROWS, []), () => {
    const opened: NativeSettingsHost[] = [];
    installNativeSettingsBridge((host) => opened.push(host));

    const host = reinterpretHostValue<NativeSettingsHost>({});
    const patched = reinterpretHostValue<(this: NativeSettingsHost) => void>(
      prototypeRecord()["showSettingsSelector"],
    );
    patched.call(host);

    assert.deepEqual(opened, [host]);
    assert.ok(buildNativeSettingsSections().length > 0);
  }),
);

test(
  "Pi's rows are spread over the panel by topic and unknown rows keep their own tab",
  withPatchedPrototype(fakeNativeSettings(ROWS, []), () => {
    const changes: [string, string][] = [];
    const prototype = prototypeRecord();
    prototype["showSettingsSelector"] = fakeNativeSettings(ROWS, changes);
    installNativeSettingsBridge(() => {});

    const host = reinterpretHostValue<NativeSettingsHost>({});
    reinterpretHostValue<(this: NativeSettingsHost) => void>(
      prototype["showSettingsSelector"],
    ).call(host);

    const sections = buildNativeSettingsSections();

    // Merged sections contribute rows to an existing tab and own none.
    for (const [id, target] of [
      ["pi:appearance", "appearance"],
      ["pi:editor", "editor"],
      ["pi:userMessages", "userMessages"],
    ] as const) {
      assert.equal(sections.find((section) => section.id === id)?.mergeInto, target);
    }
    for (const id of ["terminal", "session", "model", "tools", "pi"]) {
      assert.equal(sections.find((section) => section.id === id)?.mergeInto, undefined);
    }

    assert.deepEqual(sectionRowIds(sections, "pi:appearance"), [
      "piSourceHeader:appearance",
      "theme",
      "hide-thinking",
    ]);
    assert.deepEqual(sectionRowIds(sections, "pi:editor"), [
      "piSourceHeader:editor",
      "editor-padding",
    ]);
    // A section Pi owns needs no source header: its rows come first.
    assert.deepEqual(sectionRowIds(sections, "terminal"), ["tui-mode"]);
    assert.deepEqual(sectionRowIds(sections, "session"), ["autocompact"]);
    assert.deepEqual(sectionRowIds(sections, "model"), ["thinking"]);
    assert.deepEqual(sectionRowIds(sections, "tools"), ["skill-commands"]);
    // A row no layout entry claims must stay reachable.
    assert.deepEqual(sectionRowIds(sections, "pi"), ["future-row"]);

    const appearance = sections.find((section) => section.id === "pi:appearance");
    const terminal = sections.find((section) => section.id === "terminal");
    assert.deepEqual(appearance?.handleChange("hide-thinking", "true"), { kind: "update" });
    assert.deepEqual(terminal?.handleChange("tui-mode", "fullscreen"), { kind: "rebuild" });
    assert.deepEqual(changes, [
      ["hide-thinking", "true"],
      ["tui-mode", "fullscreen"],
    ]);

    // The collector must not leave its own showSelector behind on the host.
    assert.equal(Object.prototype.hasOwnProperty.call(host, "showSelector"), false);
  }),
);

test(
  "an unreadable settings list degrades to a single explanatory row",
  withPatchedPrototype(
    function brokenShowSettingsSelector(this: NativeSettingsHost): void {
      this.showSelector(() => ({ component: {}, focus: undefined }));
    },
    () => {
      installNativeSettingsBridge(() => {});
      const host = reinterpretHostValue<NativeSettingsHost>({});
      reinterpretHostValue<(this: NativeSettingsHost) => void>(
        prototypeRecord()["showSettingsSelector"],
      ).call(host);

      const sections = buildNativeSettingsSections();
      assert.deepEqual(sectionRowIds(sections, "pi"), ["piSettingsUnavailable"]);
      const fallback = sections.find((section) => section.id === "pi");
      assert.deepEqual(fallback?.handleChange("piSettingsUnavailable", "unavailable"), {
        kind: "update",
      });
    },
  ),
);

test(
  "the bridge reports no command context when the host exposes no session",
  withPatchedPrototype(fakeNativeSettings(ROWS, []), () => {
    installNativeSettingsBridge(() => {});
    assert.equal(createHostCommandContext(reinterpretHostValue<NativeSettingsHost>({})), undefined);
  }),
);
