/**
 * The /diff pane's view: the shared changes view with the pane's key hint and
 * key list. Hosts (dock, overlay) and the controller construct this.
 */
import { ChangesView, type ChangesViewOptions } from "../../lib/changes/view/changes-view.ts";
import { COPY_KEY } from "../../lib/changes/view/keys.ts";

export {
  ChangesView,
  findingKey,
  normalizeFindingPath,
  renderUnifiedBody,
  terminalSafeFile,
  type AskTarget,
  type ChangesViewOptions,
  type FileBodyRenderer,
  type PaneActions,
} from "../../lib/changes/view/changes-view.ts";

export const KEY_HINT =
  "j/k file · ↑↓ line · ⇧↑↓ range · c note · a ask · ←→ turn · tab editor · ? help";

/** The `?` key list, one entry per line. */
export const HELP_LINES: readonly string[] = [
  "j/k       move between files     g/G      top/bottom",
  "↑/↓       move through file rows and the lines of open files",
  "⇧↑/⇧↓     select a range of lines (or drag over them with the mouse)",
  "⏎/space   expand or collapse the file (or click its row)",
  "n/N       next/previous hunk",
  "a         put a reference to the selected file, hunk or lines in the prompt (not sent);",
  "          with notes, put all of them in the prompt as one message instead",
  "c         add a note to the selected hunk, to ask about with a",
  "f/F       next/previous review finding",
  "s         cycle source: session, uncommitted, latest turn, branch base",
  "←/→       one turn's changes alone: ← older, → newer, and the whole session after the newest",
  `${COPY_KEY.label.toLowerCase().padEnd(10)}copy the selected lines as code, or the whole hunk as a diff on its header`,
  "R         put a /review (agent review) instruction into the editor",
  "v         show a sensitive file's contents (this pane only, not saved)",
  "[ ]       wider/narrower        r        refresh",
  "tab/esc/q/⇧←  back to the editor (⇧→ or a click comes back)   ?  close this list",
];

export type PaneViewDependencies = Omit<ChangesViewOptions, "keyHint" | "helpLines">;

export class PaneView extends ChangesView {
  constructor(dependencies: PaneViewDependencies) {
    super({
      // The line cursor, with a hunk's header as the stop that selects the whole hunk.
      cursor: "line",
      hunkStops: true,
      freeSelection: true,
      enterFolds: false,
      ...dependencies,
      keyHint: KEY_HINT,
      helpLines: HELP_LINES,
    });
  }
}
