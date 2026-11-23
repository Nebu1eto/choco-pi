/**
 * turn_start, agent_end, and turn_end hooks (including event-loop block telemetry).
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

import { adoptProjectTrustFromPorts } from "../clients/project-trust.ts";
import { readExtensionMode } from "../clients/extension-mode.ts";
import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { exportWidgetState } from "../clients/widget-state.ts";
import { saveSessionState } from "../clients/session-state-store.ts";
import { resetFormatService } from "../clients/format-service.ts";
import { recordCrossProcessTouches } from "../clients/agent-nudge.ts";
import { readCrossProcessTouchesForTurnStart } from "../clients/recent-touches.ts";
import { resetLSPService } from "../clients/lsp/index.ts";
import { buildMemorySample, shouldEmitMemorySample } from "../clients/memory-sampler.ts";
import {
  checkSmellsAndNoteOnce,
  countRecentSmells,
  shouldCheckSmellsThisTurn,
} from "../clients/smells-rollup.ts";
import {
  clearLastAnalyzedStateCache,
  flushDebouncedToolResults,
} from "../clients/runtime-tool-result.ts";
import { handleTurnEnd } from "../clients/runtime-turn.ts";
import { setAmbientAbortSignal } from "../clients/safe-spawn.ts";
import {
  getLastLoggedPhase,
  getRecentLoggedPhases,
  logLatency,
} from "../clients/latency-logger.ts";
import { emitBounded } from "../clients/bounded-telemetry.ts";
import {
  getEventLoopStats,
  resetEventLoopMonitor,
  shouldLogLoopBlock,
  shouldLogWorstBlock,
} from "../clients/event-loop-monitor.ts";
import type { ExtensionActivation } from "./activation.ts";
import { processState } from "./process-state.ts";
import { dbg, getStableSessionId, notifyUi } from "./shared.ts";

/**
 * Identity for the `loop_block` record (#1743). An event-loop block is a
 * process-wide fact — there is no file, tool, or request to discriminate on —
 * so the identity is this fixed marker, the same value the record's
 * `filePath` has carried since #192.
 */
const LOOP_BLOCK_IDENTITY = "<choco-pi-lsp>";

/** Register turn_start, agent_end, and turn_end. */
export function registerTurnHooks(activation: ExtensionActivation): void {
  const {
    pi,
    hostPorts,
    runtime,
    contextInjectionHistory,
    cacheManager,
    activationState,
    getLensFlag,
    rememberOwnEventCtx,
    updateLspStatus,
    captureLspStatusRepaint,
    mountLensWidget,
  } = activation;
  // --- Turn end: batch jscpd/madge on collected files, then clear state ---
  // Clear cascade snapshot at start of each new turn so stale data never leaks
  pi.on("turn_start", (_event: any, ctx) => {
    rememberOwnEventCtx(ctx);
    // Trust can change without a new session. Re-adopt before this turn can
    // reach any install-capable or LSP-spawn path.
    adoptProjectTrustFromPorts(hostPorts);
    if (
      activationState.lensWidgetVisible &&
      ctx?.ui &&
      (activationState.mountedLensWidgetUi === undefined ||
        activationState.mountedLensWidgetUi !== ctx.ui)
    ) {
      mountLensWidget(ctx.ui, readExtensionMode(ctx));
    }
    runtime.beginTurn();
    clearLastAnalyzedStateCache();

    // #492: parent-at-turn_start cross-process nudge consumer — the "parent
    // blind to child" direction, arguably the more important one (the
    // child is ephemeral; the parent keeps editing the same tree after a
    // subagent returns and its choco-pi-lsp has autoformatted on top of the
    // child's edits). Hot path: `readCrossProcessTouchesForTurnStart`
    // mtime-gates itself (ONE `fs.stat`, no read/parse when the record
    // hasn't changed since the last turn_start), so this call is
    // effectively free on every turn that has no cross-process activity —
    // fire-and-forget, never awaited (must not delay turn_start), and
    // internally never throws.
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    void readCrossProcessTouchesForTurnStart({ cwd })
      .then((entries) => {
        if (entries.length === 0) return;
        // Relevance filter (#492 point 6): readCrossProcessTouchesForTurnStart
        // already applied the shared baseline filter (foreign pid, 15-minute
        // freshness window, file still exists) plus the consumed-cursor
        // dedup — same baseline as the session_start reader. A parent's own
        // read-guard history is the FIRST signal for most entries (files it
        // read/edited this session, same as the #485 local filter) — but
        // unlike the local filter, an entry the parent has NEVER seen still
        // passes through here: a parent about to `git commit` needs
        // attribution for cross-process drift even in files it hasn't
        // opened yet this session, so there is deliberately no read-guard
        // drop path — every entry that reaches this point is relevant by
        // construction.
        recordCrossProcessTouches(entries.map((e) => ({ path: e.path, reason: e.reason })));
        dbg(`turn_start: cross-process nudge — ${entries.length} file(s) from other instance(s)`);
      })
      .catch((err) => {
        dbg(`turn_start: cross-process nudge read failed: ${err}`);
      });
  });

  pi.on("agent_end", async (_event, ctx) => {
    contextInjectionHistory.clear(getStableSessionId(ctx));
    if (!activationState.lensEnabled) return;
    // Esc/abort during the debounce flush kills in-flight children. The
    // deferred-format/autofix drain no longer runs from this handler at
    // all (#1654 — see the module comment above); its own abort/requeue
    // handling is wired at the `agent_settled` registration below instead.
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
    try {
      // Ensure any pipeline still queued in the debounce window finishes
      // before agent_end runs — otherwise project change-log entries and
      // modified ranges this turn produced may not be reflected yet. This
      // is per-turn bookkeeping for edits the agent already made, not the
      // once-per-run deferred-format/autofix drain (#1654: that moved to
      // `agent_settled` below, since — unlike this flush — running it here
      // can fire mid-run, between auto-retries).
      await flushDebouncedToolResults();
      if (ctx.ui) updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
    } catch (agentEndErr) {
      dbg(`agent_end crashed: ${agentEndErr}`);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      dbg(`agent_end crash stack: ${(agentEndErr as Error).stack}`);
    } finally {
      setAmbientAbortSignal(undefined);
    }
  });

  pi.on("turn_end", async (_event: any, ctx) => {
    if (!activationState.lensEnabled) return;
    // Esc/abort during the turn-end flush (knip/madge/tests + debounced
    // dispatch) kills in-flight children instead of waiting out their timeout.
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    setAmbientAbortSignal((ctx as { signal?: AbortSignal })?.signal);
    try {
      const repaintLspStatus = captureLspStatusRepaint(ctx);
      // Persist every event-loop block over the floor to latency.log,
      // attributed to this turn, so freezes are queryable across sessions
      // (#192). Logging used to gate on "new session worst" alone, which
      // hid every sub-maximum block after a session's first large one —
      // exactly the blocks that need to be checked against LSP pull
      // timeouts (#1549/#1713), so #1723 widened the gate to the floor and
      // kept "new worst" only as metadata / high-water bookkeeping. Volume
      // stays bounded because this runs at most once per turn (the window
      // is per-turn, #1122): one `loop_block` record per turn, not one per
      // sample. The window is per-turn also so the probe cannot itself see
      // machine sleep or commit-charge paging, both of which freeze the
      // process and masquerade as huge synchronous blocks — samples the
      // turn's CPU budget can't account for are tagged
      // `suspectSystemStall` and excluded from the genuine-block
      // high-waters. `lastPhase`/`recentPhases` are cheap block attribution
      // (#1123 item 1, widened #1723 item 2) — the phases that ran before
      // the block was detected; a bounded ring rather than one pointer,
      // because the phase actually causing a synchronous block is often
      // still in flight (and so unlogged) when the block fires, so the
      // single last-COMPLETED phase can point at unrelated prior work.
      const elStats = getEventLoopStats();
      const loopMaxMs = elStats?.maxMs ?? 0;
      const suspectSystemStall = elStats?.suspectSystemStall ?? false;
      if (shouldLogLoopBlock(loopMaxMs)) {
        const lastPhase = getLastLoggedPhase();
        const recentPhases = getRecentLoggedPhases(3);
        const isNewSessionWorst = shouldLogWorstBlock(
          loopMaxMs,
          processState.lastLoggedLoopWorstMs,
        );
        // #1743: routed through the bounded-telemetry helper. No
        // `capPerTurn` here, deliberately: this site's bound is its CALL
        // CADENCE (#1723) — `turn_end` runs it at most once per turn
        // because the histogram window resets every turn — so a
        // `capPerTurn: 1` would be a second, redundant guard that could
        // only ever fire in a harness that drives two `turn_end`s without
        // an intervening `turn_start`. The helper still supplies the
        // registry membership the sweep checks.
        emitBounded("loop_block", LOOP_BLOCK_IDENTITY, {
          type: "phase",
          durationMs: Math.round(loopMaxMs),
          metadata: {
            worstSoFar: isNewSessionWorst,
            turnIndex: runtime.turnIndex,
            suspectSystemStall,
            windowCpuMs: elStats?.windowCpuMs,
            windowWallMs: elStats?.windowWallMs,
            lastPhase: lastPhase?.phase,
            lastPhaseAt: lastPhase?.ts,
            recentPhases,
          },
        });
        // A system stall must not raise the "new worst genuine block"
        // bar, or it would silence every real block that follows it.
        if (suspectSystemStall) {
          processState.sessionSuspectedStalls += 1;
        } else if (isNewSessionWorst) {
          processState.lastLoggedLoopWorstMs = loopMaxMs;
          processState.sessionWorstRealBlockMs = Math.max(
            processState.sessionWorstRealBlockMs,
            loopMaxMs,
          );
        }
      }
      // Start a fresh per-turn occupancy window so the next turn's worst
      // block is attributable to that turn and its CPU budget is measured
      // over the same span (#1122).
      resetEventLoopMonitor();

      // #1123 item 2: periodic memory-attribution sample, every
      // MEMORY_SAMPLE_TURN_INTERVAL turns — cheap (O(1)/O(bounded-cache-size)
      // reads only, see clients/memory-sampler.ts) so no extra throttling is
      // needed beyond the turn cadence itself.
      if (shouldEmitMemorySample(runtime.turnIndex)) {
        try {
          const sample = buildMemorySample(runtime.wordIndex);
          logLatency({
            type: "phase",
            filePath: "<choco-pi-lsp>",
            phase: "memory_sample",
            durationMs: 0,
            // SAFETY: buildMemorySample produces the latency logger's recursively serializable metadata values.
            metadata: { turnIndex: runtime.turnIndex, ...sample } as Parameters<
              typeof logLatency
            >[0]["metadata"],
          });
        } catch {
          // best-effort observability — never fail turn_end over this
        }
      }

      // #1123 item 3: bounded smells re-check, same cadence style as the memory
      // sample above — at most once per SMELLS_TURN_CHECK_INTERVAL turns, and
      // each smell notifies at most once per session (checkSmellsAndNoteOnce's
      // gate). See clients/smells-rollup.ts for the tail-scan cost bound.
      if (shouldCheckSmellsThisTurn(runtime.turnIndex)) {
        try {
          // S3c (#1432 review): use the in-process session start instead of
          // letting countRecentSmells() fall back to its 24h rolling
          // window — turn_end already knows exactly when this session
          // began, so admitted rows are scoped to it, not to a day-wide
          // guess that could straddle multiple sessions.
          for (const note of checkSmellsAndNoteOnce(
            countRecentSmells(undefined, runtime.sessionStartedAt),
          )) {
            notifyUi(ctx, note, "warning");
          }
        } catch {
          // best-effort observability — never fail turn_end over this
        }
      }

      // Drain any tool_result still in the debounce window so turn_end
      // reads consistent state (cache, modified ranges, change-log).
      await flushDebouncedToolResults();
      const { testRunnerClient } = await loadBootstrapClients();
      await handleTurnEnd({
        ctxCwd: ctx.cwd,
        getFlag: (name: string) => getLensFlag(name),
        dbg,
        runtime,
        cacheManager,
        testRunnerClient,
        // The LSP idle reset (240s of no turns) releases the warm servers
        // from a detached timer, with no pi event in flight — so nothing
        // would repaint the footer and it would keep showing a stale
        // "LSP Active". Wrap the reset to refresh the status right after it
        // fires; resetLSPService nulls the singleton synchronously, so the
        // repaint sees zero alive servers and renders "LSP Inactive" (#281).
        // Capture the repaint callback during the active event — detached timers
        // must not touch ctx.ui after session replacement/reload (#338).
        resetLSPService: () => {
          try {
            resetLSPService({ reason: "idle" });
          } finally {
            repaintLspStatus?.();
          }
        },
        resetFormatService,
      });
      repaintLspStatus?.();

      // #190: persist this session's settled widget diagnostics so a later
      // resume (`pi --session <id>`) can rehydrate them. Only when pi gave us
      // a stable session id (else the file would be orphaned, never loaded).
      // Fire-and-forget — persistence must never delay or break a turn.
      if (runtime.hasStableSessionId) {
        void saveSessionState(
          ctx.cwd ?? process.cwd(),
          runtime.telemetrySessionId,
          exportWidgetState(),
          // #1041: persist the read-guard read-set on the same snapshot so a
          // later resume can rehydrate it (reconciled against disk on load).
          runtime.readGuard.exportState(),
        );
      }

      // #484: the turn-summary entry is deliberately NOT emitted here.
      // sendMessage while the session is streaming STEERS the live model
      // conversation (SDK sendCustomMessage's isStreaming branch), and a
      // mid-run turn_end plausibly fires while streaming — so the emit
      // lives in the agent_settled quiet window below, where the session
      // is idle and sendMessage takes the safe append branch. The
      // collector accumulates across the run's turns until then.
    } catch (turnEndErr) {
      dbg(`turn_end crashed: ${turnEndErr}`);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      dbg(`turn_end crash stack: ${(turnEndErr as Error).stack}`);
    } finally {
      setAmbientAbortSignal(undefined);
    }
  });
}
