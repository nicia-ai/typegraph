/**
 * Index Utilities
 *
 * Type-safe index definitions + helpers for generating DDL and integrating
 * with Drizzle schema definitions.
 *
 * @example Drizzle schema integration
 * ```ts
 * import { defineNode } from "@nicia-ai/typegraph";
 * import { createPostgresTables } from "@nicia-ai/typegraph/postgres";
 * import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
 * import { z } from "zod";
 *
 * const Person = defineNode("Person", {
 *   schema: z.object({ email: z.string().email(), name: z.string() }),
 * });
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
  EdgeIndex,
  EdgeIndexConfig,
  EdgeIndexDirection,
  EdgeIndexWhereBuilder,
  IndexScope,
  IndexWhereExpression,
  IndexWhereFieldBuilder,
  IndexWhereInput,
  NodeIndex,
  NodeIndexConfig,
  NodeIndexWhereBuilder,
  SystemColumnName,
  TypeGraphIndex,
} from "./types";
export { andWhere, notWhere, orWhere } from "./where";
