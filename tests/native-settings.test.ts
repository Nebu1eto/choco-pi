import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  buildNativeSettingsSection,
  createHostCommandContext,
  installNativeSettingsBridge,
  type NativeSettingsHost,
} from "../.pi/extensions/lib/native-settings.ts";
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
  { id: "hide-thinking", label: "Hide thinking", currentValue: "false", values: ["true", "false"] },
  { id: "tui-mode", label: "TUI mode", currentValue: "regular", values: ["regular", "fullscreen"] },
];

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
    assert.equal(buildNativeSettingsSection()?.id, "pi");
  }),
);

test(
  "the Pi section serves Pi's own rows and forwards changes to Pi's handler",
  withPatchedPrototype(fakeNativeSettings(ROWS, []), () => {
    const changes: [string, string][] = [];
    const prototype = prototypeRecord();
    prototype["showSettingsSelector"] = fakeNativeSettings(ROWS, changes);
    installNativeSettingsBridge(() => {});

    const host = reinterpretHostValue<NativeSettingsHost>({});
    reinterpretHostValue<(this: NativeSettingsHost) => void>(
      prototype["showSettingsSelector"],
    ).call(host);

    const section = buildNativeSettingsSection();
    assert.ok(section);
    assert.deepEqual(
      section.buildItems().map((item) => item.id),
      ["hide-thinking", "tui-mode"],
    );
    assert.deepEqual(section.handleChange("hide-thinking", "true"), { kind: "update" });
    assert.deepEqual(section.handleChange("tui-mode", "fullscreen"), { kind: "rebuild" });
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

      const section = buildNativeSettingsSection();
      assert.ok(section);
      assert.deepEqual(
        section.buildItems().map((item) => item.id),
        ["piSettingsUnavailable"],
      );
      assert.deepEqual(section.handleChange("piSettingsUnavailable", "unavailable"), {
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
