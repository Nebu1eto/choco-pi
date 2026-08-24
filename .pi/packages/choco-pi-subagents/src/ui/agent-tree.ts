export type AgentTreeRecord = {
  id: string;
  parentAgentId?: string;
  startedAt: number;
};

export type AgentTreeRow<T extends AgentTreeRecord> = {
  record: T;
  depth: number;
};

/** Group children directly under their parent while preserving launch order at every level. */
export function buildAgentTree<T extends AgentTreeRecord>(
  records: readonly T[],
): AgentTreeRow<T>[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const record of records) {
    const parentId = record.parentAgentId;
    if (parentId === undefined || !byId.has(parentId)) {
      roots.push(record);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(record);
    children.set(parentId, siblings);
  }

  const byStartedAt = (left: T, right: T) => left.startedAt - right.startedAt;
  roots.sort(byStartedAt);
  for (const siblings of children.values()) siblings.sort(byStartedAt);

  const rows: AgentTreeRow<T>[] = [];
  const append = (record: T, depth: number): void => {
    rows.push({ record, depth });
    for (const child of children.get(record.id) ?? []) append(child, depth + 1);
  };
  for (const root of roots) append(root, 0);
  return rows;
}
