import { type DeclaredIndex } from "../profiler/types";
import {
  type IndexDeclaration,
  type RelationalIndexDeclaration,
} from "./types";

export function toDeclaredIndex(
  index: RelationalIndexDeclaration,
): DeclaredIndex {
  return {
    entityType: index.entity,
    kind: index.kind,
    fields: [...index.fields],
    unique: index.unique,
    name: index.name,
  };
}

/**
 * Vector indexes are excluded from the profiler-format conversion —
 * the profiler operates on relational tables (`typegraph_nodes` /
 * `typegraph_edges`) where index hits / misses can be measured against
 * SQL plans. Vector indexes live on the embeddings table with a
 * different access pattern.
 */
export function toDeclaredIndexes(
  indexes: readonly IndexDeclaration[],
): readonly DeclaredIndex[] {
  return indexes
    .filter(
      (index): index is RelationalIndexDeclaration =>
        index.entity === "node" || index.entity === "edge",
    )
    .map((index) => toDeclaredIndex(index));
}
