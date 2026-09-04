import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectZedSettingsPath,
  parseZedSettings,
  parseZedTasks,
  runZedSetupCli,
} from "../src/zed/setup.ts";

const commandPath = "/fixture/node";
const adapterPath = "/fixture/node_modules/choco-pi-acp/bin/choco-pi-acp.ts";
const contextCliPath = "/fixture/node_modules/choco-pi-editor-context/src/cli.ts";

interface Fixture {
  directory: string;
  settingsPath: string;
  tasksPath: string;
}

async function fixture(
  t: test.TestContext,
  settingsSource: string,
  tasksSource = "[]\n",
): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "choco-pi-zed-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const settingsPath = join(directory, "settings.json");
  const tasksPath = join(directory, "tasks.json");
  await Promise.all([writeFile(settingsPath, settingsSource), writeFile(tasksPath, tasksSource)]);
  return { directory, settingsPath, tasksPath };
}

async function run(
  current: Fixture,
  argv: readonly string[],
): Promise<{ code: number; output: string[] }> {
  const output: string[] = [];
  const code = await runZedSetupCli(argv, {
    adapterPath,
    commandPath,
    environment: {},
    output: (line) => output.push(line),
    settingsPath: current.settingsPath,
    tasksPath: current.tasksPath,
  });
  return { code, output };
}

async function expectedTasks() {
  const example = parseZedTasks(
    await readFile(new URL("../../../../editors/zed/tasks.example.json", import.meta.url), "utf8"),
  );
  return example.map((task) => ({
    ...task,
    command: task.command === "node" ? commandPath : task.command,
    args: Array.isArray(task.args)
      ? task.args.map((argument, index) =>
          index === 0 && argument === ".pi/packages/choco-pi-editor-context/src/cli.ts"
            ? contextCliPath
            : argument,
        )
      : task.args,
  }));
}

test("Zed settings path uses ~/.config/zed on macOS", () => {
  assert.equal(
    detectZedSettingsPath({ homeDirectory: "/home/example", platform: "darwin" }),
    "/home/example/.config/zed/settings.json",
  );
});

test("setup defaults tasks.json beside settings.json", async (t) => {
  const current = await fixture(t, "{}\n");
  const output: string[] = [];
  assert.equal(
    await runZedSetupCli(["setup", "--dry-run"], {
      adapterPath,
      commandPath,
      environment: {},
      output: (line) => output.push(line),
      settingsPath: current.settingsPath,
    }),
    0,
  );
  assert.match(output.join("\n"), new RegExp(`Zed tasks: ${current.tasksPath}`));
});

test("setup dry-run reports both edits without writing", async (t) => {
  const settingsOriginal = '{\n  // keep this comment\n  "theme": "Ayu",\n}\n';
  const tasksOriginal = '[\n  // keep this task\n  { "label": "Other", "command": "other" },\n]\n';
  const current = await fixture(t, settingsOriginal, tasksOriginal);
  const result = await run(current, ["setup", "--dry-run"]);
  assert.equal(result.code, 0);
  const output = result.output.join("\n");
  assert.match(output, /Dry run: no files written/);
  assert.match(output, /Intended settings/);
  assert.match(output, /Intended tasks/);
  assert.match(output, /Choco Pi: Sync Focused Context/);
  assert.equal(await readFile(current.settingsPath, "utf8"), settingsOriginal);
  assert.equal(await readFile(current.tasksPath, "utf8"), tasksOriginal);
});

test("setup apply writes exact tasks, preserves unrelated data, and backs up both", async (t) => {
  const settingsOriginal =
    '{\n  // user preference\n  "theme": "Ayu",\n  "agent_servers": {\n    "other": { "command": "other" },\n  },\n}\n';
  const tasksOriginal =
    '[\n  // unrelated task remains\n  { "label": "Other", "command": "other", "args": [] },\n]\n';
  const current = await fixture(t, settingsOriginal, tasksOriginal);
  assert.equal((await run(current, ["setup", "--apply"])).code, 0);
  assert.equal(await readFile(`${current.settingsPath}.bak`, "utf8"), settingsOriginal);
  assert.equal(await readFile(`${current.tasksPath}.bak`, "utf8"), tasksOriginal);

  const updatedSource = await readFile(current.settingsPath, "utf8");
  assert.match(updatedSource, /\/\/ user preference/);
  assert.deepEqual(parseZedSettings(updatedSource), {
    theme: "Ayu",
    agent_servers: {
      other: { command: "other" },
      "choco-pi": {
        type: "custom",
        command: commandPath,
        args: [adapterPath],
        env: { PI_ACP_ENABLE_EMBEDDED_CONTEXT: "true" },
      },
    },
  });
  assert.deepEqual(parseZedTasks(await readFile(current.tasksPath, "utf8")), [
    { label: "Other", command: "other", args: [] },
    ...(await expectedTasks()),
  ]);
  const installedTasks = parseZedTasks(await readFile(current.tasksPath, "utf8"));
  const focusedTasks = installedTasks.filter((task) =>
    ["Choco Pi: Sync Focused Context", "Choco Pi: Sync Focused Context (No Selection)"].includes(
      String(task.label),
    ),
  );
  assert.equal(focusedTasks.length, 2);
  for (const task of focusedTasks) {
    const args = task.args;
    assert.ok(Array.isArray(args));
    assert.equal(args.includes("--zero-based-position"), false);
    assert.deepEqual(args.slice(args.indexOf("--line"), args.indexOf("--language")), [
      "--line",
      "$ZED_ROW",
      "--column",
      "$ZED_COLUMN",
    ]);
  }
  const selectTask = installedTasks.find(
    (task) => task.label === "Choco Pi: Select Context Target",
  );
  assert.match(String(selectTask?.description), /List Live Sessions/);
  assert.match(String(selectTask?.description), /printed select command/);
  assert.match(String(selectTask?.description), /Zed's terminal/);
});

test("task conflict refusal leaves both files unchanged and replace is scoped", async (t) => {
  const settingsOriginal = '{"theme":"Ayu"}\n';
  const tasksOriginal = `${JSON.stringify(
    [
      { label: "Other", command: "keep" },
      { label: "Choco Pi: Sync Focused Context", command: "wrong" },
    ],
    null,
    2,
  )}\n`;
  const current = await fixture(t, settingsOriginal, tasksOriginal);
  const conflict = await run(current, ["setup", "--apply"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.output.join("\n"), /Refusing to replace/);
  assert.equal(await readFile(current.settingsPath, "utf8"), settingsOriginal);
  assert.equal(await readFile(current.tasksPath, "utf8"), tasksOriginal);

  assert.equal((await run(current, ["setup", "--apply", "--replace"])).code, 0);
  assert.deepEqual(parseZedTasks(await readFile(current.tasksPath, "utf8")), [
    { label: "Other", command: "keep" },
    ...(await expectedTasks()),
  ]);
});

test("agent conflict refusal also leaves tasks unchanged", async (t) => {
  const settingsOriginal = '{"agent_servers":{"choco-pi":{"command":"wrong"}},"theme":"Ayu"}\n';
  const tasksOriginal = "[]\n";
  const current = await fixture(t, settingsOriginal, tasksOriginal);
  assert.equal((await run(current, ["setup", "--apply"])).code, 1);
  assert.equal(await readFile(current.settingsPath, "utf8"), settingsOriginal);
  assert.equal(await readFile(current.tasksPath, "utf8"), tasksOriginal);
});

test("remove deletes only choco definitions and backs up changed files", async (t) => {
  const current = await fixture(t, "{}\n", '[{"label":"Other","command":"keep"}]\n');
  assert.equal((await run(current, ["setup", "--apply"])).code, 0);
  const configuredSettings = await readFile(current.settingsPath, "utf8");
  const configuredTasks = await readFile(current.tasksPath, "utf8");

  assert.equal((await run(current, ["remove", "--dry-run"])).code, 0);
  assert.equal(await readFile(current.settingsPath, "utf8"), configuredSettings);
  assert.equal(await readFile(current.tasksPath, "utf8"), configuredTasks);
  assert.equal((await run(current, ["remove", "--apply"])).code, 0);
  assert.equal(await readFile(`${current.settingsPath}.bak`, "utf8"), configuredSettings);
  assert.equal(await readFile(`${current.tasksPath}.bak`, "utf8"), configuredTasks);
  assert.deepEqual(parseZedTasks(await readFile(current.tasksPath, "utf8")), [
    { label: "Other", command: "keep" },
  ]);
});

test("doctor checks both settings and tasks", async (t) => {
  const current = await fixture(t, "{}\n");
  const missing = await run(current, ["doctor"]);
  assert.equal(missing.code, 1);
  assert.match(missing.output.join("\n"), /Settings status: Status: setup required/);
  assert.match(missing.output.join("\n"), /Tasks status: Status: setup required/);

  await run(current, ["setup", "--apply"]);
  const configured = await run(current, ["doctor"]);
  assert.equal(configured.code, 0);
  assert.match(configured.output.join("\n"), /Status: configured/);

  await writeFile(
    current.tasksPath,
    '[{"label":"Choco Pi: List Live Sessions","command":"wrong"}]\n',
  );
  const conflict = await run(current, ["doctor"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.output.join("\n"), /Tasks status: Status: conflicting/);
});

test("setup reports local and remote execution without exposing environment values", async (t) => {
  const current = await fixture(t, "{}\n");
  const localOutput: string[] = [];
  await runZedSetupCli(["setup", "--dry-run"], {
    adapterPath,
    commandPath,
    environment: {},
    output: (line) => localOutput.push(line),
    settingsPath: current.settingsPath,
    tasksPath: current.tasksPath,
  });
  assert.match(localOutput.join("\n"), /Project execution: local/);

  const remoteOutput: string[] = [];
  await runZedSetupCli(["setup", "--dry-run"], {
    adapterPath,
    commandPath,
    environment: { SSH_CONNECTION: "sensitive-host-details" },
    output: (line) => remoteOutput.push(line),
    settingsPath: current.settingsPath,
    tasksPath: current.tasksPath,
  });
  assert.match(remoteOutput.join("\n"), /Project execution: remote/);
  assert.doesNotMatch(remoteOutput.join("\n"), /sensitive-host-details/);
});
