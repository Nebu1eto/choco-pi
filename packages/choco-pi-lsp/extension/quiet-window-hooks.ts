/**
 * agent_settled: the deferred-mutation drain, quiet-window tasks, and the turn-summary renderer/emit.
 *
 * Extracted from `runtime-extension.ts` `activateExtension`; behavior is unchanged.
 */

import type { RuntimeValue } from "../tools/runtime-values.ts";
import { isRuntimeFunction } from "../tools/runtime-values.ts";
import { loadBootstrapClients } from "../clients/bootstrap.ts";
import { reconcileCascadeNeighborLspErrors } from "../clients/widget-state.ts";
import { getFormatService } from "../clients/format-service.ts";
import { registerCascadeTierReconcileTask } from "../clients/lsp/cascade-tier.ts";
import { buildResolvedFoundCascadeRun } from "../clients/cascade-format.ts";
import { getLSPService } from "../clients/lsp/index.ts";
import { dumpActiveHandles } from "../clients/debug-handles.ts";
import { handleAgentEnd } from "../clients/runtime-agent-end.ts";
import { classifyCurrentSessionEmission } from "../clients/session-lifecycle.ts";
import {
  registerBuiltinQuietWindowTasks,
  registerQuietWindowTask,
  runQuietWindow,
} from "../clients/quiet-window.ts";
import { setAmbientAbortSignal } from "../clients/safe-spawn.ts";
import { logLatency } from "../clients/latency-logger.ts";
import { toRunnerDisplayPath } from "../clients/dispatch/runner-context.ts";
import { formatTurnSummaryLine, TURN_SUMMARY_CUSTOM_TYPE } from "../clients/turn-summary.ts";
import { renderTurnSummaryMessage } from "../clients/turn-summary-render.ts";
import type { ExtensionActivation } from "./activation.ts";
import { processState } from "./process-state.ts";
import { dbg, getStableSessionId, isStaleExtensionCtxError, notifyUi } from "./shared.ts";
import type { LspStatusTheme } from "./widget-status.ts";

/** Register the turn-summary custom message renderer. */
export function registerTurnSummaryRenderer(activation: ExtensionActivation): void {
  const { pi } = activation;
  // #484: turn-summary custom message renderer. Feature-detected — older pi
  // hosts without registerMessageRenderer simply never get a renderer
  // registered (the raw `content` fallback text still shows since sendMessage
  // itself is guarded the same way at the emit site below).
  // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
  if (isRuntimeFunction((pi as { registerMessageRenderer?: unknown }).registerMessageRenderer)) {
    try {
      pi.registerMessageRenderer(TURN_SUMMARY_CUSTOM_TYPE, renderTurnSummaryMessage);
    } catch (registerRendererErr) {
      dbg(`turn-summary renderer registration failed: ${registerRendererErr}`);
    }
  }
}

/** Register quiet-window tasks and the agent_settled hook. */
export function registerQuietWindowHooks(activation: ExtensionActivation): void {
  const {
    pi,
    runtime,
    cacheManager,
    activationState,
    getLensFlag,
    getLensFlagSource,
    updateLspStatus,
  } = activation;
  // #1654: `agent_end` fires every time pi's internal `_runAgentPrompt` loop
  // finishes A run — including a run that is about to auto-retry or resume
  // after overflow-compaction. pi computes `willRetry` only AFTER emitting
  // this event and never exposes it to extensions (source-level audit:
  // `AgentEndEvent` is `{type, messages}` only, pi agent-session.ts:643-645;
  // see node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts).
  // The #1387 deferred-format/autofix drain below therefore used to be able
  // to fire MID-RUN, between retries — formatting files the agent is still
  // actively working on, which can shift lines under queued work and stale
  // in-flight content bindings (the #1642 harm family).
  //
  // `agent_settled` is the documented once-per-run signal — "fired after an
  // agent run has fully settled and no automatic retry, compaction, or
  // queued continuation will run" (AgentSettledEvent, same types.d.ts) — so
  // the drain moves there (see the `agent_settled` registration below) and
  // is no longer run from `agent_end` at all.
  //
  // There is deliberately no capability-detection fallback back onto
  // `agent_end` for a host that never fires `agent_settled`: `pi.on`
  // registration is a silent no-op push onto a plain Map regardless of
  // whether the host will ever emit the event (see quiet-window.ts's module
  // doc), so "registration succeeded" proves nothing about whether the
  // event will actually fire — a heuristic built on that would be as
  // unreliable as no heuristic at all, and a timer-based "drain if settled
  // hasn't fired within N ms" watchdog would reintroduce this exact bug on
  // a SUPPORTED host whenever a retry/compaction cycle legitimately takes
  // longer than the watchdog window.
  //
  // There is also deliberately no separate "drain at session_shutdown"
  // safety net (review round 1, F2/F3/F4/F5): `agent_settled` is
  // documented to fire from `_runAgentPrompt`'s `finally` on normal
  // completion, on an aborted run, AND on a throw — the only way to miss it
  // is the process itself dying (a hard kill, an OOM, a host crash before
  // the finally runs), and a `session_shutdown`-based net cannot help with
  // that case either (the process is gone before any handler could run). A
  // run that dies without settling therefore strands its queued records in
  // this session's in-memory `_pendingDeferredMutations` map — but not
  // permanently: `claimDeferredMutations`'s existing staleness fallback
  // (`DEFERRED_FORMAT_STALE_AFTER_MS`, 10 minutes — the same mechanism
  // #791 already uses to recover a concurrent-secondary session's orphaned
  // records) lets the NEXT session in this process claim them as orphaned
  // once they've aged out. That is a real, honestly-documented behavior
  // change from pre-#1654 (deferred format used to run every `agent_end`,
  // so it never truly stranded), traded for correctness: it beats
  // formatting files the agent is still actively working on mid-retry.
  type DeferredDrainCtx = {
    cwd?: string;
    signal?: AbortSignal;
    ui?: {
      setStatus?: (id: string, text: string | undefined) => void;
      theme?: LspStatusTheme;
    };
  };

  async function runDeferredMutationDrain(ctx: DeferredDrainCtx): Promise<void> {
    const currentSessionId = getStableSessionId(ctx);
    // #791 defense-in-depth: mirrors how session_start already skips
    // handleSessionStart for a concurrent in-process secondary
    // (subagent) — if THIS firing is positively identified as belonging
    // to a live sibling secondary session rather than the registered
    // primary, skip the deferred-format flush entirely rather than
    // relying only on the per-record ownership filter inside
    // handleAgentEnd. Fail-safe: any inconclusive signal classifies
    // "primary" and runs as before.
    const emission = classifyCurrentSessionEmission(ctx, currentSessionId);
    if (emission === "concurrent-secondary") {
      dbg(
        `deferred_mutation_drain: concurrent secondary session detected — skipping (sessionId=${currentSessionId})`,
      );
      logLatency({
        type: "phase",
        filePath: ctx.cwd ?? "<choco-pi-lsp>",
        phase: "agent_end_concurrent_secondary_skip",
        durationMs: 0,
        metadata: { sessionId: currentSessionId },
      });
      return;
    }
    await handleAgentEnd({
      ctxCwd: ctx.cwd,
      getFlag: (name: string, filePath?: string) => getLensFlag(name, filePath),
      getFlagSource: (name: string, filePath?: string) => getLensFlagSource(name, filePath),
      notify: (msg, level) => notifyUi(ctx, msg, level),
      dbg,
      runtime,
      cacheManager,
      getFormatService: () => getFormatService(runtime.telemetrySessionId, true),
      getAutofixClients: async () => {
        const { biomeClient, ruffClient } = await loadBootstrapClients();
        return { biomeClient, ruffClient };
      },
      currentSessionId,
    });
    if (ctx.ui?.setStatus && ctx.ui.theme) {
      updateLspStatus(ctx.ui.setStatus, ctx.ui.theme);
    }
  }

  // --- Quiet window (#483): pi 0.80.6 agent_settled — fires once the whole
  // agent run (incl. any retry/continue loop) is fully idle, on both normal
  // completion and aborts (SDK finally-block). Additive to turn_end, not a
  // replacement: turn_end still settles cascade work under its own tight cap
  // so the next turn sees fresh state; this is a second, more generous
  // attempt for anything still carried over, plus other deferrable work.
  //
  // Registration is safe on older pi hosts with no `agent_settled` event:
  // the SDK's `pi.on` pushes onto a plain Map keyed by the event string with
  // no validation, so an unknown event name is simply never looked up on
  // emit — this handler would just never fire. try/catch below is
  // defensive belt-and-braces, not load-bearing.
  //
  // The SDK awaits each handler in sequence before `_runAgentPrompt`
  // returns, so this handler must NOT await the task chain itself — that
  // would hold up the host returning control (e.g. blocking the user from
  // starting a new turn). Kick it off unawaited and return immediately.
  registerBuiltinQuietWindowTasks(() => runtime);
  // #458: reconcile any cascade-lane Tier-3 touches that skipped their
  // in-lane wait (clients/lsp/cascade-tier.ts) in the same quiet window.
  // #1023: re-inject a cold-snapshot neighbor whose error resolved after the
  // turn ended through the SAME turn-end cascade seam (append a CascadeRun the
  // next turn_end merges), reusing the existing neighbor→turn-end formatting —
  // previously this outcome was logs-only, a silent under-report (#533).
  registerCascadeTierReconcileTask(() => getLSPService(), {
    onResolvedFound: ({ filePath, diagnostics }) => {
      const run = buildResolvedFoundCascadeRun(runtime.projectRoot, {
        filePath,
        diagnostics,
      });
      // #1443: the appended run outlives this turn's consumption —
      // `beginTurn` carries it into the next turn_end exactly once instead
      // of wiping it (which used to dead-end this whole delivery path).
      if (run) runtime.appendCascadeRun(run);
    },
    // #1444 (issue impact #2): the mirror case — the neighbour published
    // CLEAN after the skipped in-lane wait. The in-lane path reconciles that
    // into the footer (`reconcileCascadeNeighborLspErrors`, the #1093 seam);
    // the skipped path never could, so a fixed neighbour kept showing its old
    // errors. Errors-only MERGE, so a live warning/biome finding survives; no
    // write token exists at quiet-window time (the run is idle, nothing is
    // racing this write), and `publishedAt` stamps the real observation time.
    // Scope caveat: the touch was `clientScope: "primary"`, so this clears the
    // LSP-error entries of a multi-primary-server file on one server's clean —
    // the same errors-only tradeoff the in-lane reconcile documents.
    onResolvedClean: ({ filePath, publishedAt }) => {
      reconcileCascadeNeighborLspErrors(filePath, [], undefined, publishedAt);
    },
  });
  // #484: emit the opt-in run summary entry HERE, not at turn_end. The SDK's
  // sendCustomMessage STEERS the live model conversation when the session
  // isStreaming, and turn_end can fire mid-stream; at agent_settled the
  // session is idle, so sendMessage takes the safe append branch (persisted
  // transcript entry, rendered immediately, expandable in place). Note the
  // entry is NOT display-only: a CustomMessageEntry participates in LLM
  // context (`display` only controls TUI rendering) — its `content` reaches
  // the model as a user message on the NEXT context build, which is why
  // `content` is kept to the single collapsed line (~80 chars, an accepted
  // residue largely redundant with the #493 agent nudge); `details` (the
  // file-major expansion) never reaches the model. The collector accumulates
  // across the run's turns (never cleared at beginTurn) and is consumed
  // exactly once here; empty run ⇒ no entry, no latency phase. Task
  // contract per clients/quiet-window.ts: never throws (each task is
  // try/caught by the scheduler, and sendMessage is additionally
  // feature-detected + guarded so an older host degrades to a dbg line).
  // Registration is once-per-process (the quiet-window registry outlives
  // factory re-activation); the ctx holder keeps the closure current.
  processState.turnSummaryEmitCtx = {
    pi,
    getLensFlag: (name: string) => getLensFlag(name),
    isLensEnabled: () => activationState.lensEnabled,
  };
  if (!processState.turnSummaryEmitRegistered) {
    processState.turnSummaryEmitRegistered = true;
    registerQuietWindowTask("turn_summary_emit", () => {
      const emitCtx = processState.turnSummaryEmitCtx;
      if (!emitCtx || !emitCtx.isLensEnabled()) return;
      // The captured `pi` can go STALE between the activation that set this
      // holder and this fire-and-forget quiet-window run: an interim
      // newSession/fork/switchSession/reload invalidates the runtime, after
      // which any `pi.*` call — the getFlag below (reached first), or the
      // sendMessage later — throws the SDK's stale-ctx guard. That is benign
      // here: the session this run's summary belonged to is gone, so there is
      // nothing to emit into. Treat it as a no-op, NOT a task failure — this
      // exact throw at the flag read (outside the sendMessage try/catch)
      // spammed the live-dogfood sessionstart.log 55× as `quiet_window:
      // task "turn_summary_emit" failed` — the single most frequent error in
      // that log. A non-stale error still propagates to the scheduler so it
      // is recorded (ok:false) + logged with its stack.
      let turnSummaryEnabled: boolean | string | undefined;
      try {
        turnSummaryEnabled = emitCtx.getLensFlag("lens-turn-summary");
      } catch (err) {
        if (isStaleExtensionCtxError(err)) {
          dbg(
            "turn_summary_emit: skipped — captured pi ctx is stale (session replaced/reloaded before the quiet window ran)",
          );
          return;
        }
        throw err;
      }
      if (!turnSummaryEnabled) return;
      if (runtime.turnSummary.isEmpty()) return;
      const summaryStart = Date.now();
      const cwd = runtime.projectRoot || process.cwd();
      const details = runtime.turnSummary.consume(runtime.turnIndex, (fp) =>
        toRunnerDisplayPath(cwd, fp),
      );
      const line = formatTurnSummaryLine(details);
      // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
      const sendMessage = (emitCtx.pi as { sendMessage?: (msg: RuntimeValue) => void }).sendMessage;
      if (isRuntimeFunction(sendMessage)) {
        try {
          sendMessage.call(emitCtx.pi, {
            customType: TURN_SUMMARY_CUSTOM_TYPE,
            content: line,
            display: true,
            details,
          });
        } catch (sendErr) {
          if (isStaleExtensionCtxError(sendErr)) {
            dbg("turn_summary_emit: skipped emit — pi ctx went stale (session replaced/reloaded)");
            return;
          }
          dbg(`turn-summary sendMessage failed: ${sendErr}`);
        }
      } else {
        dbg("turn-summary: pi.sendMessage unavailable on this host, skipping emit");
      }
      logLatency({
        type: "phase",
        toolName: "agent_settled",
        filePath: cwd,
        phase: "turn_summary",
        durationMs: Date.now() - summaryStart,
        metadata: {
          files: details.files.length,
          diagnostics: details.counts.diagnostics,
          autofixes: details.counts.autofixes,
          formats: details.counts.formats,
        },
      });
    });
  }
  try {
    // SAFETY: The asserted members mirror the installed Pi host event and extension APIs; optional members are guarded before invocation.
    (pi as any).on("agent_settled", async (_event: RuntimeValue, ctx: DeferredDrainCtx) => {
      if (!activationState.lensEnabled) return;
      // #1654: the #1387 deferred-format/autofix drain runs HERE, not at
      // agent_end — see `runDeferredMutationDrain`'s doc comment above.
      // Awaited (unlike the quiet-window tasks below): this mirrors the
      // user-facing latency the drain already had pre-#1654 (it used to
      // block `agent_end` the same way), just correctly gated on true
      // settlement instead of firing mid-retry. A throw here must not
      // skip the quiet window below.
      //
      // Review round 1 (F1): `agent_settled` fires on an ABORTED run too
      // (ESC), and `ctx.signal` on that firing still reflects the
      // aborted controller. `handleAgentEnd`'s abort/requeue branches
      // (clients/runtime-agent-end.ts) read the ambient signal via
      // `getAmbientAbortSignal()`, not a parameter — exactly like
      // `agent_end`/`turn_end` already do around their own work — so an
      // ESC-aborted settle must set it here too, or every queued record
      // gets FORMATTED instead of requeued (an inversion of the #1642
      // harm this issue exists to fix) and the requeue branches become
      // production-unreachable.
      setAmbientAbortSignal(ctx?.signal);
      try {
        await runDeferredMutationDrain(ctx);
      } catch (drainErr) {
        dbg(`agent_settled deferred_mutation_drain crashed: ${drainErr}`);
      } finally {
        setAmbientAbortSignal(undefined);
      }
      void runQuietWindow({
        runtime,
        dbg,
        cwd: ctx?.cwd,
      }).catch((err) => {
        dbg(`quiet_window crashed: ${err}`);
      });
      // #1123 item 4: dump active handles AFTER the quiet-window work is
      // scheduled — the #1097-class leak (a stray ref'd timer surviving
      // past settle) is only visible once whatever settle itself queued is
      // already in flight. No-op unless CHOCO_PI_LSP_DEBUG_HANDLES=1.
      dumpActiveHandles("agent_settled");
    });
  } catch (registerErr) {
    dbg(`agent_settled registration failed (older pi host?): ${registerErr}`);
  }
}
