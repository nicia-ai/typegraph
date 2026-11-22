/**
 * Drizzle-specific index builder integration.
 *
 * Kept behind an explicit adapter entrypoint so the portable
 * `@nicia-ai/typegraph/indexes` declaration graph never imports Drizzle.
 */
export {
  buildPostgresEdgeIndexBuilders,
  buildPostgresNodeIndexBuilders,
  buildSqliteEdgeIndexBuilders,
  buildSqliteNodeIndexBuilders,
} from "../../indexes/drizzle";

/**
 * The Drizzle index-table and SQL-wrapper types the builders above name,
 * exported so a consumer's declaration emit can spell their inferred results
 * through this entrypoint (contract 3 in
 * `tests/public-type-reachability.test.ts`).
 */
export type {
  EdgeIndexTable,
  NamedSqlWrapper,
  NodeIndexTable,
} from "../../indexes/drizzle";
