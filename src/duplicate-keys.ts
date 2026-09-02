/**
 * Shared duplicate-key detection used by every closed pre-App contract
 * validator/comparator (`src/administrator-plan.ts`,
 * `src/app-registration-plan.ts`, `src/deployment-topology.ts`).
 *
 * Building a `Map` or `Set` directly from a collection that may contain a
 * repeated logical key silently keeps or counts only one representative for
 * that key, discarding a conflicting duplicate entry instead of failing
 * closed on it. Every validator/comparator in this contract family calls
 * `findDuplicateKeys` first and rejects any repeated key before relying on
 * such a `Map`/`Set` for lookup or coverage.
 */
export function findDuplicateKeys<T>(
  items: readonly T[],
  keyOf: (item: T) => string
): readonly string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}
