export type GetSessionFlag = (name: string) => boolean | string | undefined;

/** Session-start LSP spawning is opt-in; ordinary tool use remains lazy. */
export function shouldPrewarmLanguageServers(getFlag: GetSessionFlag): boolean {
  return getFlag("lsp-warmup") === true;
}
