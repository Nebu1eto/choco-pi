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

export function notifyUi(
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

export function log(_msg: string) {}

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
      } catch {}
    }
  } catch {}
  return cleaned;
}
