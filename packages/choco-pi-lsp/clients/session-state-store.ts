import { assignOptionalProperties } from "./optional-properties.ts";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomicAsync } from "./atomic-write.ts";
import { getProjectDataDir } from "./file-utils.ts";
import { readJsonCacheAsync } from "./json-cache-read.ts";
import type { PersistedReadGuardState } from "./read-guard.ts";
import type { PersistedWidgetState } from "./widget-state.ts";

export const STATE_VERSION = 1;

export interface PersistedSessionState {
  version: number;
  sessionId: string;
  savedAt: number;
  widget: PersistedWidgetState;
  readGuard?: PersistedReadGuardState;
}

export type SessionStartMode = "fork" | "keep" | "clean" | "maybe-rehydrate";

export function sessionStartMode(
  reason: string | undefined,
  hasPendingForkSnapshot: boolean,
): SessionStartMode {
  if (reason === "fork" && hasPendingForkSnapshot) return "fork";
  if (reason === "reload") return "keep";
  if (reason === "new") return "clean";
  return "maybe-rehydrate";
}

function sessionsDir(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "sessions");
}

function sessionFilePath(cwd: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return path.join(sessionsDir(cwd), `${safe}.json`);
}

export async function saveSessionState(
  cwd: string,
  sessionId: string | undefined,
  widget: PersistedWidgetState,
  readGuard?: PersistedReadGuardState,
): Promise<void> {
  if (!sessionId || !sessionId.trim()) return;
  try {
    const dir = sessionsDir(cwd);
    await fs.mkdir(dir, { recursive: true });
    const payload: PersistedSessionState = assignOptionalProperties(
      { version: STATE_VERSION, sessionId, savedAt: Date.now(), widget },
      readGuard,
      () => ({ readGuard }),
    );
    const file = sessionFilePath(cwd, sessionId);
    await writeFileAtomicAsync(file, JSON.stringify(payload));
  } catch {}
}

export async function dropStaleFiles(
  widget: PersistedWidgetState,
  savedAt: number,
): Promise<PersistedWidgetState> {
  const checked = await Promise.all(
    widget.files.map(async (file) => {
      try {
        const st = await fs.stat(file.filePath);
        return st.mtimeMs <= savedAt + 1 ? file : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return {
    ...widget,
    files: checked.filter((f): f is PersistedWidgetState["files"][number] => f !== undefined),
  };
}

export async function loadSessionState(
  cwd: string,
  sessionId: string | undefined,
): Promise<PersistedSessionState | undefined> {
  if (!sessionId || !sessionId.trim()) return undefined;
  return readJsonCacheAsync<PersistedSessionState>(sessionFilePath(cwd, sessionId), (parsed) => {
    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    const state = parsed as PersistedSessionState;
    if (state?.version !== STATE_VERSION || !state.widget) return undefined;
    return state;
  });
}
