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

export function isSensitiveFile(file: { path: string; oldPath?: string }): boolean {
  return (
    isSensitivePath(file.path) || (file.oldPath !== undefined && isSensitivePath(file.oldPath))
  );
}
