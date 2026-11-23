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
