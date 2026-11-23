/**
 * Stateless helpers shared by the extension activation modules.
 *
 * Extracted from `runtime-extension.ts`; behavior is unchanged.
 */

import type { RuntimeValue } from "../tools/runtime-values.ts";
import { isRuntimeString } from "../tools/runtime-values.ts";
import { recordDegradation } from "../clients/degradation-ledger.ts";
import {
  modeSuppressionNote,
  readExtensionMode,
  suppressesUserNotify,
} from "../clients/extension-mode.ts";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { logSessionStart } from "../clients/sessionstart-logger.ts";

export function dbg(msg: string) {
  logSessionStart(msg);
}

/**
 * Mode-aware `ctx.ui.notify` (#1334 S2). Every user-facing notify in this file
 * goes through here so terminal ownership is derived from the HOST's
 * `ctx.mode`, not from choco-pi-lsp guessing. In "print"/"json" the message is
 * logged instead of rendered — those modes are one-shot pipelines whose stdout
 * belongs to the run's actual output, not to extension chatter. "tui", "rpc"
 * and an older host with no `mode` field all notify exactly as before.
 */
export function notifyUi(
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous pi event ctx shapes
  ctx: any,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const mode = readExtensionMode(ctx);
  if (suppressesUserNotify(mode)) {
    recordDegradation({
      kind: "mode-suppression",
      subject: "ctx.ui.notify",
      reason: modeSuppressionNote(mode),
    });
    dbg(`notify ${modeSuppressionNote(mode)}: ${message.split("\n")[0]}`);
    return;
  }
  ctx?.ui?.notify?.(message, level);
}

/**
 * Best-effort read of the STABLE pi session id off an event ctx
 * (`ctx.sessionManager.getSessionId()`), the same accessor #473's
 * session_start handling and #791's deferred-format ownership tagging both
 * rely on. Never throws — returns `undefined` on any unexpected ctx shape
 * or accessor error (older host, inconclusive probe, etc).
 */
export function getStableSessionId<TContext>(ctx: TContext): string | undefined {
  try {
    // SAFETY: Pi lifecycle contexts provide a signature-compatible sessionManager accessor when that optional API exists.
    return (
      ctx as { sessionManager?: { getSessionId?: () => string } } | null | undefined
    )?.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

// No-op log function (verbose console logging was removed with lens-verbose flag)
export function log(_msg: string) {
  // Previously tied to --lens-verbose flag, now disabled
}

/**
 * The pi SDK invalidates a captured `pi`/command ctx after a session
 * replacement or reload (ctx.newSession/fork/switchSession/reload); every later
 * `pi.*` call then throws with this signature (installed SDK:
 * core/extensions/loader.js `assertActive`). We match by message — not `===` a
 * captured instance — so a fire-and-forget task that races a session swap can
 * recognise the benign stale-ctx throw and degrade to a no-op. Substring-matched
 * on the stable "stale after session replacement or reload" phrase so it
 * survives incidental wording changes around it.
 */
export function isStaleExtensionCtxError<T>(err: T): boolean {
  return err instanceof Error && err.message.includes("stale after session replacement or reload");
}

export function normalizeCommandArgs(args: RuntimeValue): string[] {
  if (Array.isArray(args)) {
    return args.filter((arg): arg is string => isRuntimeString(arg));
  }
  if (isRuntimeString(args)) {
    return args.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

export function cleanStaleTsBuildInfo(cwd: string): string[] {
  const cleaned: string[] = [];
  try {
    // Find all tsbuildinfo files in the project (max depth 3 to avoid crawling)
    const candidates = nodeFs
      .readdirSync(cwd)
      .filter((f) => f.endsWith(".tsbuildinfo"))
      .map((f) => path.join(cwd, f));

    for (const infoPath of candidates) {
      try {
        const data = JSON.parse(nodeFs.readFileSync(infoPath, "utf-8"));
        const root: string[] = data.root ?? [];
        const dir = path.dirname(infoPath);
        const isStale = root.some((f) => !nodeFs.existsSync(path.resolve(dir, f)));
        if (isStale) {
          nodeFs.unlinkSync(infoPath);
          cleaned.push(infoPath);
        }
      } catch {
        // Malformed or unreadable - skip
      }
    }
  } catch {
    // readdirSync failed - skip
  }
  return cleaned;
}
