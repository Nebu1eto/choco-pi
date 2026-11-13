/** Share one in-flight operation among concurrent callers using the same key. */
export function dedupeInFlight<TResult>(
  inFlight: Map<string, Promise<TResult>>,
  key: string,
  run: () => Promise<TResult>,
  onDuplicate?: () => void,
): Promise<TResult> {
  const existing = inFlight.get(key);
  if (existing) {
    onDuplicate?.();
    return existing;
  }

  const promise = run().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
