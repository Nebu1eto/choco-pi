/**
 * Default Anthropic prompt-cache retention to "long" (1h TTL) for every
 * session, so idle gaps past the 5m ephemeral TTL stop re-billing the full
 * context. An explicit PI_CACHE_RETENTION value always wins.
 */
const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION";
const DEFAULT_RETENTION = "long";

export function applyDefaultCacheRetention(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!env[CACHE_RETENTION_ENV]) {
    env[CACHE_RETENTION_ENV] = DEFAULT_RETENTION;
  }
}

export default function cacheRetention(): void {
  applyDefaultCacheRetention();
}
