import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { claimCodeModeHost, probeCodeModeHostOwner } from "@choco-pi/code-mode/host-slot";
import { reinterpretHostValue } from "@choco-pi/shared/runtime-values";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import codexExtension from "../src/index.ts";

const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-codex-provider-owner-"));
process.env["PI_CODING_AGENT_DIR"] = agentDir;
test.after(() => rm(agentDir, { recursive: true, force: true }));

test("Codex leaves Code Mode to an existing provider owner of the host slot", async () => {
  const eventBus = createEventBus();
  const bus = reinterpretHostValue<ExtensionAPI>({ events: eventBus });
  const existingOwner = { kind: "provider" as const, name: "other-provider" };
  const releaseExisting = claimCodeModeHost(bus, existingOwner);
  const extension = await loadExtensionFromFactory(
    codexExtension,
    process.cwd(),
    eventBus,
    createExtensionRuntime(),
    "codex-provider-owner",
  );
  const registered = [...extension.tools.keys()];
  for (const name of ["exec", "wait"])
    assert.equal(registered.includes(name), false, `Codex does not register ${name}`);
  assert.deepEqual(probeCodeModeHostOwner(bus), existingOwner);

  releaseExisting();
  assert.equal(probeCodeModeHostOwner(bus), undefined, "Codex never claimed the slot itself");
});
