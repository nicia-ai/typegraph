import { type DeclaredIndex } from "../profiler/types";
import { type EdgeIndex, type NodeIndex, type TypeGraphIndex } from "./types";

export function toDeclaredIndex(index: TypeGraphIndex): DeclaredIndex {
  if (index.__type === "typegraph_node_index") {
    return toDeclaredNodeIndex(index);
  }
  return toDeclaredEdgeIndex(index);
}

export function toDeclaredIndexes(
  indexes: readonly TypeGraphIndex[],
): readonly DeclaredIndex[] {
  return indexes.map((index) => toDeclaredIndex(index));
}

function toDeclaredNodeIndex(index: NodeIndex): DeclaredIndex {
  return {
    entityType: "node",
    kind: index.nodeKind,
    fields: [...index.fields],
    unique: index.unique,
    name: index.name,
  };
}

function toDeclaredEdgeIndex(index: EdgeIndex): DeclaredIndex {
  return {
    entityType: "edge",
    kind: index.edgeKind,
    fields: [...index.fields],
    unique: index.unique,
    name: index.name,
  };
}
