import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  createReviewStore,
  resolveReviewDirectory,
  stopReviewRecordCleanup,
} from "../.pi/extensions/review/core/store.ts";
import {
  registerReviewExtension,
  type ReviewExtensionDependencies,
} from "../.pi/extensions/review/index.ts";

const REAL_AGENT = join(userInfo().homedir, ".pi", "agent");

test("a test cannot resolve or use a review directory in the real ~/.pi", async () => {
  assert.throws(() => resolveReviewDirectory(REAL_AGENT), /real review directory/);
  // A store given the real path refuses before touching the filesystem.
  const store = createReviewStore(join(REAL_AGENT, "choco-pi", "reviews"), undefined, {
    cleanup: false,
  });
  await assert.rejects(store.list("repo-key"), /real review directory/);
  // A scratch agent directory is fine.
  assert.equal(resolveReviewDirectory("/scratch/agent"), "/scratch/agent/choco-pi/reviews");
});

function registerWith(stopRecordCleanup?: () => void) {
  const handlers = new Map<string, (event: RuntimeValue, ctx: RuntimeValue) => void>();
  const api = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: (event: RuntimeValue, ctx: RuntimeValue) => void) =>
      handlers.set(event, handler),
    registerCommand: () => undefined,
    appendEntry: () => undefined,
  });
  const dependencies: ReviewExtensionDependencies = {
    store: { load: async () => undefined, save: async () => {}, list: async () => [] },
  };
  if (stopRecordCleanup) dependencies.stopRecordCleanup = stopRecordCleanup;
  registerReviewExtension(api, dependencies);
  return handlers;
}

test("session_shutdown stops the record clean-up, and a failing stop does not break shutdown", () => {
  let stops = 0;
  registerWith(() => {
    stops += 1;
  }).get("session_shutdown")?.({}, {});
  assert.equal(stops, 1);
  assert.doesNotThrow(() =>
    registerWith(() => {
      throw new Error("boom");
    }).get("session_shutdown")?.({}, {}),
  );
});

test("stopping when no pass was ever scheduled is a no-op that touches no directory", () => {
  // No store was used in this process, so no pass exists; stop must not resolve a directory.
  assert.doesNotThrow(() => stopReviewRecordCleanup());
  assert.doesNotThrow(() => registerWith().get("session_shutdown")?.({}, {}));
});
