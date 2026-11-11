/**
 * The /diff pane's view: the shared changes view with the pane's key hint and
 * key list. Hosts (dock, overlay) and the controller construct this.
 */
import { ChangesView, type ChangesViewOptions } from "../../lib/changes/view/changes-view.ts";

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
  "j/k move · ⏎ expand · n/N hunk · a ask · c note · s source · ? help · esc back";

/** The `?` key list, one entry per line. */
export const HELP_LINES: readonly string[] = [
  "j/k ↑/↓   move between files     g/G      first/last file",
  "⏎/space   expand or collapse     n/N      next/previous hunk",
  "a         put a reference to the selected file or hunk in the prompt",
  "c         add a note to the selected hunk",
  "C         put all notes into the editor (not sent)",
  "f/F       next/previous review finding",
  "s         cycle source: session, uncommitted, latest turn, branch base",
  "R         put a /review (agent review) instruction into the editor",
  "v         show a sensitive file's contents (this pane only, not saved)",
  "[ ]       wider/narrower        r        refresh",
  "esc/q     back to the editor     ?        close this list",
];

export type PaneViewDependencies = Omit<ChangesViewOptions, "keyHint" | "helpLines">;

export class PaneView extends ChangesView {
  constructor(dependencies: PaneViewDependencies) {
    super({ ...dependencies, keyHint: KEY_HINT, helpLines: HELP_LINES });
  }
}
