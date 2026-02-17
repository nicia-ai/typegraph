/**
 * SQL Schema Configuration for Query Compilation
 *
 * Provides table and column identifiers that the query compiler uses.
 * This allows the compiler to work with custom table names instead of
 * hard-coded defaults.
 */
import { type SQL, sql } from "drizzle-orm";

import { ConfigurationError } from "../../errors";

/**
 * Table names for TypeGraph SQL schema.
 */
export type SqlTableNames = Readonly<{
  /** Nodes table name (default: "typegraph_nodes") */
  nodes: string;
  /** Edges table name (default: "typegraph_edges") */
  edges: string;
  /** Node embeddings table name (default: "typegraph_node_embeddings") */
  embeddings: string;
}>;

/**
 * SQL schema configuration for query compilation.
 * Contains table identifiers and utility methods for generating SQL references.
 */
export type SqlSchema = Readonly<{
  /** Table names */
  tables: SqlTableNames;
  /** Get a SQL reference to the nodes table */
  nodesTable: SQL;
  /** Get a SQL reference to the edges table */
  edgesTable: SQL;
  /** Get a SQL reference to the embeddings table */
  embeddingsTable: SQL;
}>;

/**
 * Default table names matching the standard TypeGraph schema.
 */
const DEFAULT_TABLE_NAMES: SqlTableNames = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  embeddings: "typegraph_node_embeddings",
};

/**
 * Maximum identifier length.
 * PostgreSQL uses NAMEDATALEN (64) - 1 = 63 as the max identifier length.
 * SQLite has no practical limit but we use PostgreSQL's for cross-database safety.
 */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Regex for valid SQL identifiers.
 * Must start with a letter or underscore.
 * Can contain letters, digits, underscores, and dollar signs.
 * Dollar signs are a PostgreSQL extension but commonly supported.
 */
const VALID_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_$]*$/i;

/**
 * Validates that a table name is a valid SQL identifier.
 *
 * @throws Error if the table name is invalid
 */
function validateTableName(name: string, label: string): void {
  if (!name || name.length === 0) {
    throw new ConfigurationError(`${label} table name cannot be empty`);
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new ConfigurationError(
      `${label} table name exceeds maximum length of ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  if (!VALID_IDENTIFIER_PATTERN.test(name)) {
    throw new ConfigurationError(
      `${label} table name "${name}" is not a valid SQL identifier. ` +
        `Table names must start with a letter or underscore and contain only letters, digits, underscores, or dollar signs.`,
    );
  }
}

/**
 * Quotes a SQL identifier using ANSI SQL standard double quotes.
 * Escapes any embedded double quotes by doubling them.
 *
 * This works for both SQLite and PostgreSQL.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Creates a SqlSchema configuration from table names.
 *
 * Table names are validated to ensure they are valid SQL identifiers.
 * This prevents SQL injection and ensures compatibility across databases.
 *
 * @param names - Optional custom table names (defaults to standard names)
 * @returns SqlSchema configuration for query compilation
 * @throws Error if any table name is invalid
 *
 * @example
 * ```typescript
 * // Use default table names
 * const schema = createSqlSchema();
 *
 * // Use custom table names
 * const schema = createSqlSchema({
 *   nodes: "myapp_nodes",
 *   edges: "myapp_edges",
 *   embeddings: "myapp_embeddings",
 * });
 * ```
 */
export function createSqlSchema(names: Partial<SqlTableNames> = {}): SqlSchema {
  const tables: SqlTableNames = { ...DEFAULT_TABLE_NAMES, ...names };

  // Validate all table names
  validateTableName(tables.nodes, "nodes");
  validateTableName(tables.edges, "edges");
  validateTableName(tables.embeddings, "embeddings");

  return {
    tables,
    nodesTable: sql.raw(quoteIdentifier(tables.nodes)),
    edgesTable: sql.raw(quoteIdentifier(tables.edges)),
    embeddingsTable: sql.raw(quoteIdentifier(tables.embeddings)),
  };
}

/**
 * Default SqlSchema using standard TypeGraph table names.
 */
export const DEFAULT_SQL_SCHEMA: SqlSchema = createSqlSchema();
