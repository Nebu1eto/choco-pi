import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { restoreGitSnapshot, type GitSnapshot } from "./git-snapshot.ts";

export type RollbackHost = Pick<ExtensionCommandContext, "cwd" | "navigateTree">;

export type SnapshotRestorer = (
  cwd: string,
  target: GitSnapshot,
  safety: GitSnapshot,
) => Promise<void>;

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
