export interface PromiseDescriptor {
  role?: "primary" | "auxiliary";
  budgetMs?: number;
}

export async function raceToCompletion<T>(
  promises: Promise<T>[],
  shouldComplete: (results: T[]) => boolean,
  options: {
    timeoutMs: number;
    graceMs?: number;
    descriptors?: PromiseDescriptor[];
    auxGraceMs?: number;
  } = { timeoutMs: 1500 },
): Promise<T[]> {
  const results: (T | undefined)[] = Array.from({ length: promises.length });
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let auxGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  let remaining = promises.length;

  const descriptors = options.descriptors ?? [];
  const hasAuxiliaries = descriptors.some((d) => d.role === "auxiliary");
  const auxIndices = hasAuxiliaries
    ? new Set(descriptors.map((d, i) => (d.role === "auxiliary" ? i : -1)).filter((i) => i >= 0))
    : new Set<number>();
  const primaryCount = promises.length - auxIndices.size;

  let primaryRemaining = primaryCount;
  let auxGraceStarted = false;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      completed = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (auxGraceTimer) clearTimeout(auxGraceTimer);
      resolve(results.filter((r): r is T => r !== undefined));
    }, options.timeoutMs);

    const finalize = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (graceTimer) clearTimeout(graceTimer);
      if (auxGraceTimer) clearTimeout(auxGraceTimer);
      resolve(results.filter((r): r is T => r !== undefined));
    };

    const startAuxGrace = () => {
      if (auxGraceStarted || completed) return;
      auxGraceStarted = true;
      const ceilingMs = options.auxGraceMs ?? 500;
      const pendingAuxBudgets = [...auxIndices]
        .filter((i) => results[i] === undefined)
        .map((i) => descriptors[i]?.budgetMs)
        .filter((budget): budget is number => budget !== undefined && budget >= 0);
      const graceMs =
        pendingAuxBudgets.length > 0
          ? Math.min(ceilingMs, Math.max(...pendingAuxBudgets))
          : ceilingMs;
      if (graceMs <= 0) {
        finalize();
        return;
      }
      auxGraceTimer = setTimeout(() => finalize(), graceMs);
    };

    const check = () => {
      if (completed) return;

      if (remaining === 0) {
        finalize();
        return;
      }

      if (hasAuxiliaries && primaryRemaining === 0 && !auxGraceStarted) {
        startAuxGrace();
      }

      const collected = results.filter((r): r is T => r !== undefined);
      if (shouldComplete(collected)) {
        if (options.graceMs !== undefined && options.graceMs > 0 && !graceTimer) {
          graceTimer = setTimeout(() => finalize(), options.graceMs);
        } else if (auxGraceStarted) {
        } else if (!hasAuxiliaries || primaryRemaining === 0) {
          finalize();
        }
      }
    };

    for (let i = 0; i < promises.length; i++) {
      const index = i;
      const isAux = auxIndices.has(index);
      promises[i]
        .then((result) => {
          if (!completed) {
            results[index] = result;
            remaining--;
            if (!isAux) primaryRemaining--;
            check();
          }
        })
        .catch(() => {
          if (!completed) {
            remaining--;
            if (!isAux) primaryRemaining--;
            check();
          }
        });
    }
  });
}
