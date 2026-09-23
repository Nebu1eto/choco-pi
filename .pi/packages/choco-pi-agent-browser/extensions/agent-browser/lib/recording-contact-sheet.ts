import { access } from "node:fs/promises";
import { extname, parse, resolve } from "node:path";

export interface RecordingContactSheetDestination {
  absolutePath: string;
  kind: "image";
  path: string;
  role: "contact-sheet";
}

export interface RecordingContactSheetRequest {
  destination?: RecordingContactSheetDestination;
  enabled: boolean;
}

/**
 * agent-browser 0.38.1 enables the sheet for either contact-sheet flag. Its
 * recording module places the PNG beside the video using this suffix.
 */
export function deriveAgentBrowser0381ContactSheetPath(videoPath: string): string {
  const parsed = parse(videoPath);
  return `${parsed.dir ? `${parsed.dir}/` : ""}${parsed.name}.contact-sheet.png`;
}

export function getRecordingContactSheetRequest(
  args: readonly string[],
  cwd: string,
): RecordingContactSheetRequest {
  if (args[0] !== "record" || (args[1] !== "start" && args[1] !== "restart"))
    return { enabled: false };
  const videoPath = args[2];
  if (!videoPath) return { enabled: false };
  const enabled = args.includes("--contact-sheet") || args.includes("--contact-sheet-threshold");
  if (!enabled) return { enabled: false };
  const path = deriveAgentBrowser0381ContactSheetPath(videoPath);
  return {
    destination: { absolutePath: resolve(cwd, path), kind: "image", path, role: "contact-sheet" },
    enabled: true,
  };
}

export async function assertRecordingDestinationsAvailable(options: {
  activeAbsolutePaths: ReadonlySet<string>;
  destinations: readonly { absolutePath: string; path: string }[];
  outputAbsolutePath?: string;
}): Promise<void> {
  const seen = new Set<string>();
  for (const destination of options.destinations) {
    if (seen.has(destination.absolutePath))
      throw new Error(`Recording destinations collide at '${destination.path}'.`);
    seen.add(destination.absolutePath);
    if (options.outputAbsolutePath === destination.absolutePath)
      throw new Error(`Recording destination '${destination.path}' collides with outputPath.`);
    if (options.activeAbsolutePaths.has(destination.absolutePath))
      throw new Error(
        `Recording destination '${destination.path}' is reserved by an active recording.`,
      );
    try {
      await access(destination.absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw new Error(`Recording destination '${destination.path}' could not be checked safely.`);
    }
    throw new Error(`Recording destination '${destination.path}' already exists.`);
  }
}

export function isRecordingVideoPath(path: string): boolean {
  return [".mp4", ".webm"].includes(extname(path).toLowerCase());
}
