/**
 * lib/merge-events.ts
 *
 * Pure merge for polled call events: a duplicate id is ignored (the first
 * copy wins), the result is sorted by created_at (id breaks ties), and the
 * input arrays are not mutated.
 */

export interface MergeableEvent {
  id: string;
  created_at: string;
}

function compare(a: MergeableEvent, b: MergeableEvent): number {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mergeEvents<T extends MergeableEvent>(existing: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const e of existing) if (!byId.has(e.id)) byId.set(e.id, e);
  for (const e of incoming) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort(compare);
}
