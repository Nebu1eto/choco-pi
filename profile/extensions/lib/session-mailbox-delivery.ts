export type SubmittedMailboxClaim = {
  claimedPath: string;
  sourcePath: string;
  submittedAt: number;
};

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
