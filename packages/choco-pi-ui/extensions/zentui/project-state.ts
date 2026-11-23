import type { GitReadResult } from "./git.ts";
import { emptyGitStatus } from "./git.ts";
import type { PackageVersionReadResult } from "./package-version.ts";
import type { RuntimeReadResult } from "./runtime.ts";
import type { FooterState } from "./state.ts";

export function applyProjectRefreshToState(
  state: FooterState,
  args: {
    cwd: string;
    previousCwd: string | undefined;
    git: GitReadResult;
    runtime: RuntimeReadResult;
    packageVersion?: PackageVersionReadResult;
  },
): string {
  const cwdChanged = args.previousCwd !== undefined && args.previousCwd !== args.cwd;

  if (cwdChanged) {
    Object.assign(state, emptyGitStatus());
    state.runtime = undefined;
    state.packageVersion = undefined;
  }

  if (args.git.kind === "ok") {
    Object.assign(state, args.git.status);
  } else if (args.git.kind === "not_a_repo") {
    Object.assign(state, emptyGitStatus());
  }

  if (args.runtime.kind === "ok") {
    state.runtime = args.runtime.runtime;
  } else if (cwdChanged && args.runtime.kind === "error") {
    state.runtime = undefined;
  }

  if (args.packageVersion !== undefined) {
    if (args.packageVersion.kind === "ok") {
      state.packageVersion = args.packageVersion.result ?? undefined;
    } else if (!cwdChanged) {
    } else {
      state.packageVersion = undefined;
    }
  }

  return args.cwd;
}
