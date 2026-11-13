import type { RuntimeValue } from "../../runtime-values.ts";
import type { ExecRunner, TurnTreeProvider } from "../types.ts";
import { createSystemClock, type DiffClock } from "./clock.ts";
import { readFileBody, type BodyContext, type BodyRead } from "./file-body.ts";
import { createGitExecRunner, createPinnedGitRunner, shortErrorMessage } from "./exec.ts";
import { excerptRange, readExcerpt, type ExcerptContext } from "./excerpt.ts";
import { resolveDiffLimits, type DiffLimits } from "./limits.ts";
import type {
  DiffSnapshot,
  DiffSource,
  DiffStore,
  DiffStoreState,
  FileBody,
  FileExcerpt,
  RefreshReason,
} from "./model.ts";
import { readSnapshot, sourceKey, type ListedFile, type RefreshOutcome } from "./snapshot.ts";

export type DiffStoreOptions = {
  cwd: string;
  exec?: ExecRunner;
  clock?: DiffClock;
  limits?: Partial<DiffLimits>;
  checkpoints?: TurnTreeProvider;
  /** The source before the first `setSource`; "uncommitted" when omitted. */
  source?: DiffSource;
};

type RefreshMode = "full" | "probe";

type Run = {
  id: number;
  generation: number;
  mode: RefreshMode;
  startedAt: number;
  waiters: Array<() => void>;
};

type Applied = {
  snapshot: DiffSnapshot;
  /** What bodies of this snapshot are computed against (`SnapshotRead.compareBase/compareHead`). */
  compareBase: string;
  compareHead?: string;
  files: Map<string, ListedFile>;
  fingerprint: string;
  contentKey: string;
  generation: number;
};

type CachedBody = {
  key: string;
  /** The comparison the body was read for; see `comparisonOf`. */
  comparison: string;
  generation: number;
  read: Promise<BodyRead>;
};

/** Identity of what a body is computed against: resolved base, and a range's resolved head. */
function comparisonOf(target: { compareBase: string; compareHead?: string }): string {
  return JSON.stringify([target.compareBase, target.compareHead ?? null]);
}

type Outcome = RefreshOutcome | { kind: "error"; message: string } | { kind: "superseded" };

/** Excerpts kept at once; each is at most MAX_EXCERPT_LINES short lines. */
const MAX_CACHED_EXCERPTS = 64;

type CachedExcerpt = { revision: number; generation: number; read: Promise<FileExcerpt> };

class SupersededError extends Error {
  constructor() {
    super("Refresh superseded.");
    this.name = "SupersededError";
  }
}

function sameSource(left: DiffSource, right: DiffSource): boolean {
  return sourceKey(left) === sourceKey(right);
}

/**
 * Create the data store behind the /diff pane.
 *
 * Nothing runs until the first `requestRefresh`, `refreshNow`, or
 * `setVisible(true)`. Afterwards at most one refresh for the current source
 * runs at a time; a request during a refresh schedules exactly one follow-up.
 * Each refresh carries a generation, and results from a superseded generation
 * (source changed, store disposed, or a newer refresh applied) are discarded.
 */
export function createDiffStore(options: DiffStoreOptions): DiffStore {
  const cwd = options.cwd;
  const clock = options.clock ?? createSystemClock();
  const limits = resolveDiffLimits(options.limits);
  const checkpoints = options.checkpoints;
  const git = createPinnedGitRunner(options.exec ?? createGitExecRunner(limits), clock, limits);

  let state: DiffStoreState = { kind: "idle" };
  const listeners = new Set<(state: DiffStoreState) => void>();
  let source: DiffSource = options.source ?? { kind: "uncommitted" };
  let generation = 0;
  let disposed = false;
  let activated = false;
  let visible = false;

  let debounceTimer: RuntimeValue;
  let debounceArmed = false;
  let debounceMode: RefreshMode = "full";
  let pollTimer: RuntimeValue;
  let pollArmed = false;

  let running: Run | undefined;
  let followUp: RefreshMode | undefined;
  let followUpImmediate = false;
  let nextWaiters: Array<() => void> = [];
  let runSequence = 0;
  let appliedSequence = 0;
  let backoff = 1;

  let applied: Applied | undefined;
  let lastRevision = 0;
  const bodies = new Map<string, CachedBody>();
  /** By revision, path and range; only the current revision's are kept. */
  const excerpts = new Map<string, CachedExcerpt>();

  function setState(next: DiffStoreState): void {
    state = next;
    for (const listener of Array.from(listeners)) {
      try {
        listener(state);
      } catch {
        // A failing subscriber must not break refresh scheduling or other subscribers.
      }
    }
  }

  function setRefreshing(refreshing: boolean): void {
    if (state.kind === "ready" && state.refreshing !== refreshing) {
      setState({ kind: "ready", snapshot: state.snapshot, refreshing });
    }
  }

  function clearDebounce(): void {
    if (!debounceArmed) return;
    clock.clearTimeout(debounceTimer);
    debounceArmed = false;
    debounceTimer = undefined;
  }

  function clearPoll(): void {
    if (!pollArmed) return;
    clock.clearTimeout(pollTimer);
    pollArmed = false;
    pollTimer = undefined;
  }

  function resolveAll(waiters: Array<() => void>): void {
    for (const resolve of waiters.splice(0)) resolve();
  }

  function schedule(mode: RefreshMode, delay: number): void {
    if (disposed) return;
    if (running) {
      followUp = followUp === "full" || mode === "full" ? "full" : "probe";
      return;
    }
    clearPoll();
    if (debounceArmed) {
      if (mode === "full") debounceMode = "full";
      return;
    }
    debounceMode = mode;
    debounceArmed = true;
    debounceTimer = clock.setTimeout(() => {
      debounceArmed = false;
      debounceTimer = undefined;
      if (disposed || running) return;
      start(debounceMode);
    }, delay);
  }

  function schedulePoll(): void {
    if (disposed || !visible || !activated || running || debounceArmed || pollArmed) return;
    pollArmed = true;
    pollTimer = clock.setTimeout(() => {
      pollArmed = false;
      pollTimer = undefined;
      if (disposed || running || debounceArmed) return;
      start("probe");
    }, limits.pollIntervalMs * backoff);
  }

  function start(mode: RefreshMode): void {
    clearDebounce();
    clearPoll();
    runSequence += 1;
    const run: Run = {
      id: runSequence,
      generation,
      mode,
      startedAt: clock.now(),
      waiters: nextWaiters,
    };
    nextWaiters = [];
    running = run;
    if (mode === "full") setRefreshing(true);
    void execute(run);
  }

  function isCurrent(run: Run): boolean {
    return !disposed && run.generation === generation && run.id > appliedSequence;
  }

  async function execute(run: Run): Promise<void> {
    // Snapshot everything the refresh reads before its first await.
    const runSource = source;
    const previous = applied && applied.generation === run.generation ? applied : undefined;
    let outcome: Outcome;
    try {
      outcome = await readSnapshot({
        runner: git.run,
        cwd,
        limits,
        source: runSource,
        checkpoints,
        previousFingerprint: previous?.fingerprint,
        mode: run.mode,
        assertCurrent: () => {
          if (!isCurrent(run)) throw new SupersededError();
        },
        onEscalate: () => {
          if (running === run && isCurrent(run)) setRefreshing(true);
        },
      });
    } catch (error) {
      outcome =
        error instanceof SupersededError
          ? { kind: "superseded" }
          : {
              kind: "error",
              message: shortErrorMessage(error instanceof Error ? error : String(error)),
            };
    }
    finish(run, runSource, outcome);
  }

  function finish(run: Run, runSource: DiffSource, outcome: Outcome): void {
    const duration = clock.now() - run.startedAt;
    const current = isCurrent(run) && outcome.kind !== "superseded";
    if (running === run) running = undefined;
    if (current) {
      appliedSequence = run.id;
      apply(run, runSource, outcome);
      adjustBackoff(run.mode, outcome, duration);
    }
    resolveAll(run.waiters);
    if (disposed || running) return;
    if (followUp !== undefined) {
      const mode = followUp;
      const immediate = followUpImmediate || nextWaiters.length > 0;
      followUp = undefined;
      followUpImmediate = false;
      if (immediate) start(mode);
      else schedule(mode, limits.debounceMs * backoff);
      return;
    }
    schedulePoll();
  }

  function adjustBackoff(mode: RefreshMode, outcome: Outcome, duration: number): void {
    if (duration >= limits.slowRefreshMs) {
      backoff = Math.min(backoff * 2, limits.maxBackoffFactor);
    } else if (mode === "full" || outcome.kind === "snapshot") {
      backoff = 1;
    }
  }

  function apply(run: Run, runSource: DiffSource, outcome: Outcome): void {
    switch (outcome.kind) {
      case "superseded":
        return;
      case "error":
        // Forget the fingerprint so the next probe rereads instead of reporting "unchanged".
        if (applied) applied = { ...applied, fingerprint: "" };
        setState({ kind: "error", message: outcome.message });
        return;
      case "not-a-repository":
        applied = undefined;
        bodies.clear();
        excerpts.clear();
        setState({ kind: "not-a-repository", cwd });
        return;
      case "unchanged":
        setRefreshing(false);
        return;
      case "snapshot":
        break;
    }
    const read = outcome.read;
    const files = new Map(read.files.map((file) => [file.summary.path, file]));
    if (
      applied &&
      applied.generation === run.generation &&
      applied.contentKey === read.contentKey
    ) {
      // An equal content key includes equal comparison ids, so cached bodies stay valid.
      applied = { ...applied, fingerprint: read.fingerprint, files };
      setState({ kind: "ready", snapshot: applied.snapshot, refreshing: false });
      return;
    }
    lastRevision += 1;
    // Excerpts belong to one snapshot: the working tree they quote may have changed since.
    excerpts.clear();
    const snapshot: DiffSnapshot = {
      revision: lastRevision,
      source: runSource,
      repoRoot: read.repoRoot,
      head: read.head,
      branch: read.branch,
      base: read.base,
      capturedAt: run.startedAt,
      files: read.files.map((file) => file.summary),
      totals: read.totals,
      omittedFiles: read.omittedFiles,
    };
    if (read.baseline) snapshot.baseline = read.baseline;
    const comparison = comparisonOf(read);
    for (const [path, cached] of bodies) {
      const next = files.get(path);
      const stale =
        !next ||
        next.key !== cached.key ||
        cached.comparison !== comparison ||
        cached.generation !== run.generation;
      if (stale) {
        bodies.delete(path);
      }
    }
    applied = {
      snapshot,
      compareBase: read.compareBase,
      files,
      fingerprint: read.fingerprint,
      contentKey: read.contentKey,
      generation: run.generation,
    };
    if (read.compareHead !== undefined) applied.compareHead = read.compareHead;
    setState({ kind: "ready", snapshot, refreshing: false });
  }

  function activate(): void {
    activated = true;
  }

  return {
    getState: () => state,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    requestRefresh(reason: RefreshReason) {
      if (disposed) return;
      activate();
      const mode: RefreshMode = reason === "poll" && applied ? "probe" : "full";
      schedule(mode, limits.debounceMs * backoff);
    },

    refreshNow() {
      if (disposed) return Promise.resolve();
      activate();
      return new Promise<void>((resolve) => {
        nextWaiters.push(resolve);
        if (running) {
          followUp = "full";
          followUpImmediate = true;
          return;
        }
        start("full");
      });
    },

    async loadFile(path) {
      const current = applied;
      const generationAtCall = generation;
      if (disposed || state.kind !== "ready" || !current) {
        return {
          revision: state.kind === "ready" ? state.snapshot.revision : 0,
          body: { kind: "unreadable", reason: "No diff snapshot is loaded." },
        };
      }
      const revision = current.snapshot.revision;
      const listed = current.files.get(path);
      if (!listed) return { revision, body: { kind: "gone" } };
      const cached = bodies.get(path);
      const comparison = comparisonOf(current);
      if (
        cached &&
        cached.key === listed.key &&
        cached.comparison === comparison &&
        cached.generation === generationAtCall
      ) {
        return { revision, body: (await cached.read).body };
      }
      const context: BodyContext = {
        runner: git.run,
        repoRoot: current.snapshot.repoRoot,
        base: current.compareBase,
        limits,
      };
      // A range reads both sides at the ids its listing used, never at a ref that moved since.
      if (current.compareHead !== undefined) context.head = current.compareHead;
      const entry: CachedBody = {
        key: listed.key,
        comparison,
        generation: generationAtCall,
        read: readFileBody(context, listed),
      };
      bodies.set(path, entry);
      const result = await entry.read;
      if (!result.cacheable && bodies.get(path) === entry) bodies.delete(path);
      const body: FileBody = result.body;
      return { revision, body };
    },

    async loadContext(path, from, to) {
      const current = applied;
      const generationAtCall = generation;
      if (disposed || state.kind !== "ready" || !current) {
        return {
          revision: state.kind === "ready" ? state.snapshot.revision : 0,
          excerpt: { kind: "unavailable", reason: "No diff snapshot is loaded." },
        };
      }
      const revision = current.snapshot.revision;
      // Only a listed file is read: a recorded path never reaches the file system unchecked.
      if (!current.files.has(path)) {
        return { revision, excerpt: { kind: "unavailable", reason: "Not in this diff." } };
      }
      const { first, last } = excerptRange(from, to);
      const key = JSON.stringify([revision, path, first, last]);
      const cached = excerpts.get(key);
      if (cached && cached.generation === generationAtCall) {
        excerpts.delete(key);
        excerpts.set(key, cached);
        return { revision, excerpt: await cached.read };
      }
      const context: ExcerptContext = {
        runner: git.run,
        repoRoot: current.snapshot.repoRoot,
        limits,
      };
      if (current.compareHead !== undefined) context.head = current.compareHead;
      const entry: CachedExcerpt = {
        revision,
        generation: generationAtCall,
        read: readExcerpt(context, path, first, last),
      };
      excerpts.set(key, entry);
      for (const stale of excerpts.keys()) {
        if (excerpts.size <= MAX_CACHED_EXCERPTS) break;
        excerpts.delete(stale);
      }
      const excerpt = await entry.read;
      // A failure may pass (a timeout); it is read again next time.
      if (excerpt.kind === "unavailable" && excerpts.get(key) === entry) excerpts.delete(key);
      return { revision, excerpt };
    },

    setSource(next) {
      if (disposed || sameSource(source, next)) return;
      source = next;
      generation += 1;
      bodies.clear();
      excerpts.clear();
      // The refresh in flight belongs to the old source: it is discarded when
      // it settles, and the new source does not wait for it.
      const superseded = running;
      running = undefined;
      if (superseded) {
        nextWaiters.push(...superseded.waiters.splice(0));
      }
      if (!activated) return;
      setRefreshing(true);
      const immediate = followUpImmediate || nextWaiters.length > 0;
      followUp = undefined;
      followUpImmediate = false;
      clearDebounce();
      if (immediate) start("full");
      else schedule("full", limits.debounceMs * backoff);
    },

    setVisible(next) {
      if (disposed) return;
      visible = next;
      if (!next) {
        clearPoll();
        return;
      }
      activate();
      schedule(applied ? "probe" : "full", applied ? 0 : limits.debounceMs * backoff);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      clearDebounce();
      clearPoll();
      git.cancelAll();
      listeners.clear();
      bodies.clear();
      excerpts.clear();
      const superseded = running;
      running = undefined;
      if (superseded) resolveAll(superseded.waiters);
      resolveAll(nextWaiters);
    },
  };
}
