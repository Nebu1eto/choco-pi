/** `/diff` argument grammar. */
import type { DiffSource } from "../../lib/changes/git/model.ts";

export type DiffCommand =
  | { kind: "toggle" | "open" | "close" | "focus" | "refresh" }
  | { kind: "width"; width: number }
  | { kind: "source"; source: DiffSource }
  /** `turn` undefined means the latest turn that has a checkpoint. */
  | { kind: "source-turn"; turn: number | undefined }
  /** `base` undefined means the repository's default base (see default-base.ts). */
  | { kind: "source-branch"; base: string | undefined }
  /** `enabled` undefined asks for the current setting. */
  | { kind: "auto"; enabled: boolean | undefined }
  | { kind: "notes"; action: "send" | "clear" }
  | { kind: "review" }
  | { kind: "invalid"; message: string };

export const DIFF_USAGE =
  "Usage: /diff [open | close | focus | width <columns> | refresh | source session | source uncommitted | source turn [<n>] | source branch [<base>] | auto on | auto off | notes send | notes clear | review]";

const SOURCE_USAGE = "Usage: /diff source session | uncommitted | turn [<n>] | branch [<base>]";

/** Base used by `/diff source branch` when none is given and none can be resolved from git. */
export const FALLBACK_BRANCH_BASE = "main";

export const DIFF_SUBCOMMANDS = [
  { value: "open", description: "Open the diff pane on this session's changes" },
  { value: "close", description: "Close the diff pane" },
  { value: "focus", description: "Move keyboard focus into the pane" },
  { value: "width", description: "Set the pane width in columns" },
  { value: "refresh", description: "Re-read the working tree now" },
  { value: "source session", description: "Changes made since this session began (default)" },
  { value: "source uncommitted", description: "Compare HEAD with the working tree" },
  { value: "source turn", description: "Compare the working tree with a turn's checkpoint" },
  { value: "source branch", description: "Compare the merge base with a branch" },
  { value: "auto on", description: "Open the pane by itself when the agent changes code" },
  { value: "auto off", description: "Never open the pane by itself" },
  {
    value: "notes send",
    description: "Put all notes into the editor as one message and clear them",
  },
  { value: "notes clear", description: "Remove all notes" },
  { value: "review", description: "Put an agent review instruction into the editor" },
] as const;

export function parseDiffCommand(args: string): DiffCommand {
  const words = args
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  const [verb, ...rest] = words;
  if (verb === undefined) return { kind: "toggle" };
  switch (verb) {
    case "open":
    case "close":
    case "focus":
    case "refresh":
    case "review":
      return rest.length === 0 ? { kind: verb } : { kind: "invalid", message: DIFF_USAGE };
    case "width": {
      const value = rest.length === 1 ? Number(rest[0]) : Number.NaN;
      if (!Number.isInteger(value) || value <= 0) {
        return { kind: "invalid", message: "Usage: /diff width <columns>" };
      }
      return { kind: "width", width: value };
    }
    case "source": {
      const [kind, base, ...extra] = rest;
      if (kind === "session" && base === undefined) {
        return { kind: "source", source: { kind: "session" } };
      }
      if (kind === "uncommitted" && base === undefined) {
        return { kind: "source", source: { kind: "uncommitted" } };
      }
      if (kind === "turn" && extra.length === 0) {
        if (base === undefined) return { kind: "source-turn", turn: undefined };
        const turn = Number(base);
        if (Number.isInteger(turn) && turn > 0 && /^\d+$/u.test(base)) {
          return { kind: "source-turn", turn };
        }
        return { kind: "invalid", message: "Usage: /diff source turn [<n>] (n is a turn number)" };
      }
      if (kind === "branch" && extra.length === 0) {
        return { kind: "source-branch", base };
      }
      return { kind: "invalid", message: SOURCE_USAGE };
    }
    case "auto": {
      const [setting, ...extra] = rest;
      if (extra.length === 0 && (setting === undefined || setting === "on" || setting === "off")) {
        return { kind: "auto", enabled: setting === undefined ? undefined : setting === "on" };
      }
      return { kind: "invalid", message: "Usage: /diff auto on | auto off" };
    }
    case "notes": {
      const [action, ...extra] = rest;
      if ((action === "send" || action === "clear") && extra.length === 0) {
        return { kind: "notes", action };
      }
      return { kind: "invalid", message: "Usage: /diff notes send | notes clear" };
    }
    default:
      return { kind: "invalid", message: DIFF_USAGE };
  }
}
