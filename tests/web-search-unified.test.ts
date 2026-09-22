import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runFixture(
  fixture: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function fixtureConfig(mode: "default" | "allowed") {
  const config = {
    searchRouting: {
      providers: ["openai", "exa"],
      fallbackOn: ["transient", "network", "invalid-response"],
    },
    openaiSearchProviders: ["openai"],
  };
  if (mode === "default") return config;
  return { ...config, allowBilledApiFallback: true };
}

test("unified web search works through real SDK extension wrappers", async () => {
  const fixture = path.resolve("tests/fixtures/web-search-integration.ts");
  for (const mode of ["default", "allowed"] as const) {
    const isolatedHome = await mkdtemp(path.join(tmpdir(), `choco-pi-web-search-${mode}-`));
    try {
      const config = fixtureConfig(mode);
      await writeFile(path.join(isolatedHome, "web-search.json"), JSON.stringify(config), "utf8");
      const environment: NodeJS.ProcessEnv = {
        HOME: isolatedHome,
        PI_CODING_AGENT_DIR: isolatedHome,
        XDG_CONFIG_HOME: path.join(isolatedHome, "xdg"),
        OPENAI_API_KEY: "integration-openai-key",
        EXA_API_KEY: "integration-exa-key",
        BRAVE_API_KEY: "integration-brave-key",
        SYNTHETIC_API_KEY: "integration-conversation-key",
        WEB_SEARCH_FIXTURE_MODE: mode,
      };
      if (process.env.PATH !== undefined) environment.PATH = process.env.PATH;
      const result = await runFixture(fixture, environment, isolatedHome);
      assert.equal(
        result.code,
        0,
        `${mode} fixture failed with ${result.signal ?? "no signal"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /web-search integration fixture passed/);
      assert.doesNotMatch(result.stdout + result.stderr, /integration-(?:openai|conversation)-key/);
    } finally {
      await rm(isolatedHome, { recursive: true, force: true });
    }
  }
});
