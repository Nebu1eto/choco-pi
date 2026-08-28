import {
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  adoptCheckpoints,
  captureGitSnapshot,
  CheckpointError,
  checkpointRetentionMs,
  headDriftSince,
  pruneCheckpointRefs,
  sessionCheckpointRef,
  type GitSnapshot,
} from "./checkpoints/git-snapshot.ts";
import { restoreTurn } from "./checkpoints/rollback.ts";
import {
  renderCheckpointPicker,
  resolvePickerKey,
  TURN_ACTION_LABELS,
  type TurnAction,
} from "./checkpoints/picker.ts";
import {
  buildTurnTimeline,
  CHECKPOINT_ENTRY,
  checkpointAnchorsFromEntries,
  messageContentLabel,
  RESTORE_ENTRY,
  sessionTurnsFromEntries,
  turnCheckpointsFromEntries,
  type FileCheckpoint,
  type SessionTurn,
  type TurnTimelineItem,
} from "./checkpoints/turns.ts";
import { propertiesWhen, reinterpretHostValue, type RuntimeValue } from "./lib/runtime-values.ts";

export {
  buildTurnTimeline,
  checkpointAnchorsFromEntries,
  sessionTurnsFromEntries,
  turnCheckpointsFromEntries,
  type FileCheckpoint,
  type SessionTurn,
  type TurnCheckpoint,
  type TurnTimelineItem,
} from "./checkpoints/turns.ts";
export { renderCheckpointPicker, resolvePickerKey, type TurnAction } from "./checkpoints/picker.ts";
export { restoreTurn, type RollbackHost } from "./checkpoints/rollback.ts";
export {
  captureGitSnapshot,
  restoreGitSnapshot,
  type ChangeSummary,
  type GitSnapshot,
} from "./checkpoints/git-snapshot.ts";

/** A recoverable capture failure is reported at most this often per session. */
const TRANSIENT_NOTICE_INTERVAL_MS = 5 * 60 * 1000;

type CaptureState = {
  sessionId: string;
  ref: string;
  previous?: GitSnapshot;
  /** Agent turn that will own the next user message entry. */
  activeTurn?: { index: number; timestamp: number };
  /** Set once the working tree can never produce checkpoints; stops retrying. */
  disabledReason?: string;
  lastFailure?: string;
  lastNoticeAt?: number;
};

type PickerChoice = {
  turn: SessionTurn;
  /** Absent when the user pressed Enter and still has to pick an action. */
  action?: TurnAction;
};

/** Pi's interactive mode, reached only to redirect its built-in fork selector. */
type ForkSelectorHost = {
  showUserMessageSelector: () => void;
  session: { prompt: (text: string) => Promise<void> };
  __chocoPiCheckpointPickerApplied?: boolean;
};

function failureDetail(error: RuntimeValue): string {
  return error instanceof Error ? error.message : String(error);
}

export default function fileCheckpoints(pi: ExtensionAPI): void {
  let state: CaptureState | undefined;
  let generation = 0;

  function captureState(ctx: ExtensionContext): CaptureState {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!state || state.sessionId !== sessionId) {
      state = { sessionId, ref: sessionCheckpointRef(sessionId) };
    }
    return state;
  }

  function recordFailure(ctx: ExtensionContext, current: CaptureState, error: RuntimeValue): void {
    const detail = failureDetail(error);
    current.lastFailure = detail;
    if (error instanceof CheckpointError && error.kind === "unsupported") {
      current.disabledReason = detail;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `File checkpoints are off for this session: ${detail} Conversation rewind and fork still work.`,
          "warning",
        );
      }
      return;
    }
    const now = Date.now();
    const quiet =
      current.lastNoticeAt !== undefined &&
      now - current.lastNoticeAt < TRANSIENT_NOTICE_INTERVAL_MS;
    if (!ctx.hasUI || quiet) return;
    current.lastNoticeAt = now;
    ctx.ui.notify(`File checkpoint skipped for this turn: ${detail}`, "warning");
  }

  /** Captures the live state, reporting whether Git reused the previous snapshot. */
  async function captureNow(
    ctx: ExtensionContext,
    current: CaptureState,
    message: string,
    owner: number,
  ): Promise<{ snapshot: GitSnapshot; reused: boolean } | undefined> {
    if (current.disabledReason) return undefined;
    const cwd = ctx.cwd;
    const ref = current.ref;
    const previous = current.previous;
    try {
      const snapshot = await captureGitSnapshot(cwd, {
        ref,
        message,
        ...propertiesWhen(previous, () => ({ previous })),
      });
      if (owner !== generation) return undefined;
      current.previous = snapshot;
      current.lastFailure = undefined;
      return { snapshot, reused: snapshot === previous };
    } catch (error) {
      if (owner !== generation) return undefined;
      recordFailure(ctx, current, error);
      return undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const current = captureState(ctx);
    const owner = generation;
    const cwd = ctx.cwd;
    const ref = current.ref;
    const entries = ctx.sessionManager.getEntries();
    current.previous = turnCheckpointsFromEntries(entries).at(-1)?.checkpoint;
    // Adopt before pruning: a fork's inherited checkpoints must be anchored
    // under this session's ref before the parent's ref can expire.
    void adoptCheckpoints(cwd, {
      ref,
      anchors: checkpointAnchorsFromEntries(entries),
    })
      .catch(() => undefined)
      .then(() => {
        if (owner !== generation) return undefined;
        return pruneCheckpointRefs(cwd, {
          maxAgeMs: checkpointRetentionMs(),
          keepRef: ref,
        }).catch(() => undefined);
      });
  });

  pi.on("turn_start", (event, ctx) => {
    const current = captureState(ctx);
    current.activeTurn = { index: event.turnIndex, timestamp: event.timestamp };
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user") return;
    const current = captureState(ctx);
    const turn = current.activeTurn;
    if (!turn) return;
    const label = messageContentLabel(event.message.content);
    const owner = generation;
    const captured = await captureNow(
      ctx,
      current,
      `choco-pi checkpoint turn ${turn.index}`,
      owner,
    );
    if (!captured || captured.reused || owner !== generation) return;
    pi.appendEntry<FileCheckpoint>(CHECKPOINT_ENTRY, {
      version: 2,
      ...captured.snapshot,
      timestamp: new Date(turn.timestamp).toISOString(),
      turnIndex: turn.index,
      label,
    });
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    state = undefined;
  });

  async function selectTurn(
    ctx: ExtensionCommandContext,
    items: readonly TurnTimelineItem[],
    unavailable: string | undefined,
  ): Promise<PickerChoice | undefined> {
    if (ctx.mode !== "tui") {
      const reversed = items.toReversed();
      const choices = reversed.map(
        ({ turn }) =>
          `Turn ${turn.index} · ${turn.label}${turn.checkpoint ? "" : " (no checkpoint)"}`,
      );
      const picked = await ctx.ui.select("Checkpoints", choices);
      const turn = picked ? reversed[choices.indexOf(picked)]?.turn : undefined;
      return turn ? { turn } : undefined;
    }

    return ctx.ui.custom<PickerChoice | undefined>((tui, theme, _keybindings, done) => {
      let selectedIndex = Math.max(0, items.length - 1);
      let notice = unavailable;
      return {
        render: (width: number) =>
          renderCheckpointPicker({
            items,
            selectedIndex,
            width,
            theme,
            ...propertiesWhen(notice, () => ({ notice })),
          }),
        invalidate: () => {},
        handleInput: (data: string) => {
          const key = resolvePickerKey(data);
          if (!key) return;
          if (key.kind === "cancel") {
            done(undefined);
            return;
          }
          if (key.kind === "move") {
            selectedIndex = Math.min(items.length - 1, Math.max(0, selectedIndex + key.delta));
            tui.requestRender();
            return;
          }
          if (key.kind === "jump") {
            selectedIndex = key.position === "first" ? 0 : items.length - 1;
            tui.requestRender();
            return;
          }
          const focused = items[selectedIndex]?.turn;
          if (!focused) return;
          if (key.kind === "choose") {
            done({ turn: focused });
            return;
          }
          if (key.action === "rollback" && !focused.checkpoint) {
            notice = unavailable ?? "This turn has no file checkpoint, so rollback is unavailable.";
            tui.requestRender();
            return;
          }
          done({ turn: focused, action: key.action });
        },
      };
    });
  }

  async function chooseAction(
    ctx: ExtensionCommandContext,
    turn: SessionTurn,
  ): Promise<TurnAction | undefined> {
    // Rollback is offered only when this turn actually has files to restore, so
    // the dialog never presents a choice that is guaranteed to fail.
    const available: TurnAction[] = turn.checkpoint
      ? ["rewind", "rollback", "fork"]
      : ["rewind", "fork"];
    const options = available.map((action) => TURN_ACTION_LABELS[action]);
    const picked = await ctx.ui.select(`Turn ${turn.index} · ${turn.label}`, [
      ...options,
      "Cancel",
    ]);
    const index = picked ? options.indexOf(picked) : -1;
    return index === -1 ? undefined : available[index];
  }

  async function rollbackTurn(
    ctx: ExtensionCommandContext,
    current: CaptureState,
    turn: SessionTurn,
  ): Promise<void> {
    const checkpoint = turn.checkpoint;
    if (!checkpoint) throw new Error("This turn has no file checkpoint.");

    const drift = await headDriftSince(ctx.cwd, checkpoint.head);
    if (drift) {
      const landed =
        drift.commits > 0
          ? `${drift.commits} commit${drift.commits === 1 ? "" : "s"} landed after this turn.`
          : "HEAD has moved since this turn.";
      const confirmed = await ctx.ui.confirm(
        "Roll back across newer commits?",
        `${landed} The rollback restores files and the Git index exactly, but leaves HEAD where it is, so the restored state will read as a large diff against the newer commit.`,
      );
      if (!confirmed) return;
    }

    const safety = await captureGitSnapshot(ctx.cwd, {
      ref: current.ref,
      message: "choco-pi checkpoint before rollback",
      ...propertiesWhen(current.previous, () => ({ previous: current.previous })),
    });
    current.previous = safety;

    await restoreTurn(ctx, checkpoint, turn.entryId, safety);
    pi.appendEntry(RESTORE_ENTRY, {
      restoredCommit: checkpoint.commit ?? checkpoint.ref,
      safetyCommit: safety.commit ?? safety.ref,
      restoredAt: new Date().toISOString(),
    });
    ctx.ui.notify(
      `Rolled back to turn ${turn.index}. The previous state stays reachable at ${safety.commit?.slice(0, 12) ?? safety.ref}.`,
      "info",
    );
  }

  async function runAction(
    ctx: ExtensionCommandContext,
    current: CaptureState,
    turn: SessionTurn,
    action: TurnAction,
  ): Promise<void> {
    try {
      if (action === "fork") {
        const result = await ctx.fork(turn.entryId, { position: "before" });
        if (!result.cancelled) ctx.ui.notify(`Forked a new session at turn ${turn.index}.`, "info");
        return;
      }
      if (action === "rewind") {
        const navigation = await ctx.navigateTree(turn.entryId, { summarize: false });
        if (navigation.cancelled) return;
        ctx.ui.notify(
          `Rewound the conversation to turn ${turn.index}. Files were not changed.`,
          "info",
        );
        return;
      }
      await rollbackTurn(ctx, current, turn);
    } catch (error) {
      ctx.ui.notify(`${TURN_ACTION_LABELS[action]} failed: ${failureDetail(error)}`, "error");
    }
  }

  async function openPicker(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) {
      // Every action here rewrites the session tree, which Pi refuses mid-stream.
      ctx.ui.notify(
        "Waiting for the current response to finish before opening checkpoints.",
        "info",
      );
    }
    await ctx.waitForIdle();
    const turns = sessionTurnsFromEntries(ctx.sessionManager.getBranch());
    if (turns.length === 0) {
      ctx.ui.notify("This session branch has no user turns yet.", "warning");
      return;
    }

    const current = captureState(ctx);
    const owner = generation;
    const captured = await captureNow(ctx, current, "choco-pi checkpoint picker", owner);
    if (owner !== generation) return;
    const live = captured?.snapshot;
    const unavailable = live
      ? undefined
      : (current.disabledReason ?? current.lastFailure ?? "File checkpoints are unavailable.");
    const timeline = await buildTurnTimeline(ctx.cwd, turns, live);

    const choice = await selectTurn(ctx, timeline, unavailable);
    if (!choice) return;
    const action = choice.action ?? (await chooseAction(ctx, choice.turn));
    if (!action) return;
    await runAction(ctx, current, choice.turn, action);
  }

  pi.registerCommand("rewind", {
    description: "Rewind, roll back, or fork the session at a checkpointed turn",
    handler: (_args, ctx) => openPicker(ctx),
  });

  overrideForkSelector();
}

/**
 * Points Pi's built-in fork selector at this picker.
 *
 * Interactive mode dispatches `/fork`, the `app.session.fork` binding, and the
 * double-escape action straight to its own selector before extension commands
 * are consulted, so replacing that one method is the only way to make all three
 * entry points open the checkpoint picker.
 */
function overrideForkSelector(): void {
  const prototype = reinterpretHostValue<ForkSelectorHost>(InteractiveMode.prototype);
  if (prototype.__chocoPiCheckpointPickerApplied) return;
  prototype.showUserMessageSelector = function openCheckpointPicker(this: ForkSelectorHost) {
    void this.session.prompt("/rewind");
  };
  prototype.__chocoPiCheckpointPickerApplied = true;
}
