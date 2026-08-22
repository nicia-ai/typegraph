import type { SqlDialect } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";

type InstantiateGraphTemplateSqlParams = Readonly<{
  dialect: SqlDialect;
  graphId: string;
  schemaHash: string;
  schemaVersionsTableName: string;
  templatesTableName: string;
  templateId: string;
  templateSchemaHash: string;
}>;

/**
 * The one-statement template clone. PostgreSQL acquires the exact bigint
 * advisory-key family schema commits use inside the CTE; SQLite's INSERT is a
 * single writer-serialized statement. A matching active v1 is returned for an
 * idempotent retry; a missing template and every incompatible target yield no
 * row. SQLite cannot return a classified zero-row outcome from INSERT without
 * a second statement, so callers surface that deliberately broad refusal.
 */
export function instantiateGraphTemplateSql(
  params: InstantiateGraphTemplateSqlParams,
) {
  return asCompiledRowsSql(instantiateGraphTemplateStatement(params));
}

/** The exact one-statement payload used by both bundled backends. */
export function instantiateGraphTemplateStatement(
  params: InstantiateGraphTemplateSqlParams,
): SqlFragment {
  const schemaVersions = sql.identifier(params.schemaVersionsTableName);
  const templates = sql.identifier(params.templatesTableName);
  return params.dialect === "postgres" ?
      postgresInstantiateSql(params, schemaVersions, templates)
    : sqliteInstantiateSql(params, schemaVersions, templates);
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
) {
  return sql`
    WITH locked AS (
      SELECT pg_advisory_xact_lock(hashtext(${params.graphId}))
    ), template AS (
      SELECT schema_hash, schema_doc FROM ${templates}
      WHERE template_id = ${params.templateId}
        AND schema_hash = ${params.templateSchemaHash}
    )
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
  `;
}
