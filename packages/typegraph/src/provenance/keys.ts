import { type EdgeRow, type NodeRow } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import { compareStrings } from "../utils/compare";
import { type NodeKind, type ProvenanceNodeRef } from "./types";

const KEY_SEPARATOR = "\u0000";

export function refKey(ref: ProvenanceNodeRef): string {
  return `${ref.kind}${KEY_SEPARATOR}${ref.id}`;
}

export function rowKey(row: Pick<NodeRow, "kind" | "id">): string {
  return refKey({ kind: row.kind, id: row.id });
}

export function edgeFromKey(edge: EdgeRow): string {
  return refKey({ kind: edge.from_kind, id: edge.from_id });
}

export function edgeToKey(edge: EdgeRow): string {
  return refKey({ kind: edge.to_kind, id: edge.to_id });
}

export function keyToRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
>(key: string): ProvenanceNodeRef<G, K> {
  const separatorIndex = key.indexOf(KEY_SEPARATOR);
  if (separatorIndex === -1) {
    throw new ConfigurationError(
      "Invalid provenance identity key.",
      { key },
      {
        suggestion:
          "Report this TypeGraph provenance bug with the graph roles that produced the key.",
      },
    );
  }
  const kind = key.slice(0, separatorIndex);
  const id = key.slice(separatorIndex + KEY_SEPARATOR.length);
  return { kind, id } as ProvenanceNodeRef<G, K>;
}

export function sortedReferences<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
>(keys: Iterable<string>): ProvenanceNodeRef<G, K>[] {
  return [...keys]
    .toSorted((left, right) => compareStrings(left, right))
    .map((key) => keyToRef<G, K>(key));
}

export function uniqueNodeReferences(
  references: readonly ProvenanceNodeRef[],
): ProvenanceNodeRef[] {
  const byKey = new Map<string, ProvenanceNodeRef>();
  for (const reference of references) {
    byKey.set(refKey(reference), { kind: reference.kind, id: reference.id });
  }
  return [...byKey.values()];
}
