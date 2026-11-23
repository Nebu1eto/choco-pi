import { isCloseAllCommand, isCloseCommand } from "../command-taxonomy.ts";
import {
  canonicalizeExplicitArtifactDestination,
  getExplicitArtifactDestination,
} from "../orchestration/browser-run/artifact-paths.ts";
import type { AgentBrowserToolResult } from "../orchestration/browser-run/index.ts";
import { parseBatchCommandArgument, parseUserBatchStdin } from "../orchestration/batch-stdin.ts";
import { normalizeRequestedOutputPath } from "../orchestration/output-file.ts";
import { hasRuntimeType, isRecord } from "../parsing.ts";
import {
  assertRecordingDestinationsAvailable,
  getRecordingContactSheetRequest,
} from "../recording-contact-sheet.ts";
import {
  enumerateRecordingReservationDestinations,
  type ActiveRecordingReservation,
} from "../recording-reservations.ts";
import {
  getSessionArtifactManifestEntryKey,
  isPendingRecordingCommand,
  mergeSessionArtifactManifest,
} from "../results/artifact-manifest.ts";
import type { FileArtifactMetadata, SessionArtifactManifest } from "../results/contracts.ts";
import { extractUpstreamCommandTokens, validateToolArgs } from "../runtime.ts";
export interface ArtifactCommandSteps {
  batch: boolean;
  error?: string;
  steps: string[][];
}

export function getArtifactCommandSteps(
  args: string[],
  stdin: string | undefined,
): ArtifactCommandSteps {
  const commandTokens = extractUpstreamCommandTokens(args);
  const batch = commandTokens[0] === "batch";
  if (!batch) return { batch, steps: commandTokens.length > 0 ? [commandTokens] : [] };
  const steps: string[][] = [];
  for (const command of commandTokens.slice(1)) {
    if (command === "--bail") continue;
    const parsed = parseBatchCommandArgument(command);
    if (parsed.error || !parsed.step)
      return {
        batch,
        error: `Unsupported batch step ${steps.length + 1}: ${parsed.error ?? "command could not be parsed safely"}`,
        steps,
      };
    steps.push(parsed.step);
  }
  // Upstream executes raw argument steps exclusively when any exist, so ignored
  // stdin must not add artifact/lifecycle steps or fail this preflight.
  if (steps.length > 0) return { batch, steps };
  const parsed = parseUserBatchStdin(stdin);
  return parsed.error
    ? { batch, error: parsed.error, steps }
    : { batch, steps: parsed.steps ?? [] };
}

export function getArtifactPreflightValidationError(options: {
  activeRecordingReservations?: Iterable<ActiveRecordingReservation>;
  args: string[];
  cwd: string;
  outputPath?: string;
  stdin?: string;
}): string | undefined {
  const { batch, error, steps } = getArtifactCommandSteps(options.args, options.stdin);
  if (error) return error;

  const activeRecordingDestinations = new Set<string>();
  const cleanupOnly =
    steps.length > 0 &&
    steps.every((step) => {
      const [command, subcommand] = extractUpstreamCommandTokens(step);
      return isCloseCommand(command) || (command === "record" && subcommand === "stop");
    });
  for (const reservation of options.activeRecordingReservations ?? []) {
    try {
      for (const destination of enumerateRecordingReservationDestinations(reservation))
        activeRecordingDestinations.add(
          canonicalizeExplicitArtifactDestination(reservation.cwd, destination.absolutePath),
        );
    } catch (canonicalizationError) {
      if (!cleanupOnly)
        return canonicalizationError instanceof Error
          ? canonicalizationError.message
          : "An active recording destination could not be resolved safely.";
    }
  }

  let canonicalOutputPath: string | undefined;
  if (options.outputPath) {
    try {
      canonicalOutputPath = canonicalizeExplicitArtifactDestination(
        options.cwd,
        normalizeRequestedOutputPath(options.outputPath),
      );
      if (activeRecordingDestinations.has(canonicalOutputPath)) {
        return `Unsupported output_path: ${options.outputPath} is reserved by an active recording. Stop that recording first or use a distinct path.`;
      }
    } catch (canonicalizationError) {
      return canonicalizationError instanceof Error
        ? canonicalizationError.message
        : `output_path ${options.outputPath} could not be resolved safely.`;
    }
  }
  const artifactDestinations = new Map<string, number>();
  let sawBatchClose = false;
  for (const [index, step] of steps.entries()) {
    const commandStep = extractUpstreamCommandTokens(step);
    if (batch) {
      const stepValidationError = validateToolArgs(step);
      if (stepValidationError) return `Unsupported batch step ${index + 1}: ${stepValidationError}`;
      if (
        sawBatchClose &&
        commandStep[0] === "record" &&
        (commandStep[1] === "start" || commandStep[1] === "restart")
      ) {
        return `Unsupported batch step ${index + 1}: record ${commandStep[1]} cannot follow close, quit, or exit in one upstream batch because upstream can report success without starting a recording. Split the close and recording into separate agent_browser calls.`;
      }
      if (isCloseCommand(commandStep[0])) sawBatchClose = true;
    }
    const artifactDestination = getExplicitArtifactDestination(commandStep);
    if (artifactDestination) {
      let canonicalDestination: string;
      try {
        canonicalDestination = canonicalizeExplicitArtifactDestination(
          options.cwd,
          artifactDestination,
        );
      } catch (canonicalizationError) {
        return canonicalizationError instanceof Error
          ? canonicalizationError.message
          : `Artifact destination ${artifactDestination} could not be resolved safely.`;
      }
      if (canonicalOutputPath === canonicalDestination) {
        return `Unsupported output_path: ${options.outputPath} resolves to the same destination as artifact path ${artifactDestination}. Use distinct paths so the tool-result JSON cannot overwrite the browser artifact.`;
      }
      if (activeRecordingDestinations.has(canonicalDestination)) {
        const prefix = batch
          ? `Unsupported batch artifact destination in step ${index + 1}`
          : "Unsupported artifact destination";
        return `${prefix}: ${artifactDestination} is reserved by an active recording. Stop that recording first or use a distinct path.`;
      }
      const priorStep = artifactDestinations.get(canonicalDestination);
      if (priorStep !== undefined) {
        return `Unsupported batch artifact destination in step ${index + 1}: ${artifactDestination} is already written by step ${priorStep + 1}. Use distinct paths or split the batch so each artifact can be verified independently.`;
      }
      artifactDestinations.set(canonicalDestination, index);
    }
    if (batch && commandStep[0] === "screenshot" && step.includes("--annotate")) {
      return [
        `Unsupported batch screenshot annotation in step ${index + 1}: put --annotate in top-level args, not inside the batch step.`,
        `Use: { "args": ["--annotate", "batch"], "stdin": "[[\\"screenshot\\",\\"/path/to/image.png\\"]]" }`,
      ].join("\n");
    }
  }
  return undefined;
}

export async function getRecordingDestinationPreflightError(options: {
  activeRecordingReservations: Iterable<ActiveRecordingReservation>;
  args: string[];
  cwd: string;
  outputPath?: string;
  stdin?: string;
}): Promise<string | undefined> {
  const parsed = getArtifactCommandSteps(options.args, options.stdin);
  if (parsed.error) return parsed.error;
  const activeAbsolutePaths = new Set<string>();
  for (const reservation of options.activeRecordingReservations) {
    for (const destination of enumerateRecordingReservationDestinations(reservation))
      activeAbsolutePaths.add(destination.absolutePath);
  }
  const outputAbsolutePath = options.outputPath
    ? canonicalizeExplicitArtifactDestination(
        options.cwd,
        normalizeRequestedOutputPath(options.outputPath),
      )
    : undefined;
  const destinations: Array<{ absolutePath: string; path: string }> = [];
  for (const step of parsed.steps) {
    const command = extractUpstreamCommandTokens(step);
    if (command[0] !== "record" || !["start", "restart"].includes(command[1] ?? "")) continue;
    const videoPath = getExplicitArtifactDestination(command);
    if (!videoPath) continue;
    destinations.push({
      absolutePath: canonicalizeExplicitArtifactDestination(options.cwd, videoPath),
      path: videoPath,
    });
    const contactSheet = getRecordingContactSheetRequest(command, options.cwd).destination;
    if (contactSheet)
      destinations.push({
        absolutePath: canonicalizeExplicitArtifactDestination(
          options.cwd,
          contactSheet.absolutePath,
        ),
        path: contactSheet.path,
      });
  }
  if (destinations.length === 0) return undefined;
  try {
    await assertRecordingDestinationsAvailable({
      activeAbsolutePaths,
      destinations,
      outputAbsolutePath,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Recording destinations could not be checked safely.";
  }
}

export function commandClosesAllSessions(args: string[], stdin: string | undefined): boolean {
  const parsed = getArtifactCommandSteps(args, stdin);
  return (
    !parsed.error &&
    parsed.steps.some((step) => isCloseAllCommand(extractUpstreamCommandTokens(step)))
  );
}

export function commandTouchesArtifactLifecycle(
  args: string[],
  stdin: string | undefined,
  outputPath?: string,
): boolean {
  if (outputPath) return true;
  const parsed = getArtifactCommandSteps(args, stdin);
  if (parsed.error) return true;
  return parsed.steps.some((step) => {
    const commandStep = extractUpstreamCommandTokens(step);
    return (
      getExplicitArtifactDestination(commandStep) !== undefined ||
      commandStep[0] === "record" ||
      commandStep[0] === "screenshot" ||
      isCloseCommand(commandStep[0])
    );
  });
}

export function isResultFileArtifact<Artifact>(
  artifact: Artifact,
): artifact is Artifact & FileArtifactMetadata {
  return (
    isRecord(artifact) &&
    hasRuntimeType(artifact.absolutePath, "string") &&
    hasRuntimeType(artifact.kind, "string") &&
    hasRuntimeType(artifact.path, "string")
  );
}

export function getResultFileArtifacts(result: AgentBrowserToolResult): FileArtifactMetadata[] {
  const details = isRecord(result.details) ? result.details : undefined;
  return Array.isArray(details?.artifacts) ? details.artifacts.filter(isResultFileArtifact) : [];
}

export function reportsNoRecordingInProgress<Value>(value: Value): boolean {
  try {
    return /no recording in progress/i.test(JSON.stringify(value));
  } catch {
    return false;
  }
}

export function batchStepReportsNoRecordingInProgress<Step>(step: Step): boolean {
  if (!isRecord(step) || step.success !== false) return false;
  const command =
    Array.isArray(step.command) && step.command.every((token) => hasRuntimeType(token, "string"))
      ? extractUpstreamCommandTokens(step.command)
      : [];
  return command[0] === "record" && command[1] === "stop" && reportsNoRecordingInProgress(step);
}

export function resultReportsNoRecordingInProgress(result: AgentBrowserToolResult): boolean {
  if (result.isError !== true) return false;
  const details = isRecord(result.details) ? result.details : undefined;
  return (
    details?.command === "record" &&
    details.subcommand === "stop" &&
    reportsNoRecordingInProgress(result.content)
  );
}

export function mergeBrowserRunMap<K, V>(
  current: Map<K, V>,
  initial: Map<K, V>,
  updated: Map<K, V>,
): Map<K, V> {
  if (updated === initial) return current;
  const merged = new Map(current);
  for (const [key, value] of updated) {
    if (!initial.has(key) || initial.get(key) !== value) merged.set(key, value);
  }
  for (const key of initial.keys()) {
    if (!updated.has(key)) merged.delete(key);
  }
  return merged;
}

export function mergeBrowserRunArtifactManifest(
  current: SessionArtifactManifest | undefined,
  initial: SessionArtifactManifest | undefined,
  updated: SessionArtifactManifest | undefined,
): SessionArtifactManifest | undefined {
  if (!updated || updated === initial) return current;
  if (current === initial) return updated;
  const initialEntries = new Map(
    (initial?.entries ?? []).map((entry) => [getSessionArtifactManifestEntryKey(entry), entry]),
  );
  const changedEntries = updated.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => initialEntries.get(getSessionArtifactManifestEntryKey(entry)) !== entry)
    .sort(
      (left, right) =>
        left.entry.createdAtMs - right.entry.createdAtMs ||
        Number(
          isPendingRecordingCommand(left.entry.command, left.entry.subcommand, left.entry.kind),
        ) -
          Number(
            isPendingRecordingCommand(
              right.entry.command,
              right.entry.subcommand,
              right.entry.kind,
            ),
          ) ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
  return changedEntries.length === 0
    ? current
    : mergeSessionArtifactManifest({
        base: current,
        entries: changedEntries,
        nowMs: Math.max(Date.now(), (current?.updatedAtMs ?? 0) + 1, updated.updatedAtMs),
      });
}
