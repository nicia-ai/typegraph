import { sql, type SqlFragment } from "../sql-fragment";

type KindFilterCompiler = (overlappingKinds: readonly string[]) => SqlFragment;

/**
 * Prevents a direction:"both" traversal from returning a true self-loop twice.
 * Node identity is `(kind, id)`, so equal ids across different kinds remain a
 * real two-node edge and must not be suppressed.
 */
export function compileInverseTraversalDuplicateGuard(
  directEdgeKinds: readonly string[],
  inverseEdgeKinds: readonly string[],
  compileKindFilter: KindFilterCompiler,
): SqlFragment | undefined {
  const overlappingKinds = inverseEdgeKinds.filter((kind) =>
    directEdgeKinds.includes(kind),
  );
  if (overlappingKinds.length === 0) {
    return undefined;
  }
  return sql`NOT (e.from_id = e.to_id AND e.from_kind = e.to_kind AND ${compileKindFilter(overlappingKinds)})`;
}
