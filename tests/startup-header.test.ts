import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InteractiveMode, VERSION, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  CHOCO_PI_DESCRIPTION,
  LOGO_WIDTH,
  StartupHeader,
  installStartupPolicy,
  logoFits,
  readHarnessVersion,
  type HeaderTheme,
} from "../profile/extensions/startup-header.ts";
import {
  isFunction,
  reinterpretHostValue,
  type RuntimeValue,
} from "../profile/extensions/lib/runtime-values.ts";

initTheme("dark", false);

const plainTheme: HeaderTheme = {
  fg: (_color, text) => text,
  bold: (text: string) => text,
  getColorMode: () => "truecolor",
};

type HostPrototype = Parameters<typeof installStartupPolicy>[0] & {};

function hostPrototype(quietStartup: boolean | "header"): HostPrototype {
  return {
    shouldShowStartupHeader(this: { options: { verbose?: boolean } }): boolean {
      return this.options.verbose === true || quietStartup !== true;
    },
    shouldShowStartupDetails(this: { options: { verbose?: boolean } }): boolean {
      return this.options.verbose === true || quietStartup === false;
    },
  };
}

function call(prototype: HostPrototype, method: string, verbose: boolean): RuntimeValue {
  const fn = reinterpretHostValue<(this: RuntimeValue) => RuntimeValue>(prototype[method]);
  return fn.call({ options: { verbose } });
}

test("the root package.json version is what the header reports", async () => {
  const manifest: RuntimeValue = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version = reinterpretHostValue<{ version: string }>(manifest).version;
  assert.equal(await readHarnessVersion(), version);
  assert.equal(
    await readHarnessVersion(new URL("./does-not-exist.json", import.meta.url)),
    undefined,
  );
});

test("Pi still decides startup visibility through the methods the policy patches", () => {
  const prototype = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(
    InteractiveMode.prototype,
  );
  assert.ok(isFunction(prototype["shouldShowStartupHeader"]));
  assert.ok(isFunction(prototype["shouldShowStartupDetails"]));
});

test("startup details show only with --verbose, even when quietStartup is false", () => {
  const prototype = hostPrototype(false);
  const policy = installStartupPolicy(prototype, {});
  assert.equal(call(prototype, "shouldShowStartupDetails", false), false);
  assert.equal(call(prototype, "shouldShowStartupDetails", true), true);
  assert.equal(policy.headerShown, undefined);
  assert.equal(call(prototype, "shouldShowStartupHeader", false), true);
  assert.equal(policy.headerShown, true);
});

test("quietStartup true keeps the header hidden and the policy records it", () => {
  const prototype = hostPrototype(true);
  const policy = installStartupPolicy(prototype, {});
  assert.equal(call(prototype, "shouldShowStartupHeader", false), false);
  assert.equal(policy.headerShown, false);
  assert.equal(call(prototype, "shouldShowStartupHeader", true), true);
  assert.equal(policy.headerShown, true);
});

test("installing twice in one process patches once and shares the policy", () => {
  const prototype = hostPrototype(false);
  const store: Record<PropertyKey, RuntimeValue> = {};
  const first = installStartupPolicy(prototype, store);
  const patched = prototype["shouldShowStartupHeader"];
  const second = installStartupPolicy(prototype, store);
  assert.equal(second, first);
  assert.equal(prototype["shouldShowStartupHeader"], patched);
  assert.equal(call(prototype, "shouldShowStartupHeader", false), true);
});

test("the header shows the logo, the title above both versions, key hints, and the description", () => {
  const header = new StartupHeader(plainTheme, "1.0.0-alpha.1", true);
  const lines = header.render(120);
  const text = lines.map((line) => stripTerminalSequences(line));
  const column = (row: number): string => (text[row] ?? "").slice(1 + LOGO_WIDTH + 1);
  assert.equal(column(0), "choco-pi");
  assert.match(
    column(1),
    new RegExp(`^v1\\.0\\.0-alpha\\.1 \\(pi v${VERSION.replaceAll(".", "\\.")}\\)$`),
  );
  assert.ok(text.some((line) => line.includes(CHOCO_PI_DESCRIPTION)));
  assert.ok(text.some((line) => line.includes("commands")));
  assert.ok(!text.some((line) => line.includes("Pi can explain its own features")));
  for (const line of text.slice(0, 4)) assert.match(line.slice(1, 1 + LOGO_WIDTH), /[▀▄█]/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 120);
});

test("the expanded header lists every hint and keeps the description", () => {
  const header = new StartupHeader(plainTheme, "1.0.0-alpha.1", true);
  const collapsed = header.render(120).length;
  header.setExpanded(true);
  const expanded = header.render(120).map((line) => stripTerminalSequences(line));
  assert.ok(expanded.length > collapsed);
  assert.ok(expanded.some((line) => line.includes("to select model")));
  assert.ok(expanded.some((line) => line.includes(CHOCO_PI_DESCRIPTION)));
});

test("without half-block support the header names choco-pi in text", () => {
  const text = new StartupHeader(plainTheme, undefined, false)
    .render(120)
    .map((line) => stripTerminalSequences(line));
  assert.equal(text[0]?.trim(), `choco-pi (pi v${VERSION})`);
  assert.ok(!text.join("\n").match(/[▀▄█]/));
});

const HALF_BLOCKS = /[▀▄█]/;

test("at every width each row fits, so Pi never re-wraps a row through the logo", () => {
  for (const expanded of [false, true]) {
    for (let width = 8; width <= 140; width += 1) {
      const header = new StartupHeader(plainTheme, "1.0.0-alpha.1", true);
      header.setExpanded(expanded);
      const lines = header.render(width);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
      const text = lines.map((line) => stripTerminalSequences(line));
      if (!logoFits(width)) {
        assert.ok(!text.some((line) => HALF_BLOCKS.test(line)), `width ${width} drops the logo`);
        continue;
      }
      for (const [row, line] of text.entries()) {
        const cell = line.slice(1, 1 + LOGO_WIDTH);
        if (row < 4) assert.match(cell, HALF_BLOCKS, `width ${width} row ${row}`);
        else assert.equal(cell.trim(), "", `width ${width} row ${row} keeps the text column`);
        assert.ok(line.length <= 1 + LOGO_WIDTH || line[1 + LOGO_WIDTH] === " ");
      }
    }
  }
});

test("a narrow header wraps hints between hints and keeps every word", () => {
  const header = new StartupHeader(plainTheme, "1.0.0-alpha.1", true);
  const text = header
    .render(60)
    .map((line) => stripTerminalSequences(line).slice(1 + LOGO_WIDTH + 1));
  const joined = text.join(" ").replaceAll(/\s+/g, " ");
  for (const hint of ["interrupt", "clear/exit", "commands", "bash", "more"]) {
    assert.ok(joined.includes(hint), hint);
  }
  assert.ok(joined.includes(CHOCO_PI_DESCRIPTION));
  for (const line of text) assert.doesNotMatch(line.trim(), /^·|·$/);
});
