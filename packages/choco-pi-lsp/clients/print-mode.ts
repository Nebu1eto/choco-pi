export function isPrintMode(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--print") || argv.includes("-p");
}
