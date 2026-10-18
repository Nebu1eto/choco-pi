import assert from "node:assert/strict";
import test from "node:test";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "../../../../tests/zentui-build.ts";
import {
  reinterpretHostValue,
  type RuntimeValue,
} from "../../../../.pi/extensions/lib/runtime-values.ts";

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** Installs a fake subagents registry for one test and restores the slot afterwards. */
function withChildRegistry(inChild: () => boolean, restore: (cleanup: () => void) => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY);
  Object.defineProperty(globalThis, SUBAGENTS_MANAGER_KEY, {
    configurable: true,
    writable: true,
    value: { isChildSessionContext: inChild },
  });
  restore(() => {
    if (previous) Object.defineProperty(globalThis, SUBAGENTS_MANAGER_KEY, previous);
    else Reflect.deleteProperty(globalThis, SUBAGENTS_MANAGER_KEY);
  });
}

const PROVIDER_SYMBOL = Symbol.for("choco-pi.preferences-provider");

/** The deps are never called here: only whether the slot is published matters. */
type RegisterModule = { registerZentuiPreferencesProvider: (deps: RuntimeValue) => void };
const UNUSED_DEPS: RuntimeValue = {};

test(
  "a subagent child load leaves the main session's preferences panel alone",
  { skip: SKIP_WITHOUT_ZENTUI },
  async (t) => {
    const module = reinterpretHostValue<RegisterModule>(
      await loadZentuiModule("settings-command.js"),
    );
    const previous = Object.getOwnPropertyDescriptor(globalThis, PROVIDER_SYMBOL);
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, PROVIDER_SYMBOL, previous);
      else Reflect.deleteProperty(globalThis, PROVIDER_SYMBOL);
    });
    let inChild = false;
    withChildRegistry(
      () => inChild,
      (cleanup) => t.after(cleanup),
    );

    Reflect.deleteProperty(globalThis, PROVIDER_SYMBOL);
    module.registerZentuiPreferencesProvider(UNUSED_DEPS);
    const mainProvider = Object.getOwnPropertyDescriptor(globalThis, PROVIDER_SYMBOL)?.value;
    assert.ok(mainProvider, "the main session publishes the panel");

    inChild = true;
    module.registerZentuiPreferencesProvider(UNUSED_DEPS);
    assert.equal(
      Object.getOwnPropertyDescriptor(globalThis, PROVIDER_SYMBOL)?.value,
      mainProvider,
      "a child load does not replace it",
    );
  },
);
