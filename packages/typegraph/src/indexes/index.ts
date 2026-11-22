/**
 * Index Utilities
 *
 * Type-safe index definitions + helpers for generating portable DDL. Drizzle
 * schema-builder helpers live in the explicit `adapters/drizzle/indexes`
 * entrypoint so this module remains safe for strict non-Drizzle consumers.
 *
 * The recommended way to attach indexes to a graph is to pass them through
 * `defineGraph({ ..., indexes: [...] })`. They flow into
 * `SerializedSchema.indexes` and can be materialized via the same code
 * path as graph-extension-declared indexes.
 *
 * @example Indexes via defineGraph
 * ```ts
 * import { defineGraph, defineNode } from "@nicia-ai/typegraph";
 * import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
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
 * import { createPostgresTables } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
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
export { toDeclaredIndex, toDeclaredIndexes } from "./profiler";
export {
  generateSystemIndexDDL,
  SYSTEM_INDEX_DECLARATIONS,
  type SystemIndexDeclaration,
  type SystemIndexPredicate,
  type SystemIndexTable,
} from "./system";
export type {
  EdgeIndexConfig,
  EdgeIndexDeclaration,
  EdgeIndexDirection,
  EdgeIndexWhereBuilder,
  IndexDeclaration,
  IndexDeclarationBase,
  IndexOrigin,
  IndexScope,
  IndexWhereExpression,
  IndexWhereFieldBuilder,
  IndexWhereInput,
  IndexWhereLiteral,
  IndexWhereOp,
  IndexWhereOperand,
  NodeIndexConfig,
  NodeIndexDeclaration,
  NodeIndexKey,
  NodeIndexKeyInput,
  NodeIndexWhereBuilder,
  NodeSystemColumnName,
  RelationalIndexDeclaration,
  RelationalIndexMethod,
  SystemColumnName,
  VectorIndexDeclaration,
  VectorIndexImplementation,
  VectorIndexMetric,
  VectorIndexParams,
} from "./types";
export { NODE_SYSTEM_COLUMN_NAMES } from "./types";
export { andWhere, notWhere, orWhere } from "./where";

/**
 * Types the public declarations name without being everyday API: exported so
 * a consumer's declaration emit can spell an inferred type through a public
 * specifier. Entrypoints whose declarations name them load this entrypoint's
 * declarations (contract 3 in `tests/public-type-reachability.test.ts`).
 */
export type {
  LiveColumn,
  LiveEdgeColumn,
  RecordedColumn,
  RecordedEdgeColumn,
  SystemIndexColumnsFor,
  SystemIndexDeclarationFor,
} from "./system";
export type {
  IndexFieldInput,
  IndexWhereComparableValue,
  NonEmptyJsonPointerFor,
  NonEmptyJsonPointerSegmentsFor,
} from "./types";
