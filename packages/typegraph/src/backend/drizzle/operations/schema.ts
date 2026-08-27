import { type SQL, sql } from "drizzle-orm";

import type {
  InsertSchemaParams,
  SchemaWriteFenceParams,
  SqlDialect,
} from "../../types";
import { quotedColumn, type Tables } from "./shared";

type SchemaDialectStrategy = Readonly<{
  booleanLiteral: (value: boolean) => SQL;
}>;

function createSchemaDialectStrategy(
  dialect: SqlDialect,
): SchemaDialectStrategy {
  const literals = {
    postgres: { false: "FALSE", true: "TRUE" },
    sqlite: { false: "0", true: "1" },
  } as const satisfies Record<
    SqlDialect,
    Readonly<{ false: string; true: string }>
  >;
  const dialectLiterals = literals[dialect];
  const trueLiteral = sql.raw(dialectLiterals.true);
  const falseLiteral = sql.raw(dialectLiterals.false);

  return {
    booleanLiteral(value: boolean): SQL {
      return value ? trueLiteral : falseLiteral;
    },
  };
}

const SCHEMA_DIALECT_STRATEGIES: Record<SqlDialect, SchemaDialectStrategy> = {
  postgres: createSchemaDialectStrategy("postgres"),
  sqlite: createSchemaDialectStrategy("sqlite"),
};

/**
 * Builds an INSERT query for a schema version.
 * Uses raw column names in the column list (required by SQL syntax).
 */
export function buildInsertSchema(
  tables: Tables,
  params: InsertSchemaParams,
  timestamp: string,
  dialect: SqlDialect = "sqlite",
): SQL {
  const { schemaVersions } = tables;
  const strategy = SCHEMA_DIALECT_STRATEGIES[dialect];
  const schemaDocumentJson = JSON.stringify(params.schemaDoc);
  const isActiveValue = strategy.booleanLiteral(params.isActive);

  const columns = sql.raw(
    `"${schemaVersions.graphId.name}", "${schemaVersions.version.name}", "${schemaVersions.schemaHash.name}", "${schemaVersions.schemaDoc.name}", "${schemaVersions.createdAt.name}", "${schemaVersions.isActive.name}"`,
  );

  return sql`
    INSERT INTO ${schemaVersions} (${columns})
    VALUES (
      ${params.graphId}, ${params.version},
      ${params.schemaHash}, ${schemaDocumentJson},
      ${timestamp}, ${isActiveValue}
    )
    RETURNING *
  `;
}

/**
 * Builds a SELECT query to get the active schema for a graph.
 */
export function buildGetActiveSchema(
  tables: Tables,
  graphId: string,
  dialect: SqlDialect = "sqlite",
): SQL {
  const { schemaVersions } = tables;
  const strategy = SCHEMA_DIALECT_STRATEGIES[dialect];

  return sql`
    SELECT * FROM ${schemaVersions}
    WHERE ${schemaVersions.graphId} = ${graphId}
      AND ${schemaVersions.isActive} = ${strategy.booleanLiteral(true)}
  `;
}

/** Returns one row only while the expected schema version remains active. */
export function buildSchemaFenceProbe(
  tables: Tables,
  params: SchemaWriteFenceParams,
  lockClause: SQL,
): SQL {
  const { schemaVersions } = tables;
  return sql`
    SELECT ${schemaVersions.version}
    FROM ${schemaVersions}
    WHERE ${schemaVersions.graphId} = ${params.graphId}
      AND ${schemaVersions.version} = ${params.expectedVersion}
      AND ${schemaVersions.isActive} = TRUE
    ${lockClause}
  `;
}

/**
 * PostgreSQL's successful schema + graph write fence in one statement.
 *
 * Both CTEs are `MATERIALIZED`, and `graph_write_lock` reads exclusively from
 * `schema_fence`: PostgreSQL therefore must finish the expected active-row
 * `FOR SHARE` lock before it may acquire the advisory lock. A stale fence
 * yields no rows and cannot acquire the graph lock. The caller interprets that
 * zero-row result through the ordinary active-version diagnostic.
 */
export function buildLockSchemaVersionAndGraphWrite(
  tables: Tables,
  params: SchemaWriteFenceParams,
  advisoryLockNamespace: string,
): SQL {
  const { schemaVersions } = tables;
  return sql`
    WITH "schema_fence" AS MATERIALIZED (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${params.graphId}
        AND ${schemaVersions.version} = ${params.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      FOR SHARE
    ),
    "graph_write_lock" AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtext(${advisoryLockNamespace}),
        hashtext(${params.graphId})
      ) AS "lock_token"
      FROM "schema_fence"
    )
    SELECT
      TRUE AS "fence_acquired",
      current_setting('transaction_isolation') AS "transaction_isolation"
    FROM "graph_write_lock"
  `;
}

/**
 * Builds a SELECT query to get a specific schema version.
 */
export function buildGetSchemaVersion(
  tables: Tables,
  graphId: string,
  version: number,
): SQL {
  const { schemaVersions } = tables;

  return sql`
    SELECT * FROM ${schemaVersions}
    WHERE ${schemaVersions.graphId} = ${graphId}
      AND ${schemaVersions.version} = ${version}
  `;
}

/**
 * Builds UPDATE queries to set the active schema version.
 * Returns two queries: first deactivates all, second activates the specified version.
 * Uses raw column names in SET clause (SQLite doesn't allow table prefix there).
 */
export function buildSetActiveSchema(
  tables: Tables,
  graphId: string,
  version: number,
  dialect: SqlDialect = "sqlite",
): { deactivateAll: SQL; activateVersion: SQL } {
  const { schemaVersions } = tables;
  const strategy = SCHEMA_DIALECT_STRATEGIES[dialect];

  const deactivateAll = sql`
    UPDATE ${schemaVersions}
    SET ${quotedColumn(schemaVersions.isActive)} = ${strategy.booleanLiteral(false)}
    WHERE ${schemaVersions.graphId} = ${graphId}
  `;

  const activateVersion = sql`
    UPDATE ${schemaVersions}
    SET ${quotedColumn(schemaVersions.isActive)} = ${strategy.booleanLiteral(true)}
    WHERE ${schemaVersions.graphId} = ${graphId}
      AND ${schemaVersions.version} = ${version}
  `;

  return { deactivateAll, activateVersion };
}
