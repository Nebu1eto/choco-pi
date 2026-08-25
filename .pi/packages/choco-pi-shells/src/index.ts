import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Type } from "typebox";

import { inChildSessionContext } from "../../choco-pi-subagents/src/child-context.ts";
import { ShellManager } from "./shell-manager.ts";
import { openShellsOverlay, type ShellsUICtx } from "./ui/shells-overlay.ts";
import {
  ShellsWidget,
  type ShellsWidgetManager,
  type ShellsWidgetUICtx,
} from "./ui/shells-widget.ts";

const MANAGER_KEY = Symbol.for("choco-pi-shells:manager");

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
    command: Type.String({ minLength: 1, description: "Shell command to run in the background." }),
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
      };
      widget = new ShellsWidget(widgetManager, sessionId);
    }
    widget.setUICtx(ui);
  };

  if (!isChildActivation) {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      bindRootUI(ctx.ui, ctx.sessionManager.getSessionId());
    });

    pi.on("tool_execution_start", async (_event, ctx) => {
      bindRootUI(ctx.ui, ctx.sessionManager.getSessionId());
    });
  }

  pi.registerTool(
    defineTool({
      name: "shell_start",
      label: "Start Shell",
      description: "Start a managed background shell process and return immediately.",
      parameters: StartSchema,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        try {
          return jsonResult(
            manager.start({
              ownerId: ctx.sessionManager.getSessionId(),
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
          if (!isChildActivation) {
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
