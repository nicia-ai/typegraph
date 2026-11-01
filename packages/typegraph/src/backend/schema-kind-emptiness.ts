import type { GraphBackend, SchemaKindEmptinessProbe } from "./types";

type SchemaKindCountMembers = Pick<
  GraphBackend,
  "countNodesByKind" | "countEdgesByKind"
>;

/**
 * Counts the explicitly selected row population for a schema transition,
 * stopping at `limit` rows when one is given.
 */
export async function countSchemaKindRows(
  backend: SchemaKindCountMembers,
  graphId: string,
  probe: SchemaKindEmptinessProbe,
  limit?: number,
): Promise<number> {
  const rowScope = {
    excludeDeleted: probe.rows === "nonDeleted",
    temporalMode:
      probe.rows === "nonDeleted" ? "includeEnded" : "includeTombstones",
    ...(limit === undefined ? {} : { limit }),
  } as const;
  if (probe.entity === "node") {
    return backend.countNodesByKind({ graphId, kind: probe.kind, ...rowScope });
  }
  return backend.countEdgesByKind({ graphId, kind: probe.kind, ...rowScope });
}

/**
 * Whether the selected row population holds at least one row: the existence
 * form of {@link countSchemaKindRows}, which reads a single row rather than
 * the whole population.
 */
export async function schemaKindHasRows(
  backend: SchemaKindCountMembers,
  graphId: string,
  probe: SchemaKindEmptinessProbe,
): Promise<boolean> {
  return (await countSchemaKindRows(backend, graphId, probe, 1)) > 0;
}
