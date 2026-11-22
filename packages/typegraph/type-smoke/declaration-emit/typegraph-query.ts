/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/query` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  composeFragments,
  countEdges,
  createFragment,
  createSqlSchema,
  fieldRef,
  jsonPointer,
  limitFragment,
  orderByFragment,
  recordedRelation,
} from "@nicia-ai/typegraph/query";

type AnyGraph = Parameters<typeof countEdges>[0] extends infer G ? G : never;

export const fragments = createFragment();
export const firstTen = limitFragment(10);
export const composed = composeFragments(limitFragment(5), limitFragment(10));
export const sqlSchema = createSqlSchema({ nodes: "app_nodes" });
export const pointer = jsonPointer(["address", "city"]);
export const nameRef = fieldRef("person", ["name"]);
export const edgeCount = countEdges;
export type QueryGraph = AnyGraph;
export const ordered = (...args: Parameters<typeof orderByFragment>) =>
  orderByFragment(...args);
export const relation = (...args: Parameters<typeof recordedRelation>) =>
  recordedRelation(...args);
