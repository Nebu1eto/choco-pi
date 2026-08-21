import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { restoreGitSnapshot, type GitSnapshot } from "./git-snapshot.ts";

/** The session controls a rollback needs, narrowed so tests can supply them. */
export type RollbackHost = Pick<ExtensionCommandContext, "cwd" | "navigateTree">;

export type SnapshotRestorer = (
  cwd: string,
  target: GitSnapshot,
  safety: GitSnapshot,
) => Promise<void>;

/**
 * Restores files first, then moves the conversation.
 *
 * Files are restored before navigation because a cancelled or failed navigation
 * is recoverable: the working tree goes back to `safety` and the session is left
 * exactly as it was. The reverse order would leave the conversation ahead of the
 * files with nothing to undo it.
 */
export async function restoreTurn(
  host: RollbackHost,
  target: GitSnapshot,
  conversationTargetId: string,
  safety: GitSnapshot,
  restore: SnapshotRestorer = restoreGitSnapshot,
): Promise<void> {
  await restore(host.cwd, target, safety);
  try {
    const navigation = await host.navigateTree(conversationTargetId, { summarize: false });
    if (navigation.cancelled) throw new Error("Conversation rewind was cancelled.");
  } catch (error) {
    try {
      await restore(host.cwd, safety, target);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Conversation rewind failed and the files could not be put back.",
      );
    }
    throw error;
  }
}
