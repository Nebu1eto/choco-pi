import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { Type } from "typebox";

import { inChildSessionContext } from "../../choco-pi-subagents/src/child-context.ts";
import { isRegisteredChildSession } from "./child-session.ts";
import { ShellNotificationGate } from "./notification-gate.ts";
import { ShellManager } from "./shell-manager.ts";
import type { ReadShellResult, ShellChangeEvent, ShellResult } from "./shell-manager.ts";
import { isStaleContextError, type RuntimeValue } from "./lifecycle.ts";
import {
  lifecycleKindForChange,
  SHELL_LIFECYCLE_CHANNELS,
  shellLifecyclePayload,
  type ShellLifecycleKind,
  type ShellLifecyclePayload,
} from "./lifecycle-events.ts";
import { openShellsOverlay, type ShellsUICtx } from "./ui/shells-overlay.ts";
import { createShellSectionProvider, findShellSectionHost } from "./ui/shell-section.ts";
import type { ShellSectionRegistration } from "../../choco-pi-subagents/src/ui/shell-section-contract.ts";

const MANAGER_KEY = Symbol.for("choco-pi-shells:manager");
const COMPLETION_TAIL_CHARACTERS = 480;
const COMPLETION_TAIL_BYTES = 2_048;
const SHELL_NOTIFICATION_TYPE = "shell-completion-notification";

export interface ShellCompletionDetails {
  shells: Array<{
    shellId: string;
    name?: string;
    state: ShellResult["state"];
    exitCode?: number;
    signal?: NodeJS.Signals;
    error?: string;
    stdout: CompletionStreamDetails;
    stderr: CompletionStreamDetails;
  }>;
}

interface CompletionStreamDetails {
  tail: string;
  startOffset: number;
  nextOffset: number;
  endOffset: number;
  dropped: boolean;
}

interface StatusPresentation {
  icon: string;
  color: "success" | "error" | "dim";
  label: string;
}

export interface ShellNotificationTheme {
  fg: Theme["fg"];
  bold: Theme["bold"];
  getBgAnsi?: Theme["getBgAnsi"];
}

function lastCharacters(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  const characters = Array.from(value);
  return characters.length <= maximum ? value : characters.slice(-maximum).join("");
}

function boundGroupedTails(shells: ShellCompletionDetails["shells"]): void {
  let remaining = COMPLETION_TAIL_CHARACTERS;
  for (const shell of shells) {
    for (const stream of [shell.stdout, shell.stderr]) {
      stream.tail = lastCharacters(stream.tail, remaining);
      remaining -= Array.from(stream.tail).length;
    }
  }
}

function completionStream(
  stream: ReadShellResult["stdout"],
  tail: string,
): CompletionStreamDetails {
  return {
    tail,
    startOffset: stream.startOffset,
    nextOffset: stream.nextOffset,
    endOffset: stream.endOffset,
    dropped: stream.dropped,
  };
}

export function buildCompletionDetails(
  manager: ShellManager,
  shell: ShellResult,
): ShellCompletionDetails["shells"][number] {
  const metadata = manager.read({
    requesterId: shell.ownerId,
    isAdmin: false,
    shellId: shell.shellId,
    maxBytes: 1,
  });
  const output = manager.read({
    requesterId: shell.ownerId,
    isAdmin: false,
    shellId: shell.shellId,
    stdoutOffset: Math.max(
      metadata.stdout.startOffset,
      metadata.stdout.endOffset - COMPLETION_TAIL_BYTES,
    ),
    stderrOffset: Math.max(
      metadata.stderr.startOffset,
      metadata.stderr.endOffset - COMPLETION_TAIL_BYTES,
    ),
    maxBytes: COMPLETION_TAIL_BYTES,
  });
  const hasBoth = output.stdout.data.length > 0 && output.stderr.data.length > 0;
  const stdoutLimit = hasBoth ? COMPLETION_TAIL_CHARACTERS / 2 : COMPLETION_TAIL_CHARACTERS;
  const stdoutTail = lastCharacters(output.stdout.data, stdoutLimit);
  const remaining = COMPLETION_TAIL_CHARACTERS - Array.from(stdoutTail).length;
  const stderrTail = lastCharacters(output.stderr.data, remaining);
  return {
    shellId: shell.shellId,
    ...(shell.name !== undefined && { name: shell.name }),
    state: shell.state,
    ...(shell.exitCode !== undefined && { exitCode: shell.exitCode }),
    ...(shell.signal !== undefined && { signal: shell.signal }),
    ...(shell.error !== undefined && { error: shell.error }),
    stdout: completionStream(output.stdout, stdoutTail),
    stderr: completionStream(output.stderr, stderrTail),
  };
}

function statusPresentation(state: ShellResult["state"]): StatusPresentation {
  if (state === "exited") return { icon: "✓", color: "success", label: "Completed" };
  if (state === "stopped") return { icon: "■", color: "dim", label: "Stopped" };
  return { icon: "✗", color: "error", label: "Failed" };
}

export function renderShellCompletion(
  details: ShellCompletionDetails,
  theme: ShellNotificationTheme,
): string {
  return details.shells
    .map((shell) => {
      const status = statusPresentation(shell.state);
      const metadata = [
        shell.name ?? shell.shellId,
        shell.exitCode === undefined ? undefined : `exit ${shell.exitCode}`,
        shell.signal,
      ].filter(Boolean);
      const tail = [shell.stdout.tail, shell.stderr.tail]
        .filter(Boolean)
        .join(" | ")
        .replace(/\s+/g, " ");
      const background =
        theme.getBgAnsi?.(shell.state === "failed" ? "toolErrorBg" : "toolSuccessBg") ?? "";
      const outputColor = shell.state === "failed" ? "error" : "toolOutput";
      const lines = [
        "",
        ` ${theme.fg("dim", "•")} ${theme.fg(status.color, status.icon)} ${theme.fg("toolTitle", theme.bold(`Shell: ${status.label}`))}`,
        `    ${theme.fg("dim", "└ ")}${theme.fg("accent", metadata.join(" · "))}`,
        ...(tail ? [theme.fg(outputColor, `      ${tail}`)] : []),
        "",
      ];
      return lines.map((line) => background + line).join("\n");
    })
    .join("\n");
}

interface ProcessRegistry {
  [MANAGER_KEY]?: ShellManager;
}

function jsonResult<Result>(value: Result) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2) ?? "null",
      },
    ],
    details: value,
  };
}

const StartSchema = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      description:
        "Long-running shell command to run in the background. Leave stdout and stderr unredirected: the manager captures both for shell_read and the Shells viewer, and output redirected to a file is invisible there. Use `| tee file` when a file copy is also needed.",
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Working directory; relative paths resolve from the calling session cwd.",
      }),
    ),
    name: Type.Optional(Type.String({ minLength: 1, description: "Optional display name." })),
  },
  { additionalProperties: false },
);

const ReadSchema = Type.Object(
  {
    shell_id: Type.String({ minLength: 1, description: "Managed shell identifier." }),
    stdout_offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Absolute stdout byte cursor returned as stdout.nextOffset by a prior read.",
      }),
    ),
    stderr_offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Absolute stderr byte cursor returned as stderr.nextOffset by a prior read.",
      }),
    ),
    max_bytes: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 262_144,
        description: "Maximum bytes returned from each stream.",
      }),
    ),
  },
  { additionalProperties: false },
);

const StopSchema = Type.Object(
  {
    shell_id: Type.String({ minLength: 1, description: "Managed shell identifier to stop." }),
  },
  { additionalProperties: false },
);

const ListSchema = Type.Object({}, { additionalProperties: false });

export default function shellsExtension(pi: ExtensionAPI): void {
  // Child identity latches one way: the async-context marker is checked at load, and the
  // subagents registry is probed for every session id this activation observes. The
  // registry drops a child id before its session_shutdown, so the latch must already be
  // set by session_start; a child must never be treated as the process-singleton owner.
  const loadedInChildContext = inChildSessionContext();
  let isChildActivation = loadedInChildContext;
  const isChildSession = (sessionId: string): boolean => {
    if (!isChildActivation && isRegisteredChildSession(sessionId)) isChildActivation = true;
    return isChildActivation;
  };
  const adminFor = (sessionId: string): boolean => !isChildSession(sessionId);
  // SAFETY: Symbol.for provides the process-wide slot used only for ShellManager instances here.
  const registry = globalThis as typeof globalThis & ProcessRegistry;

  let manager = registry[MANAGER_KEY];
  if (!manager) {
    manager = new ShellManager();
    registry[MANAGER_KEY] = manager;
  }

  let shellSectionProvider: ReturnType<typeof createShellSectionProvider> | undefined;
  let shellSectionRegistration: ShellSectionRegistration | undefined;
  let rootSessionId: string | undefined;
  let rootUI: ShellsUICtx | undefined;
  let currentSessionId: string | undefined;
  let shuttingDown = false;

  const flushCompletions = (completed: ShellResult[]): void => {
    if (shuttingDown) {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    }
    if (completed.length === 0) return;
    const shells = completed.map((shell) => buildCompletionDetails(manager, shell));
    if (shells.length === 0) return;
    boundGroupedTails(shells);
    const details: ShellCompletionDetails = { shells };
    try {
      pi.sendMessage<ShellCompletionDetails>(
        {
          customType: SHELL_NOTIFICATION_TYPE,
          content: `<shell-completion>${JSON.stringify(details)}</shell-completion>\nUse shell_read with the reported cursors only when more output is needed.`,
          display: true,
          details,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    } catch (error) {
      // Session replacement or reload can stale this ctx without session_shutdown
      // firing before the debounced timer. Contain only the canonical stale-context
      // error and stop scheduling flushes for the dead runtime; rethrow the rest.
      // SAFETY: catch produces unknown; the helper narrows via instanceof before reading the message.
      if (!isStaleContextError(error as RuntimeValue)) throw error;
      shuttingDown = true;
      throw error;
    }
  };

  const notificationGate = new ShellNotificationGate({
    manager,
    flush: flushCompletions,
    appendEntry: (type, data) => pi.appendEntry(type, data),
  });

  const unsubscribeCompletions = manager.onChange((event: ShellChangeEvent) => {
    if (
      event.type !== "end" ||
      shuttingDown ||
      currentSessionId === undefined ||
      event.shell.ownerId !== currentSessionId
    )
      return;
    notificationGate.enqueue(event.shell);
  });

  // Lifecycle events stay attached through quit/child cleanup so stop transitions
  // are still published; they detach synchronously on every other shutdown path.
  let lifecycleEventsActive = true;
  const emitLifecycle = (kind: ShellLifecycleKind, payload: ShellLifecyclePayload): void => {
    if (!lifecycleEventsActive) return;
    try {
      pi.events.emit(SHELL_LIFECYCLE_CHANNELS[kind], payload);
    } catch (error) {
      // SAFETY: catch produces unknown; the helper narrows via instanceof before reading the message.
      if (isStaleContextError(error as RuntimeValue)) {
        detachLifecycle();
        return;
      }
      // ShellManager swallows listener exceptions so its lifecycle cannot be
      // interrupted; rethrow unrelated failures outside that boundary instead.
      queueMicrotask(() => {
        throw error;
      });
    }
  };
  const unsubscribeLifecycle = manager.onChange((event: ShellChangeEvent) => {
    if (
      !lifecycleEventsActive ||
      currentSessionId === undefined ||
      event.shell.ownerId !== currentSessionId
    )
      return;
    const kind = lifecycleKindForChange(event);
    if (kind === undefined) return;
    emitLifecycle(
      kind,
      shellLifecyclePayload(event.shell, manager.toolCallIdOf(event.shell.shellId)),
    );
  });
  const detachLifecycle = (): void => {
    lifecycleEventsActive = false;
    unsubscribeLifecycle();
  };
  const emitLostForOwner = (ownerId: string | undefined): void => {
    if (ownerId === undefined) return;
    for (const shell of manager.list({ requesterId: ownerId, isAdmin: false }).shells) {
      if (shell.state !== "running") continue;
      emitLifecycle("lost", shellLifecyclePayload(shell, manager.toolCallIdOf(shell.shellId)));
    }
  };

  pi.registerMessageRenderer<ShellCompletionDetails>(
    SHELL_NOTIFICATION_TYPE,
    (message, _options, theme) =>
      message.details ? new Text(renderShellCompletion(message.details, theme), 0, 0) : undefined,
  );

  const bindRootUI = (ui: ShellsUICtx, sessionId: string): void => {
    if (isChildActivation) return;
    rootUI = ui;
    if (!shellSectionProvider || rootSessionId !== sessionId) {
      shellSectionRegistration?.unregister();
      shellSectionProvider?.dispose();
      shellSectionRegistration = undefined;
      rootSessionId = sessionId;
      shellSectionProvider = createShellSectionProvider({ manager, rootSessionId: sessionId });
    }
    if (!shellSectionRegistration) {
      const host = findShellSectionHost();
      if (host) shellSectionRegistration = host.registerShellSection(shellSectionProvider);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    isChildSession(currentSessionId);
    notificationGate.sessionStart(currentSessionId, ctx.sessionManager.getEntries());
    if (!isChildActivation && ctx.hasUI) bindRootUI(ctx.ui, currentSessionId);
  });

  pi.on("agent_start", () => {
    notificationGate.agentStart();
  });

  pi.on("agent_end", () => {
    notificationGate.agentEnd();
  });

  pi.on("turn_end", () => {
    notificationGate.turnEnd();
  });

  if (!loadedInChildContext) {
    pi.on("tool_execution_start", async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (isChildSession(sessionId)) return;
      currentSessionId = sessionId;
      notificationGate.activateOwner(currentSessionId);
      if (!ctx.hasUI) return;
      bindRootUI(ctx.ui, currentSessionId);
    });
  }

  pi.registerTool(
    defineTool({
      name: "shell_start",
      label: "Start Shell",
      description:
        "Start a managed long-running background process. Exit is delivered as a shell-completion notification; do not poll. Keep stdout and stderr on the process (no `> file` redirection); the manager captures both and the Shells viewer shows them live.",
      promptSnippet: "Start a managed long-running background process.",
      parameters: StartSchema,
      execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          currentSessionId = ctx.sessionManager.getSessionId();
          isChildSession(currentSessionId);
          notificationGate.activateOwner(currentSessionId);
          return jsonResult(
            manager.start({
              ownerId: currentSessionId,
              command: params.command,
              cwd: resolve(ctx.cwd, params.cwd ?? "."),
              name: params.name,
              toolCallId,
            }),
          );
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "shell_read",
      label: "Read Shell",
      description: "Read managed process output from absolute byte cursors.",
      promptSnippet: "Read available output from a managed process.",
      parameters: ReadSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            manager.read({
              requesterId: ctx.sessionManager.getSessionId(),
              isAdmin: adminFor(ctx.sessionManager.getSessionId()),
              shellId: params.shell_id,
              stdoutOffset: params.stdout_offset,
              stderrOffset: params.stderr_offset,
              maxBytes: params.max_bytes,
            }),
          );
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "shell_stop",
      label: "Stop Shell",
      description: "Stop a managed shell process.",
      promptSnippet: "Stop a managed shell process.",
      parameters: StopSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            await manager.stop({
              requesterId: ctx.sessionManager.getSessionId(),
              isAdmin: adminFor(ctx.sessionManager.getSessionId()),
              shellId: params.shell_id,
            }),
          );
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "shell_list",
      label: "List Shells",
      description: "List managed shell processes visible to this session.",
      promptSnippet: "List managed processes visible to this session.",
      parameters: ListSchema,
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            manager.list({
              requesterId: ctx.sessionManager.getSessionId(),
              isAdmin: adminFor(ctx.sessionManager.getSessionId()),
            }),
          );
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    }),
  );

  pi.registerCommand("shells", {
    description: "List, read, or stop managed shells",
    handler: async (args, ctx) => {
      const [action, id] = args.trim().split(/\s+/, 2);
      const requesterId = ctx.sessionManager.getSessionId();
      const isAdmin = adminFor(requesterId);

      try {
        if (!action || action === "list") {
          if (!isChildActivation && ctx.mode === "tui") {
            bindRootUI(ctx.ui, requesterId);
            await openShellsOverlay(rootUI ?? ctx.ui, manager, requesterId);
            return;
          }
          const result = manager.list({ requesterId, isAdmin });
          ctx.ui.notify(JSON.stringify(result, null, 2) ?? "null", "info");
          return;
        }

        if (action === "read") {
          if (!id) {
            ctx.ui.notify("Usage: /shells read <id>", "warning");
            return;
          }
          const result = manager.read({ requesterId, isAdmin, shellId: id });
          ctx.ui.notify(JSON.stringify(result, null, 2) ?? "null", "info");
          return;
        }

        if (action === "stop") {
          if (!id) {
            ctx.ui.notify("Usage: /shells stop <id>", "warning");
            return;
          }
          const result = await manager.stop({ requesterId, isAdmin, shellId: id });
          if (shuttingDown) return;
          ctx.ui.notify(JSON.stringify(result, null, 2) ?? "null", "info");
          return;
        }

        ctx.ui.notify("Usage: /shells [list | read <id> | stop <id>]", "warning");
      } catch (error) {
        if (shuttingDown) return;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let shutdownHandled = false;
  pi.on("session_shutdown", async (event, ctx) => {
    if (shutdownHandled) return;
    shutdownHandled = true;
    notificationGate.shutdown();
    shuttingDown = true;
    unsubscribeCompletions();
    // Snapshot identity before any await; this activation is already invalidated above.
    const shutdownSessionId = currentSessionId ?? ctx.sessionManager.getSessionId();

    if (isChildSession(shutdownSessionId)) {
      // A child quit releases only its own shells; the shared manager stays with root.
      const ownerId = shutdownSessionId;
      try {
        await manager.cleanupOwner(ownerId);
      } finally {
        detachLifecycle();
      }
      return;
    }

    shellSectionRegistration?.unregister();
    shellSectionProvider?.dispose();
    shellSectionRegistration = undefined;
    shellSectionProvider = undefined;
    rootUI = undefined;
    rootSessionId = undefined;

    if (event.reason !== "quit") {
      // Session replacement leaves shells running under the outgoing owner with no
      // runtime to report them; reload keeps the same session id, so its new
      // activation continues reporting and nothing is lost.
      if (event.reason !== "reload") emitLostForOwner(currentSessionId);
      detachLifecycle();
      return;
    }
    // Only the root activation whose manager still occupies the process-wide slot owns
    // teardown. Release the slot synchronously before awaiting so an activation created
    // during disposal builds a fresh manager and is never torn down by this one.
    if (registry[MANAGER_KEY] !== manager) {
      detachLifecycle();
      return;
    }
    delete registry[MANAGER_KEY];
    try {
      await manager.dispose();
    } finally {
      detachLifecycle();
    }
  });
}
