import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import {
  installLiveSessionBridge,
  type LiveSessionBridgeDependencies,
} from "../.pi/extensions/session-bridge.ts";
import { isObject, isString, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { createSessionSdkFixture } from "./helpers/session-sdk-fixture.ts";

type ErrorRecord = { content: RuntimeValue; details: RuntimeValue };

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function runBridge(
  root: string,
  dependencies: LiveSessionBridgeDependencies,
  prepare: (mailbox: string) => Promise<void>,
): Promise<ErrorRecord[]> {
  const factory: ExtensionFactory = (pi) => installLiveSessionBridge(pi, dependencies);
  const fixture = await createSessionSdkFixture(root, [factory]);
  try {
    await prepare(dependencies.mailboxPath(fixture.session.sessionId));
    await fixture.session.bindExtensions({});
    const records = (): ErrorRecord[] =>
      fixture.session.sessionManager
        .getEntries()
        .flatMap((entry) =>
          entry.type === "custom_message" && entry.customType === "choco-pi:session-bridge-error"
            ? [{ content: entry.content, details: entry.details }]
            : [],
        );
    await waitFor(() => records().length > 0);
    return records();
  } finally {
    fixture.session.dispose();
  }
}

function dependenciesFor(
  root: string,
  mailboxRoot: string,
  watch?: LiveSessionBridgeDependencies["watchMailbox"],
): LiveSessionBridgeDependencies {
  return {
    mailboxPath: (sessionId) => join(mailboxRoot, sessionId),
    publishLiveState: async () => undefined,
    removeOwnedLiveState: async () => undefined,
    watchMailbox:
      watch ??
      (async (_directory, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }),
  };
}

test("malformed claimed JSON reports a claim-parse SyntaxError with allowlisted details", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-bridge-error-parse-"));
  try {
    const records = await runBridge(
      root,
      dependenciesFor(root, join(root, "mail")),
      async (mailbox) => {
        await mkdir(mailbox, { recursive: true });
        await writeFile(join(mailbox, "00000000000000000001-bad.json"), "{not json /secret/path");
      },
    );
    const [record] = records;
    assert.ok(record);
    assert.deepEqual(record.details, {
      stage: "claim-parse",
      errorName: "SyntaxError",
      code: null,
    });
    assert.ok(isString(record.content));
    assert.ok(record.content.startsWith("Session bridge delivery error: "));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mailbox directory read failure reports a drain stage with the error code", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-bridge-error-drain-"));
  let locked: string | undefined;
  try {
    const records = await runBridge(
      root,
      dependenciesFor(root, join(root, "mail")),
      async (mailbox) => {
        await mkdir(mailbox, { recursive: true });
        await chmod(mailbox, 0o000);
        locked = mailbox;
      },
    );
    const drain = records.find((record) => isStage(record.details, "drain"));
    assert.ok(drain);
    assert.deepEqual(drain.details, { stage: "drain", errorName: "Error", code: "EACCES" });
  } finally {
    if (locked) await chmod(locked, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

test("watcher failure reports a watch stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-bridge-error-watch-"));
  try {
    const records = await runBridge(
      root,
      dependenciesFor(root, join(root, "mail"), async () => {
        throw new TypeError("watcher exploded");
      }),
      async () => undefined,
    );
    const watch = records.find((record) => isStage(record.details, "watch"));
    assert.ok(watch);
    assert.deepEqual(watch.details, { stage: "watch", errorName: "TypeError", code: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function isStage(details: RuntimeValue, stage: string): boolean {
  return isRecord(details) && details.stage === stage;
}

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null;
}
