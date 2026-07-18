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
