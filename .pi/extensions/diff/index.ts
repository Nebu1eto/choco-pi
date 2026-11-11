/**
 * `/diff`: a pane beside the transcript listing this session's changes.
 *
 * `lib/changes/git/` reads git and owns refresh scheduling; this entry point wires the
 * pane (`ui/`) and its hosts (`host/`) to Pi. Every dependency below is
 * called lazily: nothing reads the session, the scratch directory, or the
 * review records until the pane is used.
 */
import { lstat } from "node:fs/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSystemClock } from "../lib/changes/git/clock.ts";
import { resolveDefaultBranchBase } from "../lib/changes/git/default-base.ts";
import { createGitExecRunner, createPinnedGitRunner } from "../lib/changes/git/exec.ts";
import { DEFAULT_DIFF_LIMITS } from "../lib/changes/git/limits.ts";
import { createDiffStore } from "../lib/changes/git/store.ts";
import { SCRATCH_DIR_ENV, scratchDirForSession } from "../lib/scratch-path.ts";
import { sessionBaselineOf, turnCheckpointsOf } from "./core/checkpoints.ts";
import { readRecords } from "../lib/changes/findings.ts";
import { probeTui } from "./host/probe.ts";
import { registerDiffPane } from "./ui/controller.ts";
import { notesFilePath } from "../lib/changes/notes.ts";
import { fileSystemPrefsIo } from "./ui/prefs.ts";

function scratchDir(ctx: ExtensionContext): string | undefined {
  const inherited = process.env[SCRATCH_DIR_ENV];
  if (inherited) return inherited;
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionId ? scratchDirForSession(sessionId) : undefined;
}

export default function diffPaneExtension(pi: ExtensionAPI): void {
  const clock = createSystemClock();
  registerDiffPane(pi, {
    createStore: (cwd, checkpoints, source) => createDiffStore({ cwd, clock, checkpoints, source }),
    clock,
    prefsIo: fileSystemPrefsIo,
    agentDir: getAgentDir,
    probe: probeTui,
    copyText: copyToClipboard,
    styler: (ctx) => ctx.ui.theme,
    listTurns: (ctx) => turnCheckpointsOf(ctx.sessionManager.getBranch()),
    // Every entry of the session file, so /tree navigation and compaction keep the baseline.
    sessionBaseline: (ctx) => sessionBaselineOf(ctx.sessionManager.getEntries()),
    defaultBranchBase: async (cwd) => {
      // Deadline-bound and output-capped like every store read; nothing outlives the call.
      const git = createPinnedGitRunner(
        createGitExecRunner(DEFAULT_DIFF_LIMITS),
        clock,
        DEFAULT_DIFF_LIMITS,
      );
      try {
        return await resolveDefaultBranchBase(git.run, cwd);
      } finally {
        git.cancelAll();
      }
    },
    scratchDir,
    readRecords,
    fileChangedAt: async (path) => {
      try {
        return (await lstat(path)).mtimeMs;
      } catch {
        return null;
      }
    },
    notesFile: (ctx) => {
      const scratch = scratchDir(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      return scratch && sessionId ? notesFilePath(scratch, sessionId) : undefined;
    },
    notesIo: fileSystemPrefsIo,
  });
}
