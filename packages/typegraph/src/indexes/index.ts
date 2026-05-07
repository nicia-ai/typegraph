/**
 * Index Utilities
 *
 * Type-safe index definitions + helpers for generating DDL and integrating
 * with Drizzle schema definitions.
 *
 * The recommended way to attach indexes to a graph is to pass them through
 * `defineGraph({ ..., indexes: [...] })`. They flow into
 * `SerializedSchema.indexes` and can be materialized via the same code
 * path as runtime-declared indexes.
 *
 * @example Indexes via defineGraph
 * ```ts
 * import { defineGraph, defineNode, defineNodeIndex } from "@nicia-ai/typegraph";
 * import { z } from "zod";
 *
 * const Person = defineNode("Person", {
 *   schema: z.object({ email: z.string().email(), name: z.string() }),
 * });
 *
 * const personEmail = defineNodeIndex(Person, { fields: ["email"] });
 *
 * const graph = defineGraph({
 *   id: "social",
 *   nodes: { Person: { type: Person } },
 *   edges: {},
 *   indexes: [personEmail],
 * });
 * ```
 *
 * @example Direct Drizzle schema integration (lower-level)
 * ```ts
 * import { createPostgresTables } from "@nicia-ai/typegraph/postgres";
 * import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
 *
 * const personEmail = defineNodeIndex(Person, { fields: ["email"] });
 *
 * // drizzle-kit will include the index in generated migrations
 * export const tables = createPostgresTables({}, { indexes: [personEmail] });
 * ```
 */

export {
  generateEdgeIndexDDL,
  generateIndexDDL,
  type GenerateIndexDdlOptions,
  generateNodeIndexDDL,
} from "./ddl";
export { defineEdgeIndex, defineNodeIndex } from "./define-index";
export {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
  buildSqliteEdgeIndexBuilders,
  buildSqliteNodeIndexBuilders,
} from "./drizzle";
export { toDeclaredIndex, toDeclaredIndexes } from "./profiler";
export type {
  EdgeIndexConfig,
  EdgeIndexDeclaration,
  EdgeIndexDirection,
  EdgeIndexWhereBuilder,
  IndexDeclaration,
  IndexOrigin,
  IndexScope,
  IndexWhereExpression,
  IndexWhereFieldBuilder,
  IndexWhereInput,
  NodeIndexConfig,
  NodeIndexDeclaration,
  NodeIndexWhereBuilder,
  RelationalIndexDeclaration,
  SystemColumnName,
  VectorIndexDeclaration,
  VectorIndexImplementation,
  VectorIndexMetric,
  VectorIndexParams,
} from "./types";
export { andWhere, notWhere, orWhere } from "./where";
