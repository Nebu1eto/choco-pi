import { randomUUID } from "node:crypto";
import { mkdir, watch } from "node:fs/promises";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_VERSION,
  HEARTBEAT_INTERVAL_MS,
  publishLiveState,
  removeOwnedLiveState,
  type LiveSessionState,
} from "../../../../packages/choco-pi-editor-context/src/live-session-client.ts";
import type { RuntimeValue } from "../runtime-values.ts";
import { onStopReopen } from "../stop-control.ts";
import { createMailboxController } from "./mailbox.ts";
import {
  errorMessage,
  MAILBOX_FALLBACK_INTERVAL_MS,
  mailboxPath,
  type Lifecycle,
  type LiveSessionBridgeDependencies,
} from "./types.ts";

const liveSessionBridgeDefaults: LiveSessionBridgeDependencies = {
  mailboxPath,
  publishLiveState,
  removeOwnedLiveState,
  watchMailbox: async (directory, signal, onJsonFile) => {
    for await (const event of watch(directory, { persistent: false, signal })) {
      if (event.filename?.endsWith(".json")) onJsonFile();
    }
  },
};

export function installLiveSessionBridge(
  pi: ExtensionAPI,
  dependencies: LiveSessionBridgeDependencies = liveSessionBridgeDefaults,
): void {
  const ownerId = randomUUID();
  let generation = 0;
  let current: Lifecycle | undefined;
  let publicationTail = Promise.resolve();

  const serializePublication = (operation: () => Promise<void>): Promise<void> => {
    const result = publicationTail.then(operation);
    publicationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const isCurrent = (lifecycle: Lifecycle): boolean =>
    current === lifecycle &&
    lifecycle.generation === generation &&
    !lifecycle.abortController.signal.aborted;

  const mailbox = createMailboxController(pi, ownerId, dependencies, isCurrent);

  const publish = async (lifecycle: Lifecycle, status?: "busy" | "idle") => {
    if (!isCurrent(lifecycle)) return;
    if (status) lifecycle.desiredStatus = status;
    const publication = serializePublication(async () => {
      if (!isCurrent(lifecycle)) return;
      const sessionFile = lifecycle.ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;
      const state: LiveSessionState = {
        version: BRIDGE_VERSION,
        sessionId: lifecycle.sessionId,
        sessionFile,
        cwd: lifecycle.cwd,
        pid: process.pid,
        ownerId,
        status: lifecycle.desiredStatus,
        model: lifecycle.ctx.model
          ? `${lifecycle.ctx.model.provider}/${lifecycle.ctx.model.id}`
          : undefined,
        effort: lifecycle.ctx.thinkingLevel,
        updatedAt: new Date().toISOString(),
      };
      if (!isCurrent(lifecycle)) return;
      await dependencies.publishLiveState(state);
    });
    await publication;
  };

  const invalidate = (): Lifecycle | undefined => {
    const previous = current;
    generation += 1;
    current = undefined;
    if (!previous) return undefined;
    const unregister = previous.unregisterResourceCleanup;
    previous.unregisterResourceCleanup = undefined;
    unregister?.();
    previous.abortController.abort();
    previous.unsubscribeStopReopen?.();
    previous.unsubscribeStopReopen = undefined;
    previous.admission?.release();
    previous.admission = undefined;
    if (previous.heartbeatTimer) clearInterval(previous.heartbeatTimer);
    if (previous.mailboxTimer) clearInterval(previous.mailboxTimer);
    return previous;
  };

  const removeLifecycleState = (lifecycle: Lifecycle): Promise<void> =>
    serializePublication(() => dependencies.removeOwnedLiveState(lifecycle.sessionId, ownerId));

  const cleanupLifecycle = (lifecycle: Lifecycle): Promise<void> => {
    if (current === lifecycle) invalidate();
    return removeLifecycleState(lifecycle);
  };

  const reportCleanupFailure = (error: RuntimeValue): void => {
    process.emitWarning(`Session bridge cleanup failed: ${errorMessage(error)}`);
  };

  pi.on("session_start", async (_event, ctx) => {
    const previous = invalidate();
    const lifecycle: Lifecycle = {
      generation,
      ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      abortController: new AbortController(),
      desiredStatus: ctx.isIdle() ? "idle" : "busy",
      mailboxRunning: false,
      mailboxPending: false,
      mailboxRetryAt: 0,
      recoverClaimedMessages: true,
      submitted: new Map(),
      held: new Map(),
    };
    current = lifecycle;
    lifecycle.unsubscribeStopReopen = onStopReopen((rootSessionId) => {
      if (rootSessionId !== lifecycle.sessionId || !isCurrent(lifecycle)) return;
      void mailbox
        .releaseHeldMessages(lifecycle)
        .catch((error: RuntimeValue) => mailbox.reportDeliveryError(lifecycle, "drain", error));
    });
    lifecycle.unregisterResourceCleanup = registerSessionResourceCleanup((cleanupSessionId) => {
      if (cleanupSessionId !== undefined && cleanupSessionId !== lifecycle.sessionId) return;
      void cleanupLifecycle(lifecycle).catch(reportCleanupFailure);
    });
    if (previous) {
      await removeLifecycleState(previous);
      if (!isCurrent(lifecycle)) return;
    }
    const directory = dependencies.mailboxPath(lifecycle.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!isCurrent(lifecycle)) return;
    lifecycle.heartbeatTimer = setInterval(
      () =>
        void publish(lifecycle).catch((error: RuntimeValue) =>
          mailbox.reportDeliveryError(lifecycle, "heartbeat", error),
        ),
      HEARTBEAT_INTERVAL_MS,
    );
    lifecycle.mailboxTimer = setInterval(
      () =>
        void mailbox
          .drainMailbox(lifecycle)
          .catch((error: RuntimeValue) => mailbox.reportDeliveryError(lifecycle, "drain", error)),
      MAILBOX_FALLBACK_INTERVAL_MS,
    );
    lifecycle.heartbeatTimer.unref();
    lifecycle.mailboxTimer.unref();
    void mailbox
      .watchMailbox(lifecycle, directory)
      .catch((error: RuntimeValue) => mailbox.reportDeliveryError(lifecycle, "watch", error));
    await publish(lifecycle);
    if (isCurrent(lifecycle)) {
      void mailbox
        .drainMailbox(lifecycle)
        .catch((error: RuntimeValue) => mailbox.reportDeliveryError(lifecycle, "drain", error));
    }
  });
  pi.on("agent_start", async (_event, ctx) => {
    const lifecycle = current;
    if (!lifecycle || ctx.sessionManager.getSessionId() !== lifecycle.sessionId) return;
    const admission = lifecycle.admission;
    lifecycle.admission = undefined;
    admission?.release();
    await publish(lifecycle, "busy");
    if (isCurrent(lifecycle)) await mailbox.reconcileSubmitted(lifecycle);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const lifecycle = current;
    if (!lifecycle || ctx.sessionManager.getSessionId() !== lifecycle.sessionId) return;
    await publish(lifecycle, "idle");
    if (isCurrent(lifecycle)) {
      await mailbox.reconcileSubmitted(lifecycle);
      void mailbox
        .drainMailbox(lifecycle)
        .catch((error: RuntimeValue) => mailbox.reportDeliveryError(lifecycle, "drain", error));
    }
  });
  pi.on("session_shutdown", async () => {
    const lifecycle = invalidate();
    if (!lifecycle) return;
    await removeLifecycleState(lifecycle);
  });
}
