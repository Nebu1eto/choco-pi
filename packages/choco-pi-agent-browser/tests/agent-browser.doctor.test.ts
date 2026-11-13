import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkAgentBrowserVersion,
  checkSources,
  isDirectRun,
  parseCliArgs,
} from "../scripts/doctor.ts";

test("browser doctor warns rather than fails on future versions", async () => {
  const check = await checkAgentBrowserVersion({
    runAgentBrowser: async () => "agent-browser 1.0.0",
  });
  assert.equal(check.status, "warn");
});

test("doctor direct-run comparison supports decoded paths and symlinks", async () => {
  const resolved: string[] = [];
  const result = await isDirectRun("file:///tmp/a%20b/doctor.ts", "/tmp/link", async (path) => {
    resolved.push(path);
    return "/tmp/a b/doctor.ts";
  });
  assert.equal(result, true);
  assert.deepEqual(resolved, ["/tmp/link", "/tmp/a b/doctor.ts"]);
});

test("doctor CLI retains repeatable settings inputs", () => {
  assert.deepEqual(
    parseCliArgs(["--settings", "a", "--settings", "b"]).settingsPaths.map(
      (path) => path.endsWith("/a") || path.endsWith("/b"),
    ),
    [true, true],
  );
});

test("doctor detects two registrations in one settings file and ignores comments", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-doctor-"));
  try {
    const settings = join(root, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        extensions: ["./extensions/agent-browser/index.ts"],
        packages: ["npm:pi-agent-browser-native"],
        note: "choco-pi-agent-browser text is not a registration",
      }),
    );
    const check = await checkSources({
      agentDir: join(root, "agent"),
      cwd: root,
      settingsPaths: [settings],
      showHelp: false,
      skipSourceCheck: false,
    });
    assert.equal(check.status, "fail");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("doctor detects repo-local extension autoload", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-doctor-autoload-"));
  try {
    const extension = join(root, ".pi/extensions/agent-browser");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export {};\n");
    const check = await checkSources({
      agentDir: join(root, "agent"),
      cwd: root,
      settingsPaths: [],
      showHelp: false,
      skipSourceCheck: false,
    });
    assert.equal(check.status, "pass");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
