export type SubmittedMailboxClaim = {
  claimedPath: string;
  sourcePath: string;
  submittedAt: number;
};

/** Atomically reserves a message ID before host submission so recovery scans cannot resubmit it. */
export function reserveMailboxSubmission(
  submitted: Map<string, SubmittedMailboxClaim>,
  messageId: string,
  claim: SubmittedMailboxClaim,
): boolean {
  if (submitted.has(messageId)) return false;
  submitted.set(messageId, claim);
  return true;
}

export function releaseMailboxSubmission(
  submitted: Map<string, SubmittedMailboxClaim>,
  messageId: string,
): void {
  submitted.delete(messageId);
}
