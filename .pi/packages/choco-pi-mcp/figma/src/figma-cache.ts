import { createTtlCache } from "../common/cache.ts";

export const figmaCache = createTtlCache<unknown>({
	defaultTtlMs: 5 * 60 * 1000,
	maxEntries: 100,
});
