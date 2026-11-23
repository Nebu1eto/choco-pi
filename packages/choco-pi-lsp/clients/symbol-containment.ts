export interface OwnerCandidate {
  name: string;
  startLine: number;
  endLine: number;
}

export function findOwnerName(
  candidates: OwnerCandidate[],
  targetStart: number,
  targetEnd: number,
): string | undefined {
  let best: OwnerCandidate | undefined;
  for (const candidate of candidates) {
    const span = candidate.endLine - candidate.startLine;
    const targetSpan = targetEnd - targetStart;
    const contains =
      candidate.startLine <= targetStart && candidate.endLine >= targetEnd && span > targetSpan;
    if (!contains) continue;
    if (!best || span < best.endLine - best.startLine) best = candidate;
  }
  return best?.name;
}

export function buildQualifiedName(
  ownerName: string | undefined,
  symbolName: string,
): string | undefined {
  return ownerName ? `${ownerName}.${symbolName}` : undefined;
}
