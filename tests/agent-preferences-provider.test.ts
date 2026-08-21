import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildAgentPreferencesSection,
  resolveAgentPreferencesArgs,
} from "../.pi/extensions/lib/agent-preferences-dialog.ts";
import { getPreferencesProvider } from "../.pi/extensions/lib/agent-preferences.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { realZentuiLoader, SKIP_WITHOUT_ZENTUI, ZENTUI_BUILD } from "./zentui-build.ts";

type Notice = [string, string];

function createCtx(notices: Notice[]): RuntimeValue {
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (message: string, level: string) => notices.push([message, level]),
      theme: { fg: (_color: string, value: string) => value, bold: (value: string) => value },
    },
  };
}

function withAgentDir(run: (agentDir: string, notices: Notice[]) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-preferences-provider-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "settings.json"),
      JSON.stringify({ theme: "nord-dark" }, null, 2),
    );
    try {
      await run(root, []);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "the Agent section reads and writes the global preferences",
  withAgentDir((agentDir) => {
    const notices: Notice[] = [];
    // SAFETY: the fixture supplies every host member the section touches.
    const section = buildAgentPreferencesSection(createCtx(notices) as never);
    assert.equal(section.id, "agent");

    const items = section.buildItems();
    assert.deepEqual(
      items.map((item) => item.id),
      ["agentLanguage", "agentStyle"],
    );
    assert.equal(items[0].currentValue, "Match user");
    assert.equal(items[1].currentValue, "Default");
    assert.ok(items[1].values?.includes("concise"), "shipped presets must be offered");

    assert.deepEqual(section.handleChange("agentLanguage", "Korean"), { kind: "update" });
    assert.deepEqual(section.handleChange("agentStyle", "concise"), { kind: "update" });
    const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.agentLanguage, "Korean");
    assert.equal(settings.agentStyle, "concise");
    assert.equal(settings.theme, "nord-dark", "unrelated settings must survive");

    assert.deepEqual(section.handleChange("agentLanguage", "Custom…"), {
      kind: "outcome",
      outcome: "agent:language-custom",
    });

    section.handleChange("agentLanguage", "Match user");
    section.handleChange("agentStyle", "Default");
    const cleared = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(cleared.agentLanguage, undefined);
    assert.equal(cleared.agentStyle, undefined);
  }),
);

test(
  "direct agent arguments write values and reject an unknown style",
  withAgentDir((agentDir) => {
    const notices: Notice[] = [];
    // SAFETY: the fixture supplies every host member the argument handler touches.
    const ctx = createCtx(notices) as never;

    assert.deepEqual(resolveAgentPreferencesArgs("agent", ctx), { open: true, section: "agent" });
    assert.deepEqual(resolveAgentPreferencesArgs("language", ctx), {
      open: true,
      section: "agent",
      focusId: "agentLanguage",
    });
    assert.equal(resolveAgentPreferencesArgs("editor enable", ctx), undefined);

    assert.deepEqual(resolveAgentPreferencesArgs("language Japanese", ctx), { open: false });
    assert.deepEqual(resolveAgentPreferencesArgs("style concise", ctx), { open: false });
    const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.agentLanguage, "Japanese");
    assert.equal(settings.agentStyle, "concise");

    assert.deepEqual(resolveAgentPreferencesArgs("style nope", ctx), { open: false });
    const unchanged = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    assert.equal(unchanged.agentStyle, "concise", "an unknown style must not be written");
    assert.equal(notices.at(-1)?.[1], "warning");
  }),
);

test(
  "choco-pi-ui publishes a provider the profile can consume",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    await realZentuiLoader();
    assert.ok(ZENTUI_BUILD);
    const module: Record<string, RuntimeValue> = await import(
      pathToFileURL(path.resolve(ZENTUI_BUILD, "settings-command.js")).href
    );
    // SAFETY: the compiled package exports this registration function.
    const register = module.registerZentuiPreferencesProvider as (deps: RuntimeValue) => void;
    assert.ok(register instanceof Function);

    register({
      sessionLifecycle: { defer: () => () => {} },
      getConfig: () => ({ components: { editor: {}, userMessages: {}, footer: {} } }),
      getActiveExtensionStatuses: () => new Map(),
      requestRender: () => {},
    });

    const provider = getPreferencesProvider();
    assert.ok(provider, "the profile must find the provider through the shared symbol");

    const notices: Notice[] = [];
    // SAFETY: the fixture supplies every host member the argument resolver touches.
    const ctx = createCtx(notices) as never;
    assert.deepEqual(await provider.resolveArgs("working-line", ctx), {
      open: true,
      section: "workingLine",
    });
    assert.deepEqual(await provider.resolveArgs("", ctx), { open: true });
    assert.equal(await provider.resolveArgs("not-a-known-argument", ctx), undefined);
    assert.equal(await provider.runOutcome("agent:language-custom", ctx), undefined);
  },
);

test(
  "the panel renders a host section and routes its changes",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    await realZentuiLoader();
    assert.ok(ZENTUI_BUILD);
    const module: Record<string, RuntimeValue> = await import(
      pathToFileURL(path.resolve(ZENTUI_BUILD, "settings-command.js")).href
    );
    // SAFETY: the compiled package exports this factory.
    const createPanel = module.createZentuiPreferencesComponent as (
      deps: RuntimeValue,
      options: RuntimeValue,
    ) => {
      render: (width: number) => string[];
      handleInput: (data: string) => void;
      getActiveSection: () => string;
      dispose: () => void;
    };

    const changes: [string, string][] = [];
    const outcomes: string[] = [];
    const notices: Notice[] = [];
    const panel = createPanel(
      {
        sessionLifecycle: { defer: () => () => {} },
        getConfig: () => ({
          colors: {},
          icons: { mode: "auto" },
          components: {
            selectorBorders: { enabled: true, style: "zentui", colorSource: "theme" },
          },
        }),
        getActiveExtensionStatuses: () => new Map(),
        requestRender: () => {},
        settingsListTheme: {
          label: (value: string) => value,
          value: (value: string) => value,
          description: (value: string) => value,
          cursor: ">",
          hint: (value: string) => value,
        },
      },
      {
        ctx: createCtx(notices),
        tui: { requestRender: () => {} },
        theme: {
          fg: (_color: string, value: string) => value,
          bold: (value: string) => value,
        },
        initialSection: "agent",
        extraSections: [
          {
            id: "agent",
            label: "Agent",
            buildItems: () => [
              {
                id: "agentLanguage",
                label: "Agent language",
                currentValue: "Match user",
                values: ["Match user", "Korean"],
              },
            ],
            handleChange: (id: string, newValue: string) => {
              changes.push([id, newValue]);
              return { kind: "update" };
            },
          },
        ],
        onOutcome: (outcome: string) => outcomes.push(outcome),
      },
    );

    try {
      assert.equal(panel.getActiveSection(), "agent");
      const rendered = panel.render(120).join("\n");
      assert.match(rendered, /Agent/, "the host section must appear in the section tabs");
      assert.match(rendered, /Agent language/, "the host section's rows must render");

      panel.handleInput("\r");
      assert.deepEqual(changes, [["agentLanguage", "Korean"]]);

      panel.handleInput("\t");
      assert.notEqual(panel.getActiveSection(), "agent", "Tab must still cycle sections");
    } finally {
      panel.dispose();
    }
  },
);
