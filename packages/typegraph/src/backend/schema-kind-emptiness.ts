import type { GraphBackend, SchemaKindEmptinessProbe } from "./types";

type SchemaKindCountMembers = Pick<
  GraphBackend,
  "countNodesByKind" | "countEdgesByKind"
>;

/** Counts the explicitly selected row population for a schema transition. */
export async function countSchemaKindRows(
  backend: SchemaKindCountMembers,
  graphId: string,
  probe: SchemaKindEmptinessProbe,
): Promise<number> {
  const rowScope = {
    excludeDeleted: probe.rows === "nonDeleted",
    temporalMode:
      probe.rows === "nonDeleted" ? "includeEnded" : "includeTombstones",
  } as const;
  if (probe.entity === "node") {
    return backend.countNodesByKind({ graphId, kind: probe.kind, ...rowScope });
  }
  return backend.countEdgesByKind({ graphId, kind: probe.kind, ...rowScope });
}
