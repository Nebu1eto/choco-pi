import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { Type } from "typebox";

import { inChildSessionContext } from "../../choco-pi-subagents/src/child-context.ts";
import { ShellManager } from "./shell-manager.ts";
import type { ReadShellResult, ShellChangeEvent, ShellResult } from "./shell-manager.ts";
import { openShellsOverlay, type ShellsUICtx } from "./ui/shells-overlay.ts";
import {
  ShellsWidget,
  type ShellsWidgetManager,
  type ShellsWidgetUICtx,
} from "./ui/shells-widget.ts";

const MANAGER_KEY = Symbol.for("choco-pi-shells:manager");
const COMPLETION_DEBOUNCE_MS = 250;
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
        shell.exitCode !== undefined ? `exit ${shell.exitCode}` : undefined,
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
      description: "Long-running shell command to run in the background.",
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
  const isChildActivation = inChildSessionContext();
  const isAdmin = !isChildActivation;
  // SAFETY: Symbol.for provides the process-wide slot used only for ShellManager instances here.
  const registry = globalThis as typeof globalThis & ProcessRegistry;

  let manager = registry[MANAGER_KEY];
  if (!manager) {
    manager = new ShellManager();
    registry[MANAGER_KEY] = manager;
  }

  let widget: ShellsWidget | undefined;
  let rootSessionId: string | undefined;
  let rootUI: (ShellsUICtx & ShellsWidgetUICtx) | undefined;
  let currentSessionId: string | undefined;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  const pendingCompletions: ShellResult[] = [];

  const flushCompletions = (): void => {
    completionTimer = undefined;
    if (shuttingDown || pendingCompletions.length === 0) return;
    const completed = pendingCompletions.splice(0);
    const shells = completed.flatMap((shell) => {
      try {
        return [buildCompletionDetails(manager, shell)];
      } catch {
        return [];
      }
    });
    if (shells.length === 0) return;
    boundGroupedTails(shells);
    const details: ShellCompletionDetails = { shells };
    pi.sendMessage<ShellCompletionDetails>(
      {
        customType: SHELL_NOTIFICATION_TYPE,
        content: `<shell-completion>${JSON.stringify(details)}</shell-completion>\nUse shell_read with the reported cursors only when more output is needed.`,
        display: true,
        details,
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  };

  const unsubscribeCompletions = manager.onChange((event: ShellChangeEvent) => {
    if (
      event.type !== "end" ||
      shuttingDown ||
      currentSessionId === undefined ||
      event.shell.ownerId !== currentSessionId
    )
      return;
    pendingCompletions.push(event.shell);
    if (completionTimer !== undefined) return;
    completionTimer = setTimeout(flushCompletions, COMPLETION_DEBOUNCE_MS);
    completionTimer.unref();
  });

  pi.registerMessageRenderer<ShellCompletionDetails>(
    SHELL_NOTIFICATION_TYPE,
    (message, _options, theme) =>
      message.details ? new Text(renderShellCompletion(message.details, theme), 0, 0) : undefined,
  );

  const bindRootUI = (ui: ShellsUICtx & ShellsWidgetUICtx, sessionId: string): void => {
    if (isChildActivation) return;
    rootUI = ui;
    if (!widget || rootSessionId !== sessionId) {
      widget?.dispose();
      rootSessionId = sessionId;
      const widgetManager: ShellsWidgetManager = {
        onChange(listener) {
          const unsubscribe = manager.onChange(listener);
          for (const shell of manager.list({ requesterId: sessionId, isAdmin: true }).shells) {
            if (shell.state === "running") listener({ type: "start", shell });
          }
          return unsubscribe;
        },
        stop: manager.stop.bind(manager),
      };
      widget = new ShellsWidget(widgetManager, sessionId);
    }
    widget.setUICtx(ui);
  };

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    if (!isChildActivation && ctx.hasUI) bindRootUI(ctx.ui, currentSessionId);
  });

  if (!isChildActivation) {
    pi.on("tool_execution_start", async (_event, ctx) => {
      currentSessionId = ctx.sessionManager.getSessionId();
      if (!ctx.hasUI) return;
      bindRootUI(ctx.ui, currentSessionId);
    });
  }

  pi.registerTool(
    defineTool({
      name: "shell_start",
      label: "Start Shell",
      description:
        "Start a managed long-running background process. Use bash for ordinary commands; use code mode for bounded multi-call processing, with Promise.all for independent calls.",
      parameters: StartSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          currentSessionId = ctx.sessionManager.getSessionId();
          return jsonResult(
            manager.start({
              ownerId: currentSessionId,
              command: params.command,
              cwd: resolve(ctx.cwd, params.cwd ?? "."),
              name: params.name,
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
      description: "Read stdout and stderr from independent absolute byte cursors.",
      parameters: ReadSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            manager.read({
              requesterId: ctx.sessionManager.getSessionId(),
              isAdmin,
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
      parameters: StopSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            await manager.stop({
              requesterId: ctx.sessionManager.getSessionId(),
              isAdmin,
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
      parameters: ListSchema,
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            manager.list({
              requesterId: ctx.sessionManager.getSessionId(),
              isAdmin,
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
          ctx.ui.notify(JSON.stringify(result, null, 2) ?? "null", "info");
          return;
        }

        ctx.ui.notify("Usage: /shells [list | read <id> | stop <id>]", "warning");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let shutdownHandled = false;
  pi.on("session_shutdown", async (event, ctx) => {
    if (shutdownHandled) return;
    shutdownHandled = true;
    shuttingDown = true;
    unsubscribeCompletions();
    if (completionTimer !== undefined) clearTimeout(completionTimer);
    completionTimer = undefined;
    pendingCompletions.length = 0;

    if (isChildActivation) {
      await manager.cleanupOwner(ctx.sessionManager.getSessionId());
      return;
    }

    widget?.dispose();
    widget = undefined;
    rootUI = undefined;
    rootSessionId = undefined;

    if (event.reason !== "quit") return;
    await manager.dispose();
    if (registry[MANAGER_KEY] === manager) {
      delete registry[MANAGER_KEY];
    }
  });
}
