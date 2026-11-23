import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CONFIG_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/config.ts");
const PROJECT_CONFIG_SEGMENTS = [".pi", "config", "pi-agent-browser-native", "config.json"];

interface CliRun {
  code: number;
  stderr: string;
  stdout: string;
}

let workspace = "";

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agent-browser-config-cli-"));
});

after(async () => {
  await rm(workspace, { force: true, recursive: true });
});

function runConfig(args: string[], stdin?: string): Promise<CliRun> {
  return new Promise((resolveRun) => {
    const child = execFile(
      process.execPath,
      [CONFIG_SCRIPT, ...args],
      {
        cwd: workspace,
        env: {
          CHOCO_PI_HOME: join(workspace, "home", ".choco-pi"),
          HOME: join(workspace, "home"),
          PATH: process.env.PATH ?? "",
        },
      },
      (error, stdout, stderr) => {
        const code =
          error && "code" in error && Number.isInteger(error.code) ? Number(error.code) : 0;
        resolveRun({ code: error ? code || 1 : 0, stderr, stdout });
      },
    );
    child.stdin?.end(stdin ?? "");
  });
}

function projectConfigPath(): string {
  return join(workspace, ...PROJECT_CONFIG_SEGMENTS);
}

async function readProjectConfig(): Promise<string> {
  return readFile(projectConfigPath(), "utf8");
}

test("config CLI prints source-run help", async () => {
  const run = await runConfig(["--help"]);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /node scripts\/config\.ts web-search set-key --stdin/);
  assert.doesNotMatch(run.stdout, /npm exec/);
});

test("config CLI rejects unknown options with usage exit code 2", async () => {
  const run = await runConfig(["paths", "--bogus"]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Unknown option: --bogus/);
});

test("config CLI mutates project config while preserving unknown keys", async () => {
  await mkdir(dirname(projectConfigPath()), { recursive: true });
  await writeFile(projectConfigPath(), JSON.stringify({ custom: { kept: true } }));

  const setEnv = await runConfig(["web-search", "set-env", "EXA_API_KEY", "--project"]);
  assert.equal(setEnv.code, 0, setEnv.stderr);
  const setKey = await runConfig(
    ["web-search", "set-key", "--stdin", "--provider", "brave", "--project"],
    "secret-value\n",
  );
  assert.equal(setKey.code, 0, setKey.stderr);
  assert.doesNotMatch(setKey.stdout, /secret-value/);
  const prefer = await runConfig(["web-search", "prefer", "brave", "--project"]);
  assert.equal(prefer.code, 0, prefer.stderr);
  const profile = await runConfig([
    "browser",
    "profile",
    "set",
    "Work",
    "--policy",
    "always",
    "--project",
  ]);
  assert.equal(profile.code, 0, profile.stderr);

  assert.deepEqual(JSON.parse(await readProjectConfig()), {
    version: 1,
    custom: { kept: true },
    webSearch: {
      exaApiKey: "$EXA_API_KEY",
      braveApiKey: "secret-value",
      preferredProvider: "brave",
    },
    browser: { defaultProfile: { name: "Work", policy: "always" } },
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(projectConfigPath())).mode & 0o777, 0o600);
  }

  const show = await runConfig(["show"]);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /project: .*config\.json \[exists\]/);
  assert.doesNotMatch(show.stdout, /secret-value/);

  const clear = await runConfig(["web-search", "clear", "--provider", "all", "--project"]);
  assert.equal(clear.code, 0, clear.stderr);
  const auto = await runConfig(["web-search", "prefer", "auto", "--project"]);
  assert.equal(auto.code, 0, auto.stderr);
  const clearProfile = await runConfig(["browser", "profile", "clear", "--project"]);
  assert.equal(clearProfile.code, 0, clearProfile.stderr);
  assert.deepEqual(JSON.parse(await readProjectConfig()), {
    version: 1,
    custom: { kept: true },
    webSearch: {},
    browser: {},
  });
});

test("config CLI validates provider and policy arguments", async () => {
  const provider = await runConfig(["web-search", "set-command", "pass", "--provider", "nope"]);
  assert.equal(provider.code, 2);
  assert.match(provider.stderr, /--provider must be one of exa, brave\./);
  const policy = await runConfig(["browser", "profile", "set", "Work", "--policy", "sometimes"]);
  assert.equal(policy.code, 2);
  assert.match(policy.stderr, /Invalid --policy value\./);
});
