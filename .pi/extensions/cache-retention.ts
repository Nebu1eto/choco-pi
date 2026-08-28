/**
 * Set the upstream/provider PI_CACHE_RETENTION environment default to "long"
 * (1h TTL), so supported providers can retain prompt caches across idle gaps.
 * An explicit value always wins. This environment default does not establish
 * support for, or authorize adding, a `prompt_cache_retention` field to the
 * ChatGPT-backed Codex request body; that endpoint must omit unproven fields.
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
