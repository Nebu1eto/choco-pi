import { setTimeout } from "node:timers/promises";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CompactCommandHost } from "../../../../.pi/packages/choco-pi-compaction/src/background-host/host-command.ts";
import { statusArtifact, type ArtifactInput } from "../artifacts.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import type { SeedToolResults } from "../host-seed.ts";
import {
  candidateRecordObservation,
  largePrefixObservations,
  liveUsageObservations,
  regressionFailureObservation,
  regressionNoticeObservation,
} from "./manual-compaction-verdicts.ts";
import { replyPrompt } from "./prompts.ts";
import { textAdoptionEvidence } from "./text-adoption-checks.ts";
import type { Host, Scenario } from "./types.ts";

/**
 * Manual compaction on the background lane, both ways a user can reach it:
 *
 * 1. the typed TUI command, which the compaction extension takes over at
 *    `InteractiveMode.prototype.handleCompactCommand` (no host compaction, so no
 *    "Compaction cancelled" line and no agent abort), and
 * 2. a programmatic `session.compact()` (RPC/SDK), which the extension's
 *    `AgentSession.prototype.compact` bridge takes over while idle: it resolves
 *    at once with no host compaction and no rejection (since 8003a763; it was
 *    cancelled in `session_before_compact` before).
 *
 * Both must leave a committed checkpoint that the next foreground turn carries.
 */

const TURN_1 = "HARNESS-MANUAL-TURN-1";
const TURN_2 = "HARNESS-MANUAL-TURN-2";
const TURN_3 = "HARNESS-MANUAL-TURN-3";
const TURN_4 = "HARNESS-MANUAL-TURN-4";
const TURN_5 = "HARNESS-MANUAL-TURN-5";
const SETTLE_DEADLINE_MS = 5000;
const LIVE_SETTLE_DEADLINE_MS = 180_000;
const DetailsSchema = Type.Object({ candidateId: Type.String() }, { additionalProperties: true });
/** Pi's (patched) typed-command handler, invoked the way the interactive mode does. */
interface TypedCompactPrototype {
  handleCompactCommand: (
    this: CompactCommandHost & { clearStatusIndicator(): void },
    customInstructions?: string,
  ) => Promise<void>;
}

interface Checkpoint {
  readonly id: string;
  readonly candidateId: string | undefined;
}

function checkpoints(host: Host): Checkpoint[] {
  return host.manager.getBranch().flatMap((entry) => {
    if (entry.type !== "compaction") return [];
    const details: unknown = entry.details;
    const candidateId = Value.Check(DetailsSchema, details) ? details.candidateId : undefined;
    return [{ id: entry.id, candidateId }];
  });
}

function statusOf(host: Host): ArtifactInput {
  const status = host.mainCoordinator()?.status();
  return status === undefined ? null : statusArtifact(status);
}

function state(host: Host): string {
  return host.mainCoordinator()?.status().state ?? "missing-coordinator";
}

/** Host compaction lifecycle events seen while `run` executes (the cancel line's source). */
async function hostCompactionEventsDuring(host: Host, run: () => Promise<void>): Promise<string[]> {
  const events: string[] = [];
  const unsubscribe = host.session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      events.push(event.type);
    }
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return events;
}

/**
 * Polls the real coordinator until the manual candidate is installed or the
 * route gives up, then waits for the host's own compaction lifecycle (the
 * idle-route adoption runs through `ctx.compact()`) to end so a prompt is
 * accepted again. A lane failure is followed by a fallback request on the
 * remaining lane, so `failed` only counts once it has stayed put.
 */
async function awaitInstalled(host: Host, label: string): Promise<string> {
  return awaitState(host, label, ["installed"]);
}

/** As `awaitInstalled`, but stops at a ready candidate (the hook path adopts at the next prompt). */
async function awaitReady(host: Host, label: string): Promise<string> {
  return awaitState(host, label, ["ready", "installed"]);
}

async function awaitState(host: Host, label: string, targets: readonly string[]): Promise<string> {
  const budget = host.mode === "live" ? LIVE_SETTLE_DEADLINE_MS : SETTLE_DEADLINE_MS;
  const grace = host.mode === "live" ? 2000 : 200;
  const deadline = performance.now() + budget;
  let terminalSince: number | undefined;
  for (;;) {
    const current = state(host);
    if (targets.includes(current)) break;
    if (current === "failed" || current === "idle") {
      terminalSince ??= performance.now();
      if (performance.now() - terminalSince > grace) break;
    } else terminalSince = undefined;
    if (performance.now() > deadline)
      throw new Error(`${label}: did not settle within its deadline`);
    await setTimeout(host.mode === "live" ? 100 : 5);
    if (!host.isCurrent()) throw new Error(`${label}: owner disposed`);
  }
  await awaitHostCompactionEnd(host, label);
  return state(host);
}

/** Wait for the host's own compaction lifecycle to end so a prompt is accepted again. */
async function awaitHostCompactionEnd(host: Host, label: string): Promise<void> {
  const deadline =
    performance.now() + (host.mode === "live" ? LIVE_SETTLE_DEADLINE_MS : SETTLE_DEADLINE_MS);
  while (host.session.isCompacting) {
    if (performance.now() > deadline) throw new Error(`${label}: host compaction did not end`);
    await setTimeout(5);
  }
}

/** Type `/compact` into the TUI: run the prototype method on the live session. */
async function typeCompact(host: Host): Promise<void> {
  const prototype: object = InteractiveMode.prototype;
  // SAFETY: the harness reaches the private method the bridge swaps.
  const handler = (prototype as TypedCompactPrototype).handleCompactCommand;
  await handler.call({ session: host.session, clearStatusIndicator: () => {} });
}

/** A live non-Anthropic turn rides the provider's own transport; record its outcome and usage. */
function recordProviderTurn(host: Host): void {
  const last = host.session.messages.findLast((message) => message.role === "assistant");
  if (!last || last.role !== "assistant" || last.api === "anthropic-messages") return;
  host.recorder.record("live-provider-turn", {
    transport: `${last.api} (usage from the assistant message, not the fetch ledger)`,
    stopReason: last.stopReason,
    errorMessage: last.errorMessage ?? null,
    usage: { input: last.usage.input, output: last.usage.output, cacheRead: last.usage.cacheRead },
  });
}

/** Prompt the next turn and record a provider-owned transport's outcome. */
async function nextTurn(host: Host, marker: string, ack: string, label: string): Promise<void> {
  await host.session.prompt(replyPrompt(host, marker, ack));
  if (!host.isCurrent()) throw new Error(`Owner disposed after ${label}`);
  if (host.mode === "live") recordProviderTurn(host);
}

/**
 * The next foreground request after `from` sits on `checkpointId`. Codex
 * traffic rides choco-pi-codex's WebSocket, outside the fetch ledger: there
 * the model context the host built for the turn is the observable request.
 */
function nextRequestObservation(
  host: Host,
  from: number,
  checkpointId: string | undefined,
  label: string,
): Observation {
  const sessionId = host.manager.getSessionId();
  const next = host.requestBranches
    .slice(from)
    .find((item) => item.sessionId === sessionId && !item.summary);
  if (!next) {
    const last = host.session.messages.findLast((message) => message.role === "assistant");
    if (host.mode === "live" && last?.role === "assistant" && last.api !== "anthropic-messages") {
      const first = host.manager
        .buildSessionProjection()
        .messages.find((message) => message.role !== "system");
      const summary = host.manager.getBranch().find((entry) => entry.id === checkpointId);
      const ref = host.recorder.record("provider-owned-request-context", {
        transport: last.api,
        firstRole: first?.role ?? null,
        checkpointId: checkpointId ?? null,
      });
      return {
        actual:
          first?.role === "compactionSummary" && summary?.type === "compaction"
            ? first.summary === summary.summary
            : false,
        expected: true,
        evidenceRefs: [ref],
        description: `${label}: the context built for the next turn opens with the manual checkpoint (provider-owned transport)`,
      };
    }
    return {
      actual: "missing-foreground-request",
      expected: "foreground-request",
      evidenceRefs: [host.snapshot()],
      description: `${label}: a foreground request was captured on the wire`,
    };
  }
  return {
    actual: next.checkpointId,
    expected: checkpointId,
    evidenceRefs: [next.bodyEvidenceRef, next.branchEvidenceRef],
    description: `${label}: the next foreground request sits on the manual checkpoint`,
  };
}

/** The session projection the next request is built from already starts at the checkpoint. */
function projectionObservation(host: Host, ref: number, label: string): Observation {
  const summary = host.manager.getBranch().findLast((item) => item.type === "compaction");
  const text = summary?.type === "compaction" ? summary.summary : "";
  const messages = host.manager.buildSessionProjection().messages;
  // The projection may open with a system message; the checkpoint must be the first conversational one.
  const first = messages.find((message) => message.role !== "system");
  return {
    actual: {
      role: first?.role,
      opensWithSummary:
        text.length > 0 && first?.role === "compactionSummary" && first.summary === text,
    },
    expected: { role: "compactionSummary", opensWithSummary: true },
    evidenceRefs: [ref],
    description: `${label}: the session projection opens with the committed checkpoint summary`,
  };
}

async function typedCompact(host: Host): Promise<Observation[]> {
  const before = checkpoints(host).length;
  const abortsBefore = host.aborts();
  const noticesBefore = host.adoptionNotices.length;
  const hostEvents = await hostCompactionEventsDuring(host, () => typeCompact(host));
  const afterTyped = state(host);
  const typedRef = host.recorder.record("manual-typed-compact", {
    hostEvents,
    state: afterTyped,
    status: statusOf(host),
  });
  const settled = await awaitInstalled(host, "typed /compact");
  const added = checkpoints(host).slice(before);
  const settledRef = host.recorder.record("manual-typed-settled", {
    state: settled,
    status: statusOf(host),
    checkpoints: added,
  });
  const requestsBefore = host.requestBranches.length;
  await nextTurn(host, TURN_2, "HARNESS-MANUAL-ACK-2", "the typed compaction turn");
  return [
    {
      actual: { hostEvents, state: afterTyped, aborts: host.aborts() - abortsBefore },
      // A native lane may refuse the cut at once; the fallback request follows.
      expected: {
        hostEvents: [],
        state: afterTyped === "failed" ? "failed" : "preparing",
        aborts: 0,
      },
      evidenceRefs: [typedRef],
      description: "Typed /compact started no host compaction and caused no abort",
    },
    {
      actual: {
        state: settled,
        checkpoints: added.length,
        adopted: added.every((item) => item.candidateId !== undefined),
      },
      expected: { state: "installed", checkpoints: 1, adopted: true },
      evidenceRefs: [settledRef, host.snapshot()],
      description: "Typed /compact committed exactly one background checkpoint",
    },
    {
      actual: host.adoptionNotices.slice(noticesBefore).map((item) => item.notice.route),
      expected: ["host"],
      evidenceRefs: host.adoptionNotices.slice(noticesBefore).map((item) => item.evidenceRef),
      description: "Typed /compact adoption went through the real host idle route",
    },
    projectionObservation(host, settledRef, "Typed /compact"),
    nextRequestObservation(host, requestsBefore, added[0]?.id, "Typed /compact"),
  ];
}

async function programmaticCompact(host: Host): Promise<Observation[]> {
  const before = checkpoints(host).length;
  let rejection = "";
  const hostEvents = await hostCompactionEventsDuring(host, async () => {
    try {
      await host.session.compact();
    } catch (cause) {
      rejection = cause instanceof Error ? cause.message : String(cause);
    }
  });
  const afterCall = state(host);
  const callRef = host.recorder.record("manual-programmatic-compact", {
    hostEvents,
    rejection,
    state: afterCall,
  });
  // Hook path: the checkpoint is adopted when the next prompt arrives, before it is sent.
  await awaitReady(host, "session.compact()");
  const requestsBefore = host.requestBranches.length;
  await nextTurn(host, TURN_3, "HARNESS-MANUAL-ACK-3", "the programmatic compaction turn");
  const settled = state(host);
  const added = checkpoints(host).slice(before);
  const settledRef = host.recorder.record("manual-programmatic-settled", {
    state: settled,
    status: statusOf(host),
    checkpoints: added,
  });
  return [
    {
      actual: { hostEvents, rejection, state: afterCall },
      expected: {
        hostEvents: [],
        rejection: "",
        state: afterCall === "failed" ? "failed" : "preparing",
      },
      evidenceRefs: [callRef],
      description:
        "session.compact() resolved at once with no host compaction and a background preparation started",
    },
    {
      actual: {
        state: settled,
        checkpoints: added.length,
        adopted: added.every((item) => item.candidateId !== undefined),
      },
      expected: { state: "installed", checkpoints: 1, adopted: true },
      evidenceRefs: [settledRef, host.snapshot()],
      description: "session.compact() committed exactly one background checkpoint",
    },
    projectionObservation(host, settledRef, "session.compact()"),
    nextRequestObservation(host, requestsBefore, added[0]?.id, "session.compact()"),
  ];
}

/** After a reload no provider capture exists: the native lanes are skipped and the text lane serves. */
async function reloadedCompact(host: Host): Promise<Observation[]> {
  await nextTurn(host, TURN_4, "HARNESS-MANUAL-ACK-4", "the pre-reload turn");
  await host.reload();
  const before = checkpoints(host).length;
  const hostEvents = await hostCompactionEventsDuring(host, () => typeCompact(host));
  const afterTyped = state(host);
  const typedRef = host.recorder.record("manual-reload-compact", { hostEvents, state: afterTyped });
  const settled = await awaitInstalled(host, "typed /compact after reload");
  const added = checkpoints(host).slice(before);
  const status = host.mainCoordinator()?.status();
  const settledRef = host.recorder.record("manual-reload-settled", {
    state: settled,
    status: statusOf(host),
    checkpoints: added,
  });
  const requestsBefore = host.requestBranches.length;
  await nextTurn(host, TURN_5, "HARNESS-MANUAL-ACK-5", "the reload compaction turn");
  return [
    {
      actual: { hostEvents, state: settled, checkpoints: added.length, backend: status?.backendId },
      expected: { hostEvents: [], state: "installed", checkpoints: 1, backend: "text" },
      evidenceRefs: [typedRef, settledRef, host.snapshot()],
      description: "Typed /compact after reload used the text lane and committed one checkpoint",
    },
    projectionObservation(host, settledRef, "Typed /compact after reload"),
    nextRequestObservation(host, requestsBefore, added[0]?.id, "Typed /compact after reload"),
  ];
}

async function runManual(host: Host, seed: SeedToolResults | undefined): Promise<CheckEvidence> {
  await nextTurn(host, TURN_1, "HARNESS-MANUAL-ACK-1", "the first turn");
  const typed = await typedCompact(host);
  const programmatic = await programmaticCompact(host);
  const reloaded = await reloadedCompact(host);
  const result = textAdoptionEvidence(host);
  // Every committed checkpoint of this scenario must have reached the relay consumer;
  // the shared roster is built from received notices and cannot see a lost one.
  const committed = checkpoints(host).map((item) => item.id);
  const notified = new Set(
    host.notifications
      .filter((notice) => notice.consumer === "choco-pi-compaction:adoption-relay")
      .map((notice) => notice.adoptionId.split(":").at(-2)),
  );
  const delivered: Observation = {
    actual: committed.filter((id) => !notified.has(id)),
    expected: [],
    evidenceRefs: [host.snapshot()],
    description: "Every committed manual checkpoint was delivered to the relay consumer",
  };
  result.observations["manual-background-compaction"] = [
    ...typed,
    ...programmatic,
    ...reloaded,
    delivered,
    regressionNoticeObservation(host),
    regressionFailureObservation(host),
    candidateRecordObservation(host),
    ...(seed === undefined ? [] : largePrefixObservations(host, seed)),
    ...(await liveUsageObservations(host)),
  ];
  return result;
}

/**
 * Large seed: 40 step results of 22,000 chars (880,000 chars) after the
 * 3 x 20,000-char padded prefix, a raw chars/4 estimate near 235,000 tokens.
 * The pre-fix gate compared that raw figure with a flat 200,000 and refused
 * the cut as `oversized`; the rendered summary prompt cuts each result to
 * 2,000 chars (~140,000 chars in all), which fits every subject's window.
 */
export const MANUAL_LARGE_SEED: SeedToolResults = { count: 40, chars: 22_000 };
const SEED_BYTES = 20_000;

function manualScenario(
  name: string,
  description: string,
  seed: SeedToolResults | undefined,
): Scenario {
  const result: Scenario = {
    name,
    description,
    // prepareAt 0.99: only the manual requests start a preparation. Every native
    // lane is on, as the vendor rows derive them in production: a Codex-owned
    // model has no background lane at all when codexNative is off.
    settings: {
      enabled: true,
      text: true,
      codexNative: true,
      anthropicNative: true,
      minReductionTokens: 0,
      prepareAt: 0.99,
    },
    seedBytes: SEED_BYTES,
    hostCompaction: true,
    providerOwnedTransport: true,
    checks: ["manual-background-compaction", "consumers-notified-once"],
    markers: [TURN_1, TURN_2, TURN_3, TURN_4, TURN_5],
    execute: (host) => runManual(host, seed),
  };
  if (seed !== undefined) result.seedToolResults = { ...seed };
  return result;
}

export const scenario: Scenario = manualScenario(
  "manual-background-compaction",
  "Typed /compact (TUI bridge) and session.compact() (hook) both continue in the background",
  undefined,
);

export const largeScenario: Scenario = manualScenario(
  "manual-background-compaction-large",
  "The manual flow over a prefix whose raw estimate exceeds the pre-fix flat 200,000-token gate",
  MANUAL_LARGE_SEED,
);
