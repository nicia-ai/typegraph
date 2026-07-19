import { TrustedImportError } from "../../errors";
import { sql } from "../../query/sql-fragment";
import { asCompiledStatementSql } from "../../query/sql-intent";
import type {
  InsertEdgeParams,
  InsertNodeParams,
  TransactionBackend,
  TrustedImportSession,
} from "../types";
import type { SqliteExecutionAdapter } from "./execution/sqlite-execution";

type TrustedImportTableNames = Readonly<{
  nodes: string;
  edges: string;
}>;

type SqliteIndexDefinition = Readonly<{
  index_name: string;
  index_definition: string;
}>;

type PostgresIndexDefinition = Readonly<{
  index_name: string;
  index_definition: string;
}>;

// Raw driver parameters need an explicit SQL NULL. `undefined` is rejected by
// postgres.js and therefore cannot represent the same cross-driver value.
// eslint-disable-next-line unicorn/no-null
const DATABASE_NULL = null;

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requireRawExecution(
  backend: TransactionBackend,
): NonNullable<TransactionBackend["executeRaw"]> {
  if (backend.executeRaw === undefined) {
    throw new TrustedImportError(
      "This backend cannot execute the raw statements required by trusted import.",
      "backend_unsupported",
    );
  }
  return backend.executeRaw;
}

function requireStatementExecution(
  backend: TransactionBackend,
): NonNullable<TransactionBackend["executeStatement"]> {
  if (backend.executeStatement === undefined) {
    throw new TrustedImportError(
      "This backend cannot execute the index lifecycle required by trusted import.",
      "backend_unsupported",
    );
  }
  return backend.executeStatement;
}

function rowIndicatesExistingData(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const value = (row as Readonly<Record<string, unknown>>)["has_rows"];
  return value === true || value === 1 || value === "1";
}

export async function assertTrustedImportDatabaseEmpty(
  backend: TransactionBackend,
  tableNames: TrustedImportTableNames,
): Promise<void> {
  const executeRaw = requireRawExecution(backend);
  const rows = await executeRaw<Record<string, unknown>>(
    `SELECT (
       EXISTS (SELECT 1 FROM ${quoteSqlIdentifier(tableNames.nodes)} LIMIT 1)
       OR EXISTS (SELECT 1 FROM ${quoteSqlIdentifier(tableNames.edges)} LIMIT 1)
     ) AS has_rows`,
    [],
  );
  if (!rowIndicatesExistingData(rows[0])) return;

  throw new TrustedImportError(
    "Trusted import requires globally empty TypeGraph node and edge tables.",
    "database_not_empty",
    { tables: [tableNames.nodes, tableNames.edges] },
    {
      suggestion:
        "Run trusted import only against a fresh, dedicated database. Use importGraph or the collection bulk APIs to add data to an existing database.",
    },
  );
}

export async function lockPostgresTrustedImportTables(
  backend: TransactionBackend,
  tableNames: TrustedImportTableNames,
): Promise<void> {
  const executeStatement = requireStatementExecution(backend);
  await executeStatement(
    asCompiledStatementSql(
      sql.raw(
        `LOCK TABLE ${quoteSqlIdentifier(tableNames.nodes)}, ${quoteSqlIdentifier(tableNames.edges)} IN ACCESS EXCLUSIVE MODE`,
      ),
    ),
  );
}

export async function suspendSqliteSecondaryIndexes(
  backend: TransactionBackend,
  tableNames: TrustedImportTableNames,
): Promise<readonly SqliteIndexDefinition[]> {
  const executeRaw = requireRawExecution(backend);
  const executeStatement = requireStatementExecution(backend);
  const definitions = await executeRaw<SqliteIndexDefinition>(
    `SELECT name AS index_name, sql AS index_definition
       FROM sqlite_schema
      WHERE type = 'index'
        AND tbl_name IN (?, ?)
        AND sql IS NOT NULL
      ORDER BY name`,
    [tableNames.nodes, tableNames.edges],
  );
  for (const definition of definitions) {
    await executeStatement(
      asCompiledStatementSql(
        sql.raw(`DROP INDEX ${quoteSqlIdentifier(definition.index_name)}`),
      ),
    );
  }
  return definitions;
}

export async function suspendPostgresSecondaryIndexes(
  backend: TransactionBackend,
  tableNames: TrustedImportTableNames,
): Promise<readonly PostgresIndexDefinition[]> {
  const executeRaw = requireRawExecution(backend);
  const executeStatement = requireStatementExecution(backend);
  const definitions = await executeRaw<PostgresIndexDefinition>(
    `SELECT index_class.relname AS index_name,
            pg_get_indexdef(index_class.oid) AS index_definition
       FROM pg_class AS table_class
       JOIN pg_namespace AS namespace
         ON namespace.oid = table_class.relnamespace
       JOIN pg_index AS index_metadata
         ON index_metadata.indrelid = table_class.oid
       JOIN pg_class AS index_class
         ON index_class.oid = index_metadata.indexrelid
       LEFT JOIN pg_constraint AS table_constraint
         ON table_constraint.conindid = index_class.oid
      WHERE namespace.nspname = current_schema()
        AND table_class.relname IN ($1, $2)
        AND table_constraint.oid IS NULL
        AND NOT index_metadata.indisprimary
      ORDER BY index_class.relname`,
    [tableNames.nodes, tableNames.edges],
  );
  for (const definition of definitions) {
    await executeStatement(
      asCompiledStatementSql(
        sql.raw(`DROP INDEX ${quoteSqlIdentifier(definition.index_name)}`),
      ),
    );
  }
  return definitions;
}

export async function restoreSecondaryIndexes(
  backend: TransactionBackend,
  definitions: readonly Readonly<{ index_definition: string }>[],
): Promise<void> {
  const executeStatement = requireStatementExecution(backend);
  for (const definition of definitions) {
    await executeStatement(
      asCompiledStatementSql(sql.raw(definition.index_definition)),
    );
  }
}

export async function analyzeImportedTables(
  backend: TransactionBackend,
  tableNames: TrustedImportTableNames,
): Promise<void> {
  const executeStatement = requireStatementExecution(backend);
  await executeStatement(
    asCompiledStatementSql(
      sql.raw(`ANALYZE ${quoteSqlIdentifier(tableNames.nodes)}`),
    ),
  );
  await executeStatement(
    asCompiledStatementSql(
      sql.raw(`ANALYZE ${quoteSqlIdentifier(tableNames.edges)}`),
    ),
  );
}

function resolvedValidFrom(
  validFrom: string | null | undefined,
  timestamp: string,
): string | null {
  return validFrom === undefined ? timestamp : validFrom;
}

/**
 * Encodes one-dimensional Postgres arrays as text accepted by an explicit
 * `::text[]` / `::timestamptz[]` cast. postgres.js's raw `unsafe` parameters
 * do not infer a serializer for JavaScript arrays, while node-postgres does;
 * using the wire-neutral literal keeps both drivers on the same path.
 */
function postgresArray(values: readonly (string | null)[]): string {
  return `{${values
    .map((value) =>
      value === DATABASE_NULL ? "NULL" : (
        `"${value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`
      ),
    )
    .join(",")}}`;
}

export function createSqliteTrustedImportSession(
  executionAdapter: SqliteExecutionAdapter,
  tableNames: TrustedImportTableNames,
): TrustedImportSession {
  const executePreparedRunBatch = executionAdapter.executePreparedRunBatch;
  if (executePreparedRunBatch === undefined) {
    throw new TrustedImportError(
      "Trusted import requires a synchronous SQLite driver with prepared statement support.",
      "backend_unsupported",
    );
  }

  const nodeSql = `INSERT INTO ${quoteSqlIdentifier(tableNames.nodes)}
    (graph_id, kind, id, props, version, valid_from, valid_to, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`;
  const edgeSql = `INSERT INTO ${quoteSqlIdentifier(tableNames.edges)}
    (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props, valid_from, valid_to, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return {
    async insertNodes(params: readonly InsertNodeParams[]): Promise<void> {
      if (params.length === 0) return;
      const timestamp = new Date().toISOString();
      await executePreparedRunBatch(
        nodeSql,
        params.map((item) => [
          item.graphId,
          item.kind,
          item.id,
          JSON.stringify(item.props),
          resolvedValidFrom(item.validFrom, timestamp),
          item.validTo ?? DATABASE_NULL,
          timestamp,
          timestamp,
        ]),
      );
    },
    async insertEdges(params: readonly InsertEdgeParams[]): Promise<void> {
      if (params.length === 0) return;
      const timestamp = new Date().toISOString();
      await executePreparedRunBatch(
        edgeSql,
        params.map((item) => [
          item.graphId,
          item.id,
          item.kind,
          item.fromKind,
          item.fromId,
          item.toKind,
          item.toId,
          JSON.stringify(item.props),
          resolvedValidFrom(item.validFrom, timestamp),
          item.validTo ?? DATABASE_NULL,
          timestamp,
          timestamp,
        ]),
      );
    },
  };
}

export function createPostgresTrustedImportSession(
  backend: TransactionBackend,
  tableNames: TrustedImportTableNames,
): TrustedImportSession {
  const executeRaw = requireRawExecution(backend);
  const nodeSql = `INSERT INTO ${quoteSqlIdentifier(tableNames.nodes)}
    (graph_id, kind, id, props, version, valid_from, valid_to, created_at, updated_at)
    SELECT graph_id, kind, id, props::jsonb, 1, valid_from, valid_to, created_at, created_at
      FROM UNNEST(
        $1::text[], $2::text[], $3::text[], $4::text[],
        $5::timestamptz[], $6::timestamptz[], $7::timestamptz[]
      ) AS imported(graph_id, kind, id, props, valid_from, valid_to, created_at)`;
  const edgeSql = `INSERT INTO ${quoteSqlIdentifier(tableNames.edges)}
    (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props, valid_from, valid_to, created_at, updated_at)
    SELECT graph_id, id, kind, from_kind, from_id, to_kind, to_id, props::jsonb,
           valid_from, valid_to, created_at, created_at
      FROM UNNEST(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
        $6::text[], $7::text[], $8::text[], $9::timestamptz[],
        $10::timestamptz[], $11::timestamptz[]
      ) AS imported(
        graph_id, id, kind, from_kind, from_id, to_kind, to_id, props,
        valid_from, valid_to, created_at
      )`;

  return {
    async insertNodes(params: readonly InsertNodeParams[]): Promise<void> {
      if (params.length === 0) return;
      const timestamp = new Date().toISOString();
      await executeRaw(nodeSql, [
        postgresArray(params.map((item) => item.graphId)),
        postgresArray(params.map((item) => item.kind)),
        postgresArray(params.map((item) => item.id)),
        postgresArray(params.map((item) => JSON.stringify(item.props))),
        postgresArray(
          params.map((item) => resolvedValidFrom(item.validFrom, timestamp)),
        ),
        postgresArray(params.map((item) => item.validTo ?? DATABASE_NULL)),
        postgresArray(params.map(() => timestamp)),
      ]);
    },
    async insertEdges(params: readonly InsertEdgeParams[]): Promise<void> {
      if (params.length === 0) return;
      const timestamp = new Date().toISOString();
      await executeRaw(edgeSql, [
        postgresArray(params.map((item) => item.graphId)),
        postgresArray(params.map((item) => item.id)),
        postgresArray(params.map((item) => item.kind)),
        postgresArray(params.map((item) => item.fromKind)),
        postgresArray(params.map((item) => item.fromId)),
        postgresArray(params.map((item) => item.toKind)),
        postgresArray(params.map((item) => item.toId)),
        postgresArray(params.map((item) => JSON.stringify(item.props))),
        postgresArray(
          params.map((item) => resolvedValidFrom(item.validFrom, timestamp)),
        ),
        postgresArray(params.map((item) => item.validTo ?? DATABASE_NULL)),
        postgresArray(params.map(() => timestamp)),
      ]);
    },
  };
}
