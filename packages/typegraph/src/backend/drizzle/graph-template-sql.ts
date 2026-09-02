import type { SqlDialect } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import {
  asCompiledRowsSql,
  type CompiledRowsSql,
} from "../../query/sql-intent";

type InstantiateGraphTemplateSqlParams = Readonly<{
  dialect: SqlDialect;
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
 * The schema-row template clone. PostgreSQL acquires the exact bigint
 * advisory-key family schema commits use inside the CTE and copies contribution
 * markers in the same exchange; SQLite's schema INSERT is a writer-serialized
 * statement followed by a marker-copy DML statement. A matching active v1 is
 * returned for an idempotent retry; a missing template and every incompatible
 * target yield no row. SQLite cannot return a classified zero-row outcome from
 * INSERT without a second statement, so callers surface that deliberately broad
 * refusal.
 */
export function instantiateGraphTemplateSql(
  params: InstantiateGraphTemplateSqlParams,
) {
  return asCompiledRowsSql(instantiateGraphTemplateStatement(params));
}

/** The schema-row payload used by both bundled backends. */
export function instantiateGraphTemplateStatement(
  params: InstantiateGraphTemplateSqlParams,
): SqlFragment {
  const schemaVersions = sql.identifier(params.schemaVersionsTableName);
  const templates = sql.identifier(params.templatesTableName);
  const contributions = sql.identifier(
    params.contributionMaterializationsTableName,
  );
  return params.dialect === "postgres" ?
      postgresInstantiateSql(params, schemaVersions, templates, contributions)
    : sqliteInstantiateSql(params, schemaVersions, templates);
}

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
          AND is_active = 1
      )
    ON CONFLICT(graph_id, logical_name, owner, table_name) DO UPDATE SET
      signature = excluded.signature,
      materialized_at = excluded.materialized_at,
      last_attempted_at = excluded.last_attempted_at,
      last_error = excluded.last_error
    RETURNING graph_id
  `);
}

function sqliteInstantiateSql(
  params: InstantiateGraphTemplateSqlParams,
  schemaVersions: SqlFragment,
  templates: SqlFragment,
) {
  return sql`
    INSERT INTO ${schemaVersions} (graph_id, version, schema_hash, schema_doc, created_at, is_active)
    SELECT ${params.graphId}, 1, ${params.schemaHash},
      json_set(schema_doc, '$.graphId', ${params.graphId}, '$.version', 1, '$.generatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1
    FROM ${templates}
    WHERE template_id = ${params.templateId}
      AND schema_hash = ${params.templateSchemaHash}
      AND NOT EXISTS (
        SELECT 1 FROM ${schemaVersions}
        WHERE graph_id = ${params.graphId}
          AND (version != 1 OR schema_hash != ${params.schemaHash} OR is_active != 1)
      )
    ON CONFLICT(graph_id, version) DO UPDATE SET schema_hash = excluded.schema_hash
    WHERE schema_hash = excluded.schema_hash AND is_active = 1
    RETURNING *
  `;
}

function postgresInstantiateSql(
  params: InstantiateGraphTemplateSqlParams,
  schemaVersions: SqlFragment,
  templates: SqlFragment,
  contributions: SqlFragment,
) {
  return sql`
    WITH locked AS (
      SELECT pg_advisory_xact_lock(hashtext(${params.graphId}))
    ), template AS (
      SELECT schema_hash, schema_doc FROM ${templates}
      WHERE template_id = ${params.templateId}
        AND schema_hash = ${params.templateSchemaHash}
    ), inserted AS (
      INSERT INTO ${schemaVersions} (graph_id, version, schema_hash, schema_doc, created_at, is_active)
      SELECT ${params.graphId}, 1, ${params.schemaHash},
        jsonb_set(jsonb_set(jsonb_set(template.schema_doc, '{graphId}', to_jsonb(${params.graphId}::text), true), '{version}', '1'::jsonb, true), '{generatedAt}', to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), true),
        clock_timestamp(), TRUE
      FROM template, locked
      WHERE NOT EXISTS (
        SELECT 1 FROM ${schemaVersions}
        WHERE graph_id = ${params.graphId}
          AND (version != 1 OR schema_hash != ${params.schemaHash} OR is_active != TRUE)
      )
      ON CONFLICT(graph_id, version) DO UPDATE SET schema_hash = EXCLUDED.schema_hash
      WHERE ${schemaVersions}.schema_hash = EXCLUDED.schema_hash AND ${schemaVersions}.is_active = TRUE
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
