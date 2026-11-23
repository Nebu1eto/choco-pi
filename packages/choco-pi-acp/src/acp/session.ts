import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  CreateElicitationRequest,
  CreateElicitationResponse,
  McpServer,
  SessionUpdate,
  ContentBlock,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { PiRpcProcessLike, PiRpcExit, PiRpcEvent } from "../pi-rpc/process.ts";
import { type FileSlashCommand, expandSlashCommand } from "./slash-commands.ts";
import { ToolPresentationTracker } from "../translate/tool-presentation.ts";
import { TextBoundary } from "./text-boundary.ts";
import {
  type PendingExtensionUi,
  BoundedRequestIdTombstones,
  ExtensionUiBridge,
} from "./session-extension-ui.ts";
import type {
  PiPromptImage,
  PiAssistantToolCall,
  PiAssistantMessageEvent,
  PiAutoRetryStartEvent,
} from "../pi-rpc/protocol.ts";
import {
  type BashToolCallParams,
  bashToolCallUpdate,
  type BashOutputParams,
  bashOutputUpdate,
  streamedToolArguments,
  toToolCallLocations,
  boundedToolRawInput,
  toToolKind,
  toolCallMeta,
  getToolPath,
  getEditOldTexts,
  findUniqueLineNumber,
  type ToolCallUpdateNotification,
} from "./session-tool-calls.ts";
import { bashResultText, bashOutputDelta, isBashTool, bashExitCode } from "./translate/bash.ts";
import { maybeAuthRequiredError } from "./auth-required.ts";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import { toolResultToText } from "./translate/pi-tools.ts";
import { isFiniteNumber } from "../boundary.ts";
import {
  type PendingTurn,
  type QueuedTurn,
  settleTurn,
  type TurnSettlement,
} from "./session-turns.ts";

export {
  DEFAULT_PI_ACP_MAX_LIVE_SESSIONS,
  DEFAULT_PI_ACP_SESSION_IDLE_MS,
  PI_ACP_MAX_LIVE_SESSIONS,
  boundedSessionIdleMs,
  PI_ACP_SESSION_IDLE_MS,
  SessionManager,
} from "./session-manager.ts";

export { sanitizeExtensionUiText } from "./session-extension-ui.ts";

export type AcpConnection = {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  unstable_createElicitation?(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
};

export type StopReason = "end_turn" | "cancelled" | "error";

const MAX_QUEUED_TURNS = 64;
const PI_EXIT_EMIT_DRAIN_MS = 100;

export class PiAcpSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mcpServers: McpServer[];

  private startupInfo: string | null = null;
  private startupInfoSent = false;

  readonly proc: PiRpcProcessLike;
  private readonly conn: AcpConnection;
  private readonly fileCommands: FileSlashCommand[];
  private unsubscribeProcExit: () => void = () => {};

  private cancelRequested = false;

  private pendingTurn: PendingTurn | null = null;
  private readonly turnQueue: QueuedTurn[] = [];
  private turnQueueClosedError: Error | null = null;
  private currentToolCalls = new Map<string, "pending" | "in_progress">();

  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>();
  private fileMutationToolCallIds = new Set<string>();
  private bashToolCallIds = new Set<string>();
  private bashOutputSnapshots = new Map<string, string>();
  private readonly toolPresentations = new ToolPresentationTracker();

  private lastEmit: Promise<void> = Promise.resolve();
  private readonly emitDrain = {
    abandoned: false,
    release: Promise.withResolvers<void>(),
  };
  private readonly textBoundary = new TextBoundary();
  private assistantMessageSeq = 0;
  private extensionUiGeneration = 0;
  private extensionUiActive = true;
  private readonly pendingExtensionUi = new Map<string, PendingExtensionUi>();
  private readonly extensionUiTaskState = { active: 0 };
  private readonly settledExtensionUi = new BoundedRequestIdTombstones();
  private readonly extensionUi: ExtensionUiBridge;
  private readonly idleMs: number | undefined;
  private readonly onIdle: (() => void) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleGeneration = 0;

  constructor(opts: {
    sessionId: string;
    cwd: string;
    mcpServers: McpServer[];
    proc: PiRpcProcessLike;
    conn: AcpConnection;
    fileCommands?: FileSlashCommand[];
    idleMs?: number;
    onIdle?: () => void;
  }) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];
    this.idleMs = opts.idleMs;
    this.onIdle = opts.onIdle;
    this.extensionUi = new ExtensionUiBridge({
      sessionId: this.sessionId,
      conn: this.conn,
      proc: this.proc,
      pendingExtensionUi: this.pendingExtensionUi,
      settledExtensionUi: this.settledExtensionUi,
      isActive: () => this.extensionUiActive,
      generation: () => this.extensionUiGeneration,
      emit: (update) => this.emit(update),
    });

    this.proc.onEvent((ev) => this.handlePiEvent(ev));
    this.unsubscribeProcExit = this.proc.onExit?.((exit) => this.handlePiExit(exit)) ?? (() => {});
    this.armIdleTimer();
  }

  activate(): void {
    this.cancelIdleTimer();
    this.armIdleTimer();
  }

  markIdle(): void {
    this.armIdleTimer();
  }

  reap(): void {
    this.cancelIdleTimer();
    const proc = this.proc;
    void this.closeExtensionUi().finally(() => void proc.shutdown?.());
  }

  private cancelIdleTimer(): void {
    this.idleGeneration += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdleTimer(): void {
    if (
      this.idleMs === undefined ||
      this.onIdle === undefined ||
      !this.extensionUiActive ||
      this.pendingTurn ||
      this.turnQueue.length > 0
    ) {
      return;
    }
    this.cancelIdleTimer();
    const generation = this.idleGeneration;
    const onIdle = this.onIdle;
    const timer = setTimeout(() => {
      if (
        this.idleTimer !== timer ||
        this.idleGeneration !== generation ||
        this.pendingTurn ||
        this.turnQueue.length > 0
      ) {
        return;
      }
      this.idleTimer = null;
      onIdle();
    }, this.idleMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  setStartupInfo(text: string) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }

  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;

    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo },
    });
  }

  async prompt(message: string, images: PiPromptImage[] = []): Promise<StopReason> {
    this.activate();
    const expandedMessage = expandSlashCommand(message, this.fileCommands);

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject };
      if (this.turnQueueClosedError) {
        reject(this.turnQueueClosedError);
        return;
      }

      if (this.pendingTurn) {
        if (this.turnQueue.length >= MAX_QUEUED_TURNS) {
          reject(
            new Error(
              `Pi ACP turn queue is full (maximum ${MAX_QUEUED_TURNS} queued prompts). Wait for a queued prompt to complete before sending another.`,
            ),
          );
          return;
        }
        this.turnQueue.push(queued);

        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Queued message (position ${this.turnQueue.length}).`,
          },
        });

        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
        });

        return;
      }

      this.startTurn(queued);
    });

    return turnPromise;
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const turn of queued) settleTurn(turn, { type: "resolve", reason: "cancelled" });

      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." },
      });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } },
      });
    }

    await this.proc.abort?.();
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested;
  }

  beginClientPrompt(): void {
    this.textBoundary.reset();
  }

  async sendUpdate(update: SessionUpdate): Promise<void> {
    const drain = this.emitDrain;
    if (drain.abandoned) return;
    const conn = this.conn;
    const sessionId = this.sessionId;
    const prepared = this.textBoundary.apply(update);
    const delivery = this.lastEmit.then(() => {
      if (drain.abandoned) return;
      return conn.sessionUpdate({ sessionId, update: prepared });
    });
    this.lastEmit = delivery.catch(() => {});
    await delivery;
  }

  async closeExtensionUi(): Promise<void> {
    this.cancelIdleTimer();
    if (!this.extensionUiActive) return;
    this.extensionUiActive = false;
    this.extensionUiGeneration += 1;
    const pending = [...this.pendingExtensionUi.entries()];
    this.pendingExtensionUi.clear();
    const proc = this.proc;
    for (const [id, entry] of pending) {
      this.settledExtensionUi.add(id);
      clearTimeout(entry.timer);
      entry.release();
      try {
        void proc.sendExtensionUiResponse?.({ id, cancelled: true }).catch(() => {});
      } catch {}
    }
  }

  private emit(update: SessionUpdate, source?: string): void {
    const drain = this.emitDrain;
    if (drain.abandoned) return;
    const conn = this.conn;
    const sessionId = this.sessionId;
    const prepared = this.textBoundary.apply(update, source);
    this.lastEmit = this.lastEmit
      .then(() => {
        if (drain.abandoned) return;
        return conn.sessionUpdate({ sessionId, update: prepared });
      })
      .catch(() => {});
  }

  private async flushEmits(): Promise<void> {
    const emits = this.lastEmit;
    const released = this.emitDrain.release.promise;
    await Promise.race([emits, released]);
  }

  private emitBashToolCall(params: BashToolCallParams): void {
    this.bashToolCallIds.add(params.toolCallId);
    this.emit(bashToolCallUpdate(params, this.cwd));
  }

  private emitBashOutputUpdate(params: BashOutputParams): void {
    const text = params.textOverride ?? bashResultText(params.result);
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text);
    this.bashOutputSnapshots.set(params.toolCallId, text);
    this.emit(bashOutputUpdate(params, delta));
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId);
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }

  private settlePendingTurn(
    settlement: TurnSettlement,
    options: { startNext?: boolean; queuedSettlement?: TurnSettlement } = {},
  ): void {
    if (options.queuedSettlement) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const turn of queued) settleTurn(turn, options.queuedSettlement);
    }

    const pending = this.pendingTurn;
    if (!pending || pending.settling) return;
    pending.settling = true;
    void this.flushEmits().finally(() => {
      if (this.pendingTurn !== pending || !pending.settling) return;
      this.pendingTurn = null;
      settleTurn(pending, settlement);

      if (options.startNext) {
        const next = this.turnQueue.shift();
        if (next) {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Starting queued message. (${this.turnQueue.length} remaining)`,
            },
          });
          this.startTurn(next);
          return;
        }
      }

      this.emit({
        sessionUpdate: "session_info_update",
        _meta: {
          piAcp: { queueDepth: this.turnQueue.length, running: false },
        },
      });
      this.armIdleTimer();
    });
  }

  private handlePiExit(exit: PiRpcExit): void {
    this.cancelIdleTimer();
    const unsubscribe = this.unsubscribeProcExit;
    this.unsubscribeProcExit = () => {};
    unsubscribe();

    this.turnQueueClosedError = new Error(
      `pi process exited (code=${exit.code}, signal=${exit.signal})`,
    );
    const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
    const settlement: TurnSettlement = { type: "resolve", reason };
    const drain = this.emitDrain;
    const emits = this.lastEmit;
    const timer = setTimeout(() => {
      drain.abandoned = true;
      drain.release.resolve();
    }, PI_EXIT_EMIT_DRAIN_MS);
    void emits.then(() => clearTimeout(timer));
    this.settlePendingTurn(settlement, { queuedSettlement: settlement });
    void this.closeExtensionUi();
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false;
    const turn: PendingTurn = {
      resolve: t.resolve,
      reject: t.reject,
      settling: false,
      acknowledged: false,
    };
    this.pendingTurn = turn;
    const ownsTurn = (): boolean => this.pendingTurn === turn && !turn.settling;
    const acknowledge = (): void => {
      turn.acknowledged = true;
    };

    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } },
    });

    this.proc.prompt(t.message, t.images, { onResponseFrame: acknowledge }).then(
      (disposition) => {
        acknowledge();
        if (disposition !== "handled" || !ownsTurn()) return;
        const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn";
        this.settlePendingTurn({ type: "resolve", reason }, { startNext: true });
      },
      (err) => {
        acknowledge();
        if (!ownsTurn()) return;
        const authErr = maybeAuthRequiredError(err);
        let settlement: TurnSettlement;
        if (authErr) {
          settlement = { type: "reject", error: authErr };
        } else {
          const reason: StopReason = this.cancelRequested ? "cancelled" : "error";
          settlement = { type: "resolve", reason };
        }
        this.settlePendingTurn(settlement, { queuedSettlement: settlement });
      },
    );
  }

  private handleStreamedToolCall(toolCall: PiAssistantToolCall | undefined): void {
    const toolCallId = toolCall?.id ?? "";
    const toolName = toolCall?.name ?? "tool";
    if (!toolCallId) return;

    const rawInput = streamedToolArguments(toolCall);
    const normalized = this.toolPresentations.start({
      toolCallId,
      toolName,
      args: rawInput,
      cwd: this.cwd,
    });
    const locations = normalized.presentation.locations ?? toToolCallLocations(rawInput, this.cwd);
    const boundedInput = boundedToolRawInput(rawInput);
    const existingStatus = this.currentToolCalls.get(toolCallId);
    const status = existingStatus ?? "pending";

    if (isBashTool(toolName)) {
      if (!existingStatus) this.currentToolCalls.set(toolCallId, "pending");
      this.emitBashToolCall({
        sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
        toolCallId,
        toolName,
        args: rawInput,
        status,
        locations,
        includeTerminal: !existingStatus,
        presentation: normalized.presentation,
      });
      return;
    }

    if (!existingStatus) {
      this.currentToolCalls.set(toolCallId, "pending");
      this.emit({
        sessionUpdate: "tool_call",
        toolCallId,
        title: normalized.presentation.title ?? toolName,
        kind: toToolKind(toolName),
        status,
        locations,
        rawInput: boundedInput.rawInput,
        _meta: toolCallMeta(normalized.presentation, boundedInput),
      });
      return;
    }

    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status,
      locations,
      rawInput: boundedInput.rawInput,
      _meta: toolCallMeta(normalized.presentation, boundedInput),
    });
  }

  private handleAssistantMessageEvent(ame: PiAssistantMessageEvent | undefined): void {
    if (ame === undefined) return;
    const source = `assistant:${this.assistantMessageSeq}`;

    if (ame.type === "text_delta") {
      this.emit(
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: ame.delta } satisfies ContentBlock,
        },
        source,
      );
      return;
    }

    if (ame.type === "thinking_delta") {
      this.emit(
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: ame.delta } satisfies ContentBlock,
        },
        source,
      );
      return;
    }

    if (
      ame.type === "toolcall_start" ||
      ame.type === "toolcall_delta" ||
      ame.type === "toolcall_end"
    ) {
      this.handleStreamedToolCall(ame.toolCall);
    }
  }

  private handlePiEvent(ev: PiRpcEvent): void {
    switch (ev.type) {
      case "message_update": {
        this.handleAssistantMessageEvent(ev.assistantMessageEvent);
        break;
      }

      case "tool_execution_start": {
        const toolCallId = ev.toolCallId ?? crypto.randomUUID();
        const toolName = ev.toolName ?? "tool";
        const args = ev.args;
        const normalized = this.toolPresentations.start({
          toolCallId,
          toolName,
          args,
          cwd: this.cwd,
        });
        let line: number | undefined;

        if (isBashTool(toolName)) {
          const locations =
            normalized.presentation.locations ?? toToolCallLocations(args, this.cwd);
          const existingStatus = this.currentToolCalls.get(toolCallId);
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
            toolCallId,
            toolName,
            args,
            status: "in_progress",
            locations,
            includeTerminal: !existingStatus,
            presentation: normalized.presentation,
          });
          break;
        }

        const isFileMutation = toolName === "edit" || toolName === "write";
        let snapshotOldText: string | null | undefined;
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId);
          const p = getToolPath(args);
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
              snapshotOldText = readFileSync(abs, "utf8");
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText });

              if (toolName === "edit") {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle);
                  if (line !== undefined) break;
                }
              }
            } catch {
              snapshotOldText = null;
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null });
            }
          }
        }

        const locations =
          line === undefined
            ? (normalized.presentation.locations ?? toToolCallLocations(args, this.cwd))
            : toToolCallLocations(args, this.cwd, line);
        const boundedInput = boundedToolRawInput(args);

        const alreadySurfaced = this.currentToolCalls.has(toolCallId);
        this.currentToolCalls.set(toolCallId, "in_progress");
        if (alreadySurfaced) {
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            locations,
            rawInput: boundedInput.rawInput,
            _meta: toolCallMeta(normalized.presentation, boundedInput),
          });
        } else {
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: normalized.presentation.title ?? toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: boundedInput.rawInput,
            _meta: toolCallMeta(normalized.presentation, boundedInput),
          });
        }

        break;
      }

      case "tool_execution_update": {
        const toolCallId = ev.toolCallId ?? "";
        if (!toolCallId) break;

        const partial = ev.partialResult;
        let normalized = this.toolPresentations.update({ toolCallId, result: partial });
        if (!normalized && this.toolPresentations.isTerminal(toolCallId)) break;
        if (normalized?.text === undefined) {
          normalized =
            this.toolPresentations.update({
              toolCallId,
              result: toolResultToText(partial),
            }) ?? normalized;
        }
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: "in_progress",
            result: partial,
            textOverride: normalized?.text,
            presentation: normalized?.presentation,
          });
          break;
        }

        const isFileMutation = this.fileMutationToolCallIds.has(toolCallId);
        const text = isFileMutation ? "" : (normalized?.text ?? toolResultToText(partial));

        const update: ToolCallUpdateNotification = {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: text
            ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
            : undefined,
          _meta: normalized ? { editorToolPresentation: normalized.presentation } : undefined,
        };
        if (!isFileMutation) update.rawOutput = partial;
        this.emit(update);
        break;
      }

      case "tool_execution_end": {
        const toolCallId = ev.toolCallId ?? "";
        if (!toolCallId) break;

        const result = ev.result;
        const isError = ev.isError ?? false;
        if (this.toolPresentations.isTerminal(toolCallId)) break;
        this.toolPresentations.update({ toolCallId, result: toolResultToText(result) });
        const normalized = this.toolPresentations.end({ toolCallId, result, isError });
        const presentationDiffs = isError
          ? undefined
          : normalized?.presentation.diffs?.slice(0, 256);
        if (presentationDiffs?.length) {
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
            content: presentationDiffs.map(({ path, oldText, newText }) => ({
              type: "diff" as const,
              path,
              oldText,
              newText,
            })),
            locations: normalized?.presentation.locations,
            _meta: { editorToolPresentation: normalized?.presentation },
          });
          this.cleanupToolCall(toolCallId);
          break;
        }
        if (this.bashToolCallIds.has(toolCallId)) {
          if (normalized?.presentation.terminal) {
            normalized.presentation.terminal.exitCode = bashExitCode(result, isError);
          }
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? "failed" : "completed",
            result,
            textOverride: normalized?.text,
            isError,
            presentation: normalized?.presentation,
            locations: normalized?.presentation.locations,
          });
          this.cleanupToolCall(toolCallId);
          break;
        }

        const text = toolResultToText(result);

        const snapshot = this.fileSnapshots.get(toolCallId);
        let content: ToolCallContent[] | undefined;
        let hasStructuredDiff = false;

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path)
              ? snapshot.path
              : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync(abs, "utf8");
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true;
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText,
                },
              ];
            }
          } catch {}
        }

        if (!content && !hasStructuredDiff && text) {
          content = [
            { type: "content", content: { type: "text", text } },
          ] satisfies ToolCallContent[];
        }

        const update: ToolCallUpdateNotification = {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          locations: normalized?.presentation.locations,
          _meta: normalized ? { editorToolPresentation: normalized.presentation } : undefined,
        };
        if (!hasStructuredDiff) update.rawOutput = result;
        this.emit(update);

        this.cleanupToolCall(toolCallId);
        break;
      }

      case "extension_ui_request": {
        const taskState = this.extensionUiTaskState;
        const task = this.extensionUi.handleExtensionUiRequest(ev);
        taskState.active += 1;
        void task.then(
          () => {
            taskState.active -= 1;
          },
          () => {
            taskState.active -= 1;
          },
        );
        break;
      }

      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) } satisfies ContentBlock,
        });
        break;
      }

      case "auto_retry_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." } satisfies ContentBlock,
        });
        break;
      }

      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction...",
          } satisfies ContentBlock,
        });
        break;
      }

      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session.",
          } satisfies ContentBlock,
        });
        break;
      }

      case "agent_start": {
        break;
      }

      case "turn_end": {
        break;
      }

      case "agent_end": {
        break;
      }

      case "agent_settled": {
        if (this.pendingTurn && !this.pendingTurn.acknowledged) break;
        const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn";
        this.settlePendingTurn({ type: "resolve", reason }, { startNext: true });
        break;
      }

      case "unknown_event": {
        if (ev.eventType === "message_start" || ev.eventType === "message_end") {
          this.assistantMessageSeq += 1;
        }
        break;
      }

      default:
        break;
    }
  }
}

function formatAutoRetryMessage(ev: PiAutoRetryStartEvent): string {
  const attempt = ev.attempt;
  const maxAttempts = ev.maxAttempts;
  const delayMs = ev.delayMs;

  if (!isFiniteNumber(attempt) || !isFiniteNumber(maxAttempts) || !isFiniteNumber(delayMs)) {
    return "Retrying...";
  }

  let delaySeconds = Math.round(delayMs / 1000);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}
