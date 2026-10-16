import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  checkoutRevision,
  PROFILE_PI_TARGET,
  ProfileMarkerSchema,
  profileMarkerPath,
  readProfileMarker,
  writeProfileMarker as publishProfileMarker,
  resolvePiLauncher,
} from "../.pi/extensions/lib/profile-marker.ts";
import {
  executeHarnessCheck,
  type HarnessCheckExecutionDependencies,
} from "../.pi/extensions/harness-check.ts";
import { installProfile } from "../scripts/install-profile.ts";

async function fakeLauncher(directory: string, version: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const launcher = path.join(directory, "pi");
  const source = path.join(directory, "launcher.ts");
  await writeFile(source, `#!${process.execPath}\nconsole.log(${JSON.stringify(version)});\n`, {
    mode: 0o755,
  });
  await rm(launcher, { force: true });
  await symlink(source, launcher);
  return launcher;
}

test("launcher selection prefers explicit override, then environment, then compatible PATH candidates", async () => {
  await fixture(async (directory) => {
    const compatible = await fakeLauncher(path.join(directory, "compatible"), PROFILE_PI_TARGET);
    const incompatible = await fakeLauncher(path.join(directory, "incompatible"), "0.87.1");
    const previousPath = process.env.PATH;
    const previousLauncher = process.env.CHOCO_PI_LAUNCHER;
    process.env.PATH = [path.dirname(incompatible), path.dirname(compatible)].join(path.delimiter);
    process.env.CHOCO_PI_LAUNCHER = incompatible;
    try {
      assert.deepEqual(await resolvePiLauncher(compatible), {
        launcher: compatible,
        version: PROFILE_PI_TARGET,
      });
      assert.deepEqual(await resolvePiLauncher(), { launcher: incompatible, version: "0.87.1" });
      delete process.env.CHOCO_PI_LAUNCHER;
      assert.deepEqual(await resolvePiLauncher(), {
        launcher: compatible,
        version: PROFILE_PI_TARGET,
      });
      process.env.PATH = path.dirname(incompatible);
      assert.deepEqual(await resolvePiLauncher(), { launcher: null, version: null });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLauncher === undefined) delete process.env.CHOCO_PI_LAUNCHER;
      else process.env.CHOCO_PI_LAUNCHER = previousLauncher;
    }
  });
});

test("installer records an explicitly selected launcher and harness rechecks it for version drift", async () => {
  await fixture(async (directory) => {
    const root = path.join(directory, "checkout");
    await mkdir(path.join(root, ".pi"), { recursive: true });
    await writeFile(path.join(root, ".pi", "settings.json"), JSON.stringify({ packages: [] }));
    const launcher = await fakeLauncher(path.join(directory, "launcher"), PROFILE_PI_TARGET);
    const agentDir = path.join(directory, "agent");
    const result = await installProfile({ root, agentDir, piLauncher: launcher });
    assert.deepEqual(result.warnings, []);
    const dependencies = harnessDependencies();
    dependencies.check = async () => ({
      status: "pass",
      configRoot: path.join(root, ".pi"),
      mode: "automatic",
      requiredCapabilities: [],
      checks: [],
    });
    dependencies.readProfileMarker = () => readProfileMarker(agentDir);
    const healthy = await executeHarnessCheck({ mode: "automatic" }, undefined, dependencies);
    assert.equal(healthy.status, "pass");
    assert.ok(healthy.checks.every((check) => check.status === "pass"));
    if (healthy.profileMarker?.status === "valid")
      assert.deepEqual(healthy.profileMarker.marker.pi, { launcher, version: PROFILE_PI_TARGET });
    await fakeLauncher(path.dirname(launcher), "0.87.1");
    const stale = await executeHarnessCheck({ mode: "automatic" }, undefined, dependencies);
    assert.equal(stale.status, "warn");
    assert.match(
      stale.checks.find((check) => check.id === "profile-launcher")?.detail ?? "",
      /0\.87\.1/,
    );
    const incompatible = await installProfile({ root, agentDir, piLauncher: launcher });
    assert.equal(incompatible.warnings.length, 1);
  });
});

function writeProfileMarker(agentDir: string, checkout: string, version: string) {
  return publishProfileMarker(agentDir, checkout, { version, launcher: null });
}

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(process.cwd(), ".profile-marker-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("marker uses schema 1, private modes and atomic replacement without changing its directory", async () => {
  await fixture(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const target = await writeProfileMarker(agentDir, directory, VERSION);
    assert.equal(target, path.join(agentDir, "choco-pi", "profile.json"));
    const contents = await readFile(target, "utf8");
    const parsed: unknown = JSON.parse(contents);
    assert.ok(Value.Check(ProfileMarkerSchema, parsed));
    assert.deepEqual(parsed, {
      schema: 1,
      name: "choco-pi",
      checkout: directory,
      revision: await checkoutRevision(directory),
      installedAt: parsed.installedAt,
      pi: { version: VERSION, launcher: null },
      hostBridge: {
        schema: 1,
        entryPrefix: "choco-pi:host-bridge",
        statusKey: "choco-pi.host-bridge",
        reportStatusKey: "choco-pi.report",
      },
    });
    assert.ok(Number.isFinite(Date.parse(parsed.installedAt)));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const before = await stat(path.dirname(target));
    assert.equal(before.mode & 0o777, 0o700);
    const oldFile = await open(target, "r");
    try {
      await writeProfileMarker(agentDir, process.cwd(), VERSION);
      assert.equal(await oldFile.readFile("utf8"), contents, "open readers retain the old inode");
      assert.notEqual((await stat(target)).ino, (await oldFile.stat()).ino);
    } finally {
      await oldFile.close();
    }
    const after = await stat(path.dirname(target));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o700);
    await chmod(path.dirname(target), 0o755);
    await writeProfileMarker(agentDir, directory, VERSION);
    assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(path.dirname(target)), ["profile.json"]);
    const observation = await readProfileMarker(agentDir);
    assert.equal(observation.status, "valid");
    if (observation.status === "valid")
      assert.match(observation.marker.revision ?? "", /^[a-f0-9]{7,64}$/);
  });
});

test("revision lookup is asynchronous and returns null when git fails", async () => {
  await fixture(async (directory) => {
    assert.equal(await checkoutRevision(path.join(directory, "missing")), null);
    assert.match((await checkoutRevision(process.cwd())) ?? "", /^[a-f0-9]{7,64}$/);
  });
});

test("marker records null when git is unavailable and cleans temporary files on rename failure", async () => {
  await fixture(async (directory) => {
    const previous = process.env.PATH;
    process.env.PATH = directory;
    try {
      await writeProfileMarker(directory, directory, VERSION);
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
    const observation = await readProfileMarker(directory);
    assert.equal(observation.status, "valid");
    if (observation.status === "valid") assert.equal(observation.marker.revision, null);
    const target = profileMarkerPath(directory);
    await rm(target);
    await mkdir(target);
    await assert.rejects(writeProfileMarker(directory, directory, VERSION));
    assert.deepEqual(await readdir(path.dirname(target)), ["profile.json"]);
  });
});

test("marker reports missing, malformed, unsupported and stale checkout states", async () => {
  await fixture(async (directory) => {
    assert.equal((await readProfileMarker(directory)).status, "missing");
    const target = await writeProfileMarker(directory, directory, VERSION);
    const valid: unknown = JSON.parse(await readFile(target, "utf8"));
    assert.ok(Value.Check(ProfileMarkerSchema, valid));
    for (const invalid of [
      "{",
      JSON.stringify({ ...valid, schema: 2 }),
      JSON.stringify({ ...valid, checkout: "relative" }),
      JSON.stringify({ ...valid, checkout: path.join(directory, "gone") }),
      JSON.stringify({ ...valid, installedAt: "not a date" }),
    ]) {
      await writeFile(target, invalid);
      assert.equal((await readProfileMarker(directory)).status, "invalid");
    }
    await rm(target);
    await mkdir(target);
    assert.equal((await readProfileMarker(directory)).status, "unreadable");
  });
});

test("installer publishes the marker only after success and respects the selected agent dir", async () => {
  await fixture(async (directory) => {
    const root = path.join(directory, "checkout");
    const agentDir = path.join(directory, "custom-agent");
    await mkdir(path.join(root, ".pi"), { recursive: true });
    await writeFile(path.join(root, ".pi", "settings.json"), JSON.stringify({ packages: [] }));
    const result = await installProfile({ root, agentDir });
    assert.equal(result.markerPath, profileMarkerPath(agentDir));
    const marker = await readProfileMarker(agentDir);
    assert.equal(marker.status, "valid");
    if (marker.status === "valid") assert.equal(marker.marker.checkout, root);
    const before = await readFile(result.markerPath, "utf8");
    await writeFile(path.join(root, ".pi", "settings.json"), "invalid");
    await assert.rejects(installProfile({ root, agentDir }), /valid JSON/);
    assert.equal(await readFile(result.markerPath, "utf8"), before);
    const freshAgent = path.join(directory, "failed-agent");
    await assert.rejects(installProfile({ root, agentDir: freshAgent }), /valid JSON/);
    assert.equal((await readProfileMarker(freshAgent)).status, "missing");
  });
});

test("marker path honors PI_CODING_AGENT_DIR", async () => {
  await fixture(async (directory) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      assert.equal(profileMarkerPath(), path.join(directory, "choco-pi", "profile.json"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

function harnessDependencies(): HarnessCheckExecutionDependencies {
  const owner = { sessionId: "marker-test", generation: 1 };
  return {
    capture: () => ({
      owner,
      nodeVersion: process.version,
      runtime: {
        source: "active-host",
        version: VERSION,
        path: process.cwd(),
        authoritative: true,
      },
    }),
    currentOwner: () => owner,
    check: async () => ({
      status: "pass",
      mode: "automatic",
      requiredCapabilities: [],
      checks: [],
      configRoot: process.cwd(),
    }),
  };
}

test("harness report warns on missing markers, checkout mismatch and unavailable launchers", async () => {
  await fixture(async (directory) => {
    const dependencies = harnessDependencies();
    dependencies.readProfileMarker = () => readProfileMarker(directory);
    const missing = await executeHarnessCheck({ mode: "automatic" }, undefined, dependencies);
    assert.equal(missing.status, "warn");
    assert.equal(missing.profileMarker?.status, "missing");
    await writeProfileMarker(directory, directory, VERSION);
    const present = await executeHarnessCheck({ mode: "automatic" }, undefined, dependencies);
    assert.equal(present.profileMarker?.status, "valid");
    assert.equal(present.status, "warn");
    assert.ok(
      present.checks.some((check) => check.id === "profile-marker" && check.status === "warn"),
    );
    assert.ok(
      present.checks.some((check) => check.id === "profile-launcher" && check.status === "warn"),
    );
  });
});

test("harness rejects a session change during marker reading", async () => {
  const dependencies = harnessDependencies();
  dependencies.readProfileMarker = async () => {
    dependencies.currentOwner = () => ({ sessionId: "new-session", generation: 2 });
    return { path: "/unused", status: "missing", reason: "absent" };
  };
  await assert.rejects(
    executeHarnessCheck({ mode: "automatic" }, undefined, dependencies),
    /stale/,
  );
});

test("harness rejects cancellation during marker reading", async () => {
  const dependencies = harnessDependencies();
  const controller = new AbortController();
  dependencies.readProfileMarker = async () => {
    controller.abort();
    return { path: "/unused", status: "missing", reason: "absent" };
  };
  await assert.rejects(
    executeHarnessCheck({ mode: "automatic" }, controller.signal, dependencies),
    /cancelled/,
  );
});
