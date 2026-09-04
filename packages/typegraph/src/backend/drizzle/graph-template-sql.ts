import { getDialect } from "../../query/dialect";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import {
  asCompiledRowsSql,
  type CompiledRowsSql,
} from "../../query/sql-intent";
import { advisoryLockSingleExpression } from "./postgres-fence-sql";

export type InstantiateGraphTemplateSqlParams = Readonly<{
  graphId: string;
  schemaHash: string;
  schemaVersionsTableName: string;
  templatesTableName: string;
  contributionMaterializationsTableName: string;
  templateId: string;
  templateSchemaHash: string;
}>;

export type CopyGraphTemplateContributionMarkersSqlParams = Readonly<{
  graphId: string;
  schemaHash: string;
  schemaVersionsTableName: string;
  templatesTableName: string;
  contributionMaterializationsTableName: string;
  templateId: string;
  templateSchemaHash: string;
}>;

/**
 * SQLite's `is_active` TRUE literal, hoisted so the file has one spelling of
 * this decision instead of the marker-copy statement re-deriving it as a
 * bare `1` beside {@link sqliteInstantiateGraphTemplateStatement}'s own call
 * to `getDialect("sqlite").booleanLiteral(true)`.
 */
const SQLITE_ACTIVE_LITERAL = getDialect("sqlite").booleanLiteral(true);

/**
 * SQLite cannot put a data-modifying CTE beside the schema INSERT. The
 * marker copy therefore runs as a second DML statement after the schema row
 * has returned. It still carries only identifiers and hashes over the wire;
 * the source document and marker values remain server-resident.
 */
export function copyGraphTemplateContributionMarkersStatement(
  params: CopyGraphTemplateContributionMarkersSqlParams,
): CompiledRowsSql {
  const schemaVersions = sql.identifier(params.schemaVersionsTableName);
  const templates = sql.identifier(params.templatesTableName);
  const contributions = sql.identifier(
    params.contributionMaterializationsTableName,
  );
  return asCompiledRowsSql(sql`
    INSERT INTO ${contributions} (
      graph_id, logical_name, owner, table_name, signature,
      materialized_at, last_attempted_at, last_error
    )
    SELECT ${params.graphId}, source.logical_name, source.owner, source.table_name,
      source.signature, source.materialized_at, source.last_attempted_at,
      source.last_error
    FROM ${templates} AS template
    JOIN ${contributions} AS source
      ON source.graph_id = json_extract(template.schema_doc, '$.graphId')
    WHERE template.template_id = ${params.templateId}
      AND template.schema_hash = ${params.templateSchemaHash}
      AND EXISTS (
        SELECT 1 FROM ${schemaVersions}
        WHERE graph_id = ${params.graphId}
          AND version = 1
          AND schema_hash = ${params.schemaHash}
          AND is_active = ${SQLITE_ACTIVE_LITERAL}
      )
    ON CONFLICT(graph_id, logical_name, owner, table_name) DO UPDATE SET
      signature = excluded.signature,
      materialized_at = excluded.materialized_at,
      last_attempted_at = excluded.last_attempted_at,
      last_error = excluded.last_error
    RETURNING graph_id
  `);
}

/**
 * SQLite's schema-row template clone: a bare `INSERT ... SELECT ...
 * RETURNING`, with the marker copy left to the caller's separate
 * {@link copyGraphTemplateContributionMarkersStatement} statement (SQLite
 * cannot place a data-modifying CTE beside this INSERT). A matching active
 * v1 is returned for an idempotent retry; a missing template and every
 * incompatible target yield no row, and SQLite cannot return a classified
 * zero-row outcome from INSERT without a second statement, so the caller
 * surfaces that deliberately broad refusal.
 *
 * The `graphId` lookup inside the marker-copy statement and this INSERT's
 * `DO UPDATE ... WHERE` column references stay dialect-local text rather
 * than the query compiler's identifier/JSON tokens, which always quote what
 * they touch: this statement's exact bytes are asserted verbatim by a
 * driver-level snapshot, and quoting an already-bare reference would change
 * them without changing what the statement does.
 */
export function sqliteInstantiateGraphTemplateStatement(
  params: InstantiateGraphTemplateSqlParams,
): SqlFragment {
  const schemaVersions = sql.identifier(params.schemaVersionsTableName);
  const templates = sql.identifier(params.templatesTableName);
  const active = SQLITE_ACTIVE_LITERAL;
  return sql`
    INSERT INTO ${schemaVersions} (graph_id, version, schema_hash, schema_doc, created_at, is_active)
    SELECT ${params.graphId}, 1, ${params.schemaHash},
      json_set(schema_doc, '$.graphId', ${params.graphId}, '$.version', 1, '$.generatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${active}
    FROM ${templates}
    WHERE template_id = ${params.templateId}
      AND schema_hash = ${params.templateSchemaHash}
      AND NOT EXISTS (
        SELECT 1 FROM ${schemaVersions}
        WHERE graph_id = ${params.graphId}
          AND (version != 1 OR schema_hash != ${params.schemaHash} OR is_active != ${active})
      )
    ON CONFLICT(graph_id, version) DO UPDATE SET schema_hash = excluded.schema_hash
    WHERE schema_hash = excluded.schema_hash AND is_active = ${active}
    RETURNING *
  `;
}

/**
 * PostgreSQL's schema-row template clone: one statement, its `locked` CTE
 * taking the exact one-argument advisory lock the schema-commit fence takes
 * (`advisoryLockSingleExpression`, `postgres-fence-sql.ts`) so the two
 * mutually exclude, its `inserted` CTE the schema INSERT, and its `markers`
 * CTE copying the template's contribution markers in the same exchange — the
 * one genuine difference from SQLite's two-statement shape, which this
 * dialect's data-modifying CTEs make possible. A matching active v1 is
 * returned for an idempotent retry; a missing template and every
 * incompatible target yield no row.
 */
export function postgresInstantiateGraphTemplateStatement(
  params: InstantiateGraphTemplateSqlParams,
): SqlFragment {
  const schemaVersions = sql.identifier(params.schemaVersionsTableName);
  const templates = sql.identifier(params.templatesTableName);
  const contributions = sql.identifier(
    params.contributionMaterializationsTableName,
  );
  const active = getDialect("postgres").booleanLiteral(true);
  return sql`
    WITH locked AS (
      SELECT ${advisoryLockSingleExpression(params.graphId)}
    ), template AS (
      SELECT schema_hash, schema_doc FROM ${templates}
      WHERE template_id = ${params.templateId}
        AND schema_hash = ${params.templateSchemaHash}
    ), inserted AS (
      INSERT INTO ${schemaVersions} (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      SELECT ${params.graphId}, 1, ${params.schemaHash},
        jsonb_set(jsonb_set(jsonb_set(template.schema_doc, '{graphId}', to_jsonb(${params.graphId}::text), true), '{version}', '1'::jsonb, true), '{generatedAt}', to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true),
        clock_timestamp(), ${active}
      FROM template, locked
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schemaVersions}
        WHERE graph_id = ${params.graphId}
          AND (version != 1 OR schema_hash != ${params.schemaHash} OR is_active != ${active})
      )
      ON CONFLICT(graph_id, version) DO UPDATE SET schema_hash = EXCLUDED.schema_hash
      WHERE ${schemaVersions}.schema_hash = EXCLUDED.schema_hash AND ${schemaVersions}.is_active = ${active}
      RETURNING *
    ), markers AS (
      INSERT INTO ${contributions} (
        graph_id, logical_name, owner, table_name, signature,
        materialized_at, last_attempted_at, last_error
      )
      SELECT ${params.graphId}, source.logical_name, source.owner, source.table_name,
        source.signature, source.materialized_at, source.last_attempted_at,
        source.last_error
      FROM template
      CROSS JOIN inserted
      JOIN ${contributions} AS source
        ON source.graph_id = (template.schema_doc ->> 'graphId')
      ON CONFLICT (graph_id, logical_name, owner, table_name) DO UPDATE SET
        signature = EXCLUDED.signature,
        materialized_at = EXCLUDED.materialized_at,
        last_attempted_at = EXCLUDED.last_attempted_at,
        last_error = EXCLUDED.last_error
    )
    SELECT * FROM inserted
  `;
}
