import { type DeclaredIndex } from "../profiler/types";
import { type IndexDeclaration } from "./types";

export function toDeclaredIndex(index: IndexDeclaration): DeclaredIndex {
  return {
    entityType: index.entity,
    kind: index.kind,
    fields: [...index.fields],
    unique: index.unique,
    name: index.name,
  };
}

export function toDeclaredIndexes(
  indexes: readonly IndexDeclaration[],
): readonly DeclaredIndex[] {
  return indexes.map((index) => toDeclaredIndex(index));
}
