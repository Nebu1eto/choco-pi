import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { loadEffectiveBackgroundSettings } from "../../choco-pi-compaction/src/background/settings.ts";
import {
  createCodexBackgroundIntegration,
  resolveCodexBackgroundSettings,
  type CodexBackgroundContext,
} from "../src/extension/background-compaction.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** An empty agent directory and an untrusted project, so no sidecar exists anywhere. */
async function location() {
  const root = await mkdtemp(join(tmpdir(), "codex-derived-defaults-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { agentDir, cwd, sidecar: join(agentDir, "extensions", "background-compaction.json") };
}

test("no sidecar anywhere: the Codex lane follows responsesCompaction, like the host", async () => {
  const { agentDir, cwd } = await location();
  const on = await resolveCodexBackgroundSettings({
    cwd,
    trusted: false,
    openaiServerSide: true,
    agentDir,
  });
  assert.deepEqual(on, { enabled: true, blockImages: false });
  const off = await resolveCodexBackgroundSettings({
    cwd,
    trusted: false,
    openaiServerSide: false,
    agentDir,
  });
  assert.deepEqual(off, { enabled: false, blockImages: false });
  // The host resolves the same lanes through the same seam.
  const host = await loadEffectiveBackgroundSettings(
    { cwd, agentDir, projectTrusted: false },
    { openaiServerSide: true, anthropicServerSide: false },
  );
  assert.equal(host.source, undefined);
  assert.equal(host.settings.codexNative, true);
});

test("an explicit sidecar wins over the derived default", async () => {
  const { agentDir, cwd, sidecar } = await location();
  await writeFile(sidecar, JSON.stringify({ enabled: true, codexNative: false }));
  assert.equal(
    (
      await resolveCodexBackgroundSettings({
        cwd,
        trusted: false,
        openaiServerSide: true,
        agentDir,
      })
    ).enabled,
    false,
  );
  await writeFile(sidecar, JSON.stringify({ enabled: true, codexNative: true }));
  assert.equal(
    (
      await resolveCodexBackgroundSettings({
        cwd,
        trusted: false,
        openaiServerSide: false,
        agentDir,
      })
    ).enabled,
    true,
  );
});

test("an invalid sidecar disables the lane with no Codex notice; the host owns the one diagnostic", async () => {
  const { agentDir, cwd, sidecar } = await location();
  await writeFile(sidecar, "{ not json");
  const resolved = await resolveCodexBackgroundSettings({
    cwd,
    trusted: false,
    openaiServerSide: true,
    agentDir,
  });
  assert.deepEqual(resolved, { enabled: false, blockImages: false });
  const host = await loadEffectiveBackgroundSettings(
    { cwd, agentDir, projectTrusted: false },
    { openaiServerSide: true, anthropicServerSide: false },
  );
  assert.match(host.diagnostic ?? "", /not valid JSON/);

  // Through the integration: repeated refreshes and generations show nothing from Codex.
  const notices: string[] = [];
  const manager = SessionManager.inMemory();
  const ctx: CodexBackgroundContext = {
    sessionManager: manager,
    model: undefined,
    modelRegistry: new ModelRegistry(
      await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null }),
    ),
    cwd,
    isProjectTrusted: () => false,
    ui: { notify: (message) => notices.push(message) },
  };
  const controller = createCodexBackgroundIntegration({
    state: {},
    onInstalled: () => {},
    resolveSettings: (projectCwd, trusted) =>
      resolveCodexBackgroundSettings({
        cwd: projectCwd,
        trusted,
        openaiServerSide: true,
        agentDir,
      }),
  });
  controller.begin(ctx);
  assert.equal(await controller.refresh(ctx), undefined);
  controller.begin(ctx);
  assert.equal(await controller.refresh(ctx), undefined);
  assert.deepEqual(notices, []);
  controller.stop();
});
