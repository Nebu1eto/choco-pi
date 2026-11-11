/**
 * Conservative list of paths whose contents neither the pane nor the review
 * puts into the prompt editor, sends to a model, or renders before the user
 * asks to see that file.
 *
 * Matching is case-insensitive. File-name patterns test the last path
 * segment; "secret" and "credential" match anywhere in the path, so a file
 * inside a `secrets/` directory counts too.
 */

const NAME_PATTERNS: readonly RegExp[] = [
  /^\.env$/u,
  /^\.env\..+$/u,
  /\.pem$/u,
  /\.key$/u,
  /\.p12$/u,
  /\.pfx$/u,
  /^id_rsa/u,
  /^id_ed25519/u,
  /\.keystore$/u,
  /^auth\.json$/u,
  /^\.npmrc$/u,
  /^\.netrc$/u,
];

const PATH_WORDS: readonly string[] = ["secret", "credential"];

export function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase().replaceAll("\\", "/");
  if (PATH_WORDS.some((word) => lower.includes(word))) return true;
  const name = lower.split("/").at(-1) ?? lower;
  return NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** A rename or copy is sensitive when either side is. */
export function isSensitiveFile(file: { path: string; oldPath?: string }): boolean {
  return (
    isSensitivePath(file.path) || (file.oldPath !== undefined && isSensitivePath(file.oldPath))
  );
}
