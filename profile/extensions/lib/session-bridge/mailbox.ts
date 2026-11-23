import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BRIDGE_VERSION,
  readJson,
  writeJsonAtomic,
} from "../../../../packages/choco-pi-editor-context/src/live-session-client.ts";
import type { RuntimeValue } from "../runtime-values.ts";
import { releaseMailboxSubmission, reserveMailboxSubmission } from "../session-mailbox-delivery.ts";
import { formatHeldMessageNotice, readStopState } from "../stop-control.ts";
import {
  contentText,
  delay,
  deliveryErrorDetails,
  errorMessage,
  formatIncomingMessage,
  isRecord,
  MAILBOX_ACCEPT_TIMEOUT_MS,
  MAILBOX_FALLBACK_INTERVAL_MS,
  MAILBOX_LOCK_STALE_MS,
  mailboxPath,
  messageMarker,
  parseMailboxMessage,
  startupAdmission,
  type DeliveryStage,
  type Lifecycle,
  type LiveSessionBridgeDependencies,
  type MailboxMessage,
} from "./types.ts";

async function releaseMailboxSequenceLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
}

async function withNextMailboxSequence(
  directory: string,
  writeMessage: (sequence: number) => Promise<void>,
): Promise<void> {
  const lockPath = join(directory, ".sequence.lock");
  const statePath = join(directory, ".sequence.json");
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > MAILBOX_LOCK_STALE_MS) await unlink(lockPath);
      } catch (lockError) {
        if (!isRecord(lockError) || lockError.code !== "ENOENT") throw lockError;
      }
      await delay(25);
    }
  }

  let failure: { error: RuntimeValue } | undefined;
  try {
    const state = await readJson(statePath);
    const previous =
      isRecord(state) && Number.isSafeInteger(state.sequence) && Number(state.sequence) >= 0
        ? Number(state.sequence)
        : 0;
    const sequence = previous + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Mailbox sequence is exhausted.");
    await writeJsonAtomic(statePath, { version: BRIDGE_VERSION, sequence });
    await writeMessage(sequence);
  } catch (error) {
    failure = { error };
  }
  try {
    await releaseMailboxSequenceLock(lockPath);
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}

export async function queueMailboxMessage(message: MailboxMessage): Promise<void> {
  const directory = mailboxPath(message.targetSessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await withNextMailboxSequence(directory, async (sequence) => {
    await writeJsonAtomic(
      join(directory, `${sequence.toString().padStart(20, "0")}-${message.id}.json`),
      message,
    );
  });
}

export type MailboxController = {
  reportDeliveryError(lifecycle: Lifecycle, stage: DeliveryStage, error: RuntimeValue): void;
  reconcileSubmitted(lifecycle: Lifecycle): Promise<void>;
  releaseHeldMessages(lifecycle: Lifecycle): Promise<void>;
  drainMailbox(lifecycle: Lifecycle): Promise<void>;
  watchMailbox(lifecycle: Lifecycle, directory: string): Promise<void>;
};

export function createMailboxController(
  pi: ExtensionAPI,
  ownerId: string,
  dependencies: LiveSessionBridgeDependencies,
  isCurrent: (lifecycle: Lifecycle) => boolean,
): MailboxController {
  const transcriptHasMessage = (lifecycle: Lifecycle, messageId: string): boolean => {
    if (!isCurrent(lifecycle)) return false;
    const marker = messageMarker(messageId);
    return lifecycle.ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          isRecord(entry.message) &&
          contentText(entry.message.content, true).includes(marker),
      );
  };

  const restoreClaim = async (
    lifecycle: Lifecycle,
    claimedPath: string,
    sourcePath: string,
  ): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    try {
      await rename(claimedPath, sourcePath);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  };

  const reportDeliveryError = (
    lifecycle: Lifecycle,
    stage: DeliveryStage,
    error: RuntimeValue,
  ): void => {
    if (!isCurrent(lifecycle)) return;
    pi.sendMessage(
      {
        customType: "choco-pi:session-bridge-error",
        content: `Session bridge delivery error: ${errorMessage(error)}`,
        display: true,
        details: deliveryErrorDetails(stage, error),
      },
      { triggerTurn: false },
    );
  };

  const reconcileSubmitted = async (lifecycle: Lifecycle): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    for (const [messageId, claim] of lifecycle.submitted) {
      if (!isCurrent(lifecycle)) return;
      if (transcriptHasMessage(lifecycle, messageId)) {
        try {
          await unlink(claim.claimedPath);
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") {
            reportDeliveryError(lifecycle, "claim-unlink", error);
            continue;
          }
        }
        if (isCurrent(lifecycle)) releaseMailboxSubmission(lifecycle.submitted, messageId);
        continue;
      }
      if (lifecycle.ctx.isIdle() && Date.now() - claim.submittedAt >= MAILBOX_ACCEPT_TIMEOUT_MS) {
        try {
          await restoreClaim(lifecycle, claim.claimedPath, claim.sourcePath);
          if (isCurrent(lifecycle)) releaseMailboxSubmission(lifecycle.submitted, messageId);
        } catch (error) {
          reportDeliveryError(lifecycle, "claim-restore", error);
        }
      }
    }
  };

  const holdMessage = (
    lifecycle: Lifecycle,
    message: MailboxMessage,
    claimedPath: string,
    sourcePath: string,
  ): void => {
    if (lifecycle.held.has(message.id)) return;
    lifecycle.held.set(message.id, { message, claimedPath, sourcePath });
    lifecycle.ctx.ui.notify(formatHeldMessageNotice(message.fromSessionId), "info");
  };

  const dispatchClaimedMessage = async (
    lifecycle: Lifecycle,
    message: MailboxMessage,
    claimedPath: string,
    sourcePath: string,
  ): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    if (transcriptHasMessage(lifecycle, message.id)) {
      await unlink(claimedPath);
      return;
    }
    if (readStopState(lifecycle.sessionId).closed) {
      holdMessage(lifecycle, message, claimedPath, sourcePath);
      return;
    }
    if (
      !reserveMailboxSubmission(lifecycle.submitted, message.id, {
        claimedPath,
        sourcePath,
        submittedAt: Date.now(),
      })
    )
      return;
    try {
      while (lifecycle.admission) {
        await lifecycle.admission.started;
        if (!isCurrent(lifecycle)) return;
      }
      if (readStopState(lifecycle.sessionId).closed) {
        releaseMailboxSubmission(lifecycle.submitted, message.id);
        holdMessage(lifecycle, message, claimedPath, sourcePath);
        return;
      }
      const admission = lifecycle.ctx.isIdle() ? startupAdmission() : undefined;
      lifecycle.admission = admission;
      pi.sendUserMessage(
        formatIncomingMessage(message.fromSessionId, message.message, message.id),
        { deliverAs: "steer" },
      );
      if (admission) await admission.started;
    } catch (error) {
      const admission = lifecycle.admission;
      lifecycle.admission = undefined;
      admission?.release();
      releaseMailboxSubmission(lifecycle.submitted, message.id);
      lifecycle.mailboxRetryAt = Date.now() + MAILBOX_FALLBACK_INTERVAL_MS;
      try {
        await restoreClaim(lifecycle, claimedPath, sourcePath);
      } catch (restoreError) {
        reportDeliveryError(lifecycle, "claim-restore", restoreError);
      }
      throw error;
    }
  };

  const drainMailbox = async (lifecycle: Lifecycle): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    if (Date.now() < lifecycle.mailboxRetryAt) return;
    if (lifecycle.mailboxRunning) {
      lifecycle.mailboxPending = true;
      return;
    }
    lifecycle.mailboxRunning = true;
    lifecycle.mailboxPending = false;
    try {
      const directory = dependencies.mailboxPath(lifecycle.sessionId);
      let files: string[];
      try {
        const directoryEntries = await readdir(directory);
        files = directoryEntries
          .filter(
            (file) =>
              !file.startsWith(".") &&
              (file.endsWith(".json") ||
                (lifecycle.recoverClaimedMessages && file.endsWith(".claimed"))),
          )
          .sort((left, right) => left.localeCompare(right));
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return;
        throw error;
      }
      if (!isCurrent(lifecycle)) return;

      for (const file of files) {
        if (!isCurrent(lifecycle)) return;
        const listedPath = join(directory, file);
        const originalName = file.replace(/\.json(?:\.\d+\.[A-Za-z0-9-]+\.claimed)?$/, ".json");
        const sourcePath = join(directory, originalName);
        const claimedPath = file.endsWith(".claimed")
          ? listedPath
          : `${listedPath}.${process.pid}.${ownerId}.claimed`;
        if (!file.endsWith(".claimed")) {
          try {
            await rename(listedPath, claimedPath);
          } catch (error) {
            if (isRecord(error) && error.code === "ENOENT") continue;
            throw error;
          }
          if (!isCurrent(lifecycle)) return;
        }

        let message: MailboxMessage | undefined;
        try {
          message = parseMailboxMessage(await readJson(claimedPath));
        } catch (error) {
          if (!isCurrent(lifecycle)) return;
          if (error instanceof SyntaxError) {
            reportDeliveryError(lifecycle, "claim-parse", error);
            await unlink(claimedPath);
            continue;
          }
          lifecycle.mailboxRetryAt = Date.now() + MAILBOX_FALLBACK_INTERVAL_MS;
          try {
            await restoreClaim(lifecycle, claimedPath, sourcePath);
          } catch (restoreError) {
            reportDeliveryError(lifecycle, "claim-restore", restoreError);
          }
          reportDeliveryError(lifecycle, "claim-read", error);
          continue;
        }
        if (!isCurrent(lifecycle)) return;
        if (
          !message ||
          message.targetSessionId !== lifecycle.sessionId ||
          message.fromSessionId === lifecycle.sessionId
        ) {
          await unlink(claimedPath);
          continue;
        }
        try {
          await dispatchClaimedMessage(lifecycle, message, claimedPath, sourcePath);
        } catch (error) {
          reportDeliveryError(lifecycle, "dispatch", error);
        }
      }
      lifecycle.recoverClaimedMessages = false;
      await reconcileSubmitted(lifecycle);
    } finally {
      lifecycle.mailboxRunning = false;
      if (isCurrent(lifecycle) && lifecycle.mailboxPending) {
        void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
          reportDeliveryError(lifecycle, "drain", error),
        );
      }
    }
  };

  const releaseHeldMessages = async (lifecycle: Lifecycle): Promise<void> => {
    for (const [messageId, held] of Array.from(lifecycle.held)) {
      if (!isCurrent(lifecycle) || readStopState(lifecycle.sessionId).closed) return;
      lifecycle.held.delete(messageId);
      try {
        await dispatchClaimedMessage(lifecycle, held.message, held.claimedPath, held.sourcePath);
      } catch (error) {
        reportDeliveryError(lifecycle, "dispatch", error);
      }
    }
    await drainMailbox(lifecycle);
  };

  const watchMailbox = async (lifecycle: Lifecycle, directory: string): Promise<void> => {
    try {
      await dependencies.watchMailbox(directory, lifecycle.abortController.signal, () => {
        if (!isCurrent(lifecycle)) return;
        void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
          reportDeliveryError(lifecycle, "drain", error),
        );
      });
    } catch (error) {
      if (!isRecord(error) || error.name !== "AbortError") throw error;
    }
  };

  return {
    reportDeliveryError,
    reconcileSubmitted,
    releaseHeldMessages,
    drainMailbox,
    watchMailbox,
  };
}
