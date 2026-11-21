/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/indexes` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  andWhere,
  defineEdgeIndex,
  defineNodeIndex,
  generateIndexDDL,
  SYSTEM_INDEX_DECLARATIONS,
  toDeclaredIndexes,
} from "@nicia-ai/typegraph/indexes";

type IndexedNode = Parameters<typeof defineNodeIndex>[0];
type IndexedEdge = Parameters<typeof defineEdgeIndex>[0];

export const emailIndex = (node: IndexedNode) =>
  defineNodeIndex(node, { fields: ["email"] });

export const roleIndex = (edge: IndexedEdge) =>
  defineEdgeIndex(edge, { fields: ["role"], direction: "out" });

export const indexes = (node: IndexedNode, edge: IndexedEdge) =>
  [emailIndex(node), roleIndex(edge)] as const;

export const ddl = (...args: Parameters<typeof generateIndexDDL>) =>
  generateIndexDDL(...args);

export const declared = (...args: Parameters<typeof toDeclaredIndexes>) =>
  toDeclaredIndexes(...args);

export const systemIndexes = SYSTEM_INDEX_DECLARATIONS;
export const combine = andWhere;
