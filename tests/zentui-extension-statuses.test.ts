import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";

type Placement = "off" | "left" | "middle" | "right";

type ConfigModule = {
  mergeConfig: (parsed: RuntimeValue) => RuntimeValue;
  getExtensionStatusPlacement: (config: RuntimeValue, key: string) => Placement;
  saveExtensionStatusPlacement: (key: string, placement: Placement, file: string) => RuntimeValue;
  clearExtensionStatusPlacement: (key: string, file: string) => RuntimeValue;
};

type Segment = { key: string; text: string; placement: Placement };

type SegmentsByPlacement = { left: Segment[]; middle: Segment[]; right: Segment[] };

type ExtensionStatusModule = {
  collectExtensionStatusSegments: (
    statuses: ReadonlyMap<string, string>,
    config: RuntimeValue,
  ) => SegmentsByPlacement;
};

async function configModule(): Promise<ConfigModule> {
  return reinterpretHostValue<ConfigModule>(await loadZentuiModule("config.js"));
}

/** The two footer statuses the profile ships a switch for. */
const footerStatuses = new Map([
  ["mcp", "MCP: connecting to linear..."],
  ["subagents", "3 running agents"],
]);

type SavedConfig = {
  components?: {
    footer?: { styles?: { starship?: { extensionStatuses?: { placements?: RuntimeValue } } } };
  };
};

/** The placement overrides as they were written to disk. */
function placementsOf(file: string): RuntimeValue {
  const parsed: RuntimeValue = JSON.parse(readFileSync(file, "utf8"));
  const saved = reinterpretHostValue<SavedConfig>(parsed);
  return saved.components?.footer?.styles?.starship?.extensionStatuses?.placements;
}

test(
  "an off placement drops that status from the footer",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { mergeConfig, getExtensionStatusPlacement } = await configModule();
    const { collectExtensionStatusSegments } = reinterpretHostValue<ExtensionStatusModule>(
      await loadZentuiModule("extension-status.js"),
    );

    const config = mergeConfig({
      components: {
        footer: {
          styles: {
            starship: {
              extensionStatuses: {
                defaultPlacement: "right",
                placements: { mcp: "off", subagents: "off" },
              },
            },
          },
        },
      },
    });

    assert.equal(getExtensionStatusPlacement(config, "mcp"), "off");
    assert.equal(getExtensionStatusPlacement(config, "subagents"), "off");
    assert.equal(
      getExtensionStatusPlacement(config, "choco-pi-lsp"),
      "right",
      "a status without an override keeps the default placement",
    );

    const segments = collectExtensionStatusSegments(
      new Map([...footerStatuses, ["choco-pi-lsp", "LSP Active"]]),
      config,
    );
    assert.deepEqual(
      segments.right.map((segment) => segment.key),
      ["choco-pi-lsp"],
      "only the statuses left on are rendered",
    );
    assert.deepEqual(segments.left, []);
    assert.deepEqual(segments.middle, []);
  },
);

test(
  "switching a status off and on again leaves no override behind",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const {
      getExtensionStatusPlacement,
      saveExtensionStatusPlacement,
      clearExtensionStatusPlacement,
    } = await configModule();
    const directory = mkdtempSync(path.join(tmpdir(), "choco-pi-ui-statuses-"));
    const file = path.join(directory, "choco-pi-ui.json");
    try {
      const off = saveExtensionStatusPlacement("subagents", "off", file);
      assert.equal(getExtensionStatusPlacement(off, "subagents"), "off");
      assert.deepEqual(placementsOf(file), { subagents: "off" });

      const on = clearExtensionStatusPlacement("subagents", file);
      assert.equal(
        getExtensionStatusPlacement(on, "subagents"),
        "right",
        "the status follows the default placement again",
      );
      assert.deepEqual(
        placementsOf(file),
        {},
        "the override is gone from the file, not just from the loaded config",
      );

      const moved = saveExtensionStatusPlacement("mcp", "left", file);
      assert.equal(getExtensionStatusPlacement(moved, "mcp"), "left");
      saveExtensionStatusPlacement("subagents", "off", file);
      clearExtensionStatusPlacement("subagents", file);
      assert.deepEqual(
        placementsOf(file),
        { mcp: "left" },
        "clearing one status leaves every other override untouched",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
