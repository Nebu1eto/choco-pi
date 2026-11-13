/**
 * Wait for asynchronous work the code under test starts without returning a
 * promise (git worktree creation and cleanup, queued transcript writes).
 *
 * Polls on `setImmediate` and bounds the wait with `performance.now()`, so it
 * keeps working while a test mocks `setTimeout`, `setInterval` and `Date`.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
