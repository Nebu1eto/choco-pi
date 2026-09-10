export type GetSessionFlag = (name: string) => boolean | string | undefined;

/** Session-start LSP spawning is opt-in; ordinary tool use remains lazy. */
export function shouldPrewarmLanguageServers(getFlag: GetSessionFlag): boolean {
  return getFlag("lsp-warmup") === true;
}

export type LanguageServerPrewarmResult = "configured" | "automatic" | "disabled";

/** Explicit warmFiles remain an opt-in even when automatic prewarming is disabled. */
export async function runLanguageServerPrewarm(options: {
  warmFiles: string[];
  automaticWarmupEnabled: boolean;
  warmConfiguredFiles: (warmFiles: string[]) => Promise<void>;
  warmDominantLanguage: () => Promise<void>;
}): Promise<LanguageServerPrewarmResult> {
  if (options.warmFiles.length > 0) {
    await options.warmConfiguredFiles(options.warmFiles);
    return "configured";
  }
  if (!options.automaticWarmupEnabled) return "disabled";
  await options.warmDominantLanguage();
  return "automatic";
}
