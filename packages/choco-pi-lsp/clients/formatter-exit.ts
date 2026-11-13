export interface IgnoredFileExit {
  statuses: readonly number[];
  diagnostics: readonly string[];
}

export interface FormatterExitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export const OXFMT_IGNORED_FILE_EXIT: IgnoredFileExit = {
  statuses: [2],
  diagnostics: [
    "Expected at least one target file. All matched files may have been excluded by ignore rules.",
  ],
};

export function isIgnoredFileExit(
  expected: IgnoredFileExit | undefined,
  result: FormatterExitResult,
): boolean {
  return (
    expected !== undefined &&
    result.status !== null &&
    expected.statuses.includes(result.status) &&
    expected.diagnostics.some(
      (diagnostic) => result.stderr.includes(diagnostic) || result.stdout.includes(diagnostic),
    )
  );
}
