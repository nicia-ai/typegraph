/**
 * Graph-template registration and instantiation: the two members every SQL
 * engine profile exposes for cloning a durable schema template into a fresh
 * graph. The shared body issues only the instantiation statement, through
 * the `execute` dep, and the table DDL, through `ensureTable`. Registration's
 * two row statements stay in each dialect's `rowAccess` binding instead,
 * because `PgTable` and `SQLiteTable` share no common supertype — the same
 * reason `kind-removal-members.ts` binds its row access per dialect.
 *
 * `registerGraphTemplate`'s insert-then-verify sequence and its
 * content-conflict refusal are identical on both dialects; only the row's
 * timestamp and JSON-document encoding differ, threaded through as the
 * `rowAccess` dep the same way `kind-removal-members.ts` and
 * `index-materialization-members.ts` do it.
 *
 * `instantiateGraphTemplate` runs one dialect-parameterized statement built
 * by `instantiateGraphTemplateSql` (`graph-template-sql.ts`) for both
 * engines. The one genuine difference: PostgreSQL's statement copies the
 * template's contribution markers inside its own CTE, but SQLite cannot put
 * a data-modifying CTE beside the schema INSERT, so its profile runs a
 * second DML statement — `copyGraphTemplateContributionMarkersStatement` —
 * after the schema row is confirmed. That asymmetry is threaded through as
 * the optional `copyContributionMarkers` dep, present only on the SQLite
 * profile.
 */
import { ConfigurationError } from "../../../../errors";
import type { SqlDialect } from "../../../../query/dialect/types";
import type { CompiledRowsSql } from "../../../../query/sql-intent";
import type { SerializedSchema } from "../../../../schema/types";
import type { GraphTemplateRow, SchemaVersionRow } from "../../../types";
import {
  type CopyGraphTemplateContributionMarkersSqlParams,
  instantiateGraphTemplateSql,
} from "../../graph-template-sql";

/**
 * Parameters for `registerGraphTemplate`, matching the inline shape on
 * {@link GraphBackend.registerGraphTemplate} field for field. Kept local
 * (not exported) so this extraction leaves the public `GraphBackend`
 * declaration surface untouched; structural typing makes this type
 * assignable to that member's inline parameter type.
 */
type RegisterGraphTemplateParams = Readonly<{
  templateId: string;
  schemaHash: string;
  schemaDoc: SerializedSchema;
}>;

/**
 * Parameters for `instantiateGraphTemplate`, matching the inline shape on
 * {@link GraphBackend.instantiateGraphTemplate} field for field. Kept local
 * for the same reason as {@link RegisterGraphTemplateParams}.
 */
type InstantiateGraphTemplateParams = Readonly<{
  templateId: string;
  templateSchemaHash: string;
  graphId: string;
  schemaHash: string;
}>;

/**
 * Result of `instantiateGraphTemplate`, matching the inline shape on
 * {@link GraphBackend.instantiateGraphTemplate} field for field. Kept local
 * for the same reason as {@link RegisterGraphTemplateParams}.
 */
type InstantiateGraphTemplateResult =
  | Readonly<{ status: "ready"; row: SchemaVersionRow }>
  | Readonly<{ status: "refused" }>;

/** A raw graph-template row, already normalized to canonical strings by the dialect binding. */
type RawGraphTemplateRow = Readonly<{
  templateId: string;
  schemaHash: string;
  schemaDoc: string;
  createdAt: string;
}>;

/**
 * The two statements graph-template registration needs, bound to one
 * dialect's `db` and table object by the caller. `insertIgnoringConflict`
 * carries its own timestamp stamping (`new Date()` for PostgreSQL, `nowIso()`
 * for SQLite) and its own JSON-document encoding, so those stay inside the
 * per-dialect binding rather than re-spelled here.
 */
type GraphTemplateRowAccess = Readonly<{
  insertIgnoringConflict: (
    params: RegisterGraphTemplateParams,
  ) => Promise<void>;
  selectByTemplateId: (
    templateId: string,
  ) => Promise<RawGraphTemplateRow | undefined>;
}>;

/** The table names `instantiateGraphTemplateSql` compiles its statement against. */
type GraphTemplateTableNames = Readonly<{
  schemaVersions: string;
  graphTemplates: string;
  contributionMaterializations: string;
}>;

export type CreateGraphTemplateMembersDeps = Readonly<{
  /** The dialect `instantiateGraphTemplateSql` compiles its statement for. */
  dialect: SqlDialect;
  /** Idempotent `CREATE TABLE ...` for the graph-templates table, rendered once by the caller from its own dialect's table-DDL generator. */
  graphTemplatesTableDdl: string;
  /** Runs one idempotent CREATE-shaped DDL statement — the same closure the profile's own `EngineProvisioning.ensureTable` uses. */
  ensureTable: (ddl: string) => Promise<void>;
  /** Runs a compiled statement through the operation-backend layer's row-returning execution path. */
  execute: <TRow>(query: CompiledRowsSql) => Promise<readonly TRow[]>;
  tableNames: GraphTemplateTableNames;
  /** Decodes a raw driver row into a `SchemaVersionRow` — the same mapper `OperationBackendRowMappers.toSchemaVersionRow` is. */
  toSchemaVersionRow: (row: Record<string, unknown>) => SchemaVersionRow;
  rowAccess: GraphTemplateRowAccess;
  /**
   * SQLite's second DML statement copying contribution markers after the
   * schema row is confirmed (see the module doc comment). Absent on a
   * dialect whose `instantiateGraphTemplateSql` already folds the marker
   * copy into its own statement (PostgreSQL).
   */
  copyContributionMarkers?: (
    params: CopyGraphTemplateContributionMarkersSqlParams,
  ) => Promise<void>;
}>;

/** The two `GraphBackend` members this group exposes. */
type GraphTemplateMembers = Readonly<{
  registerGraphTemplate: (
    params: RegisterGraphTemplateParams,
  ) => Promise<GraphTemplateRow>;
  instantiateGraphTemplate: (
    params: InstantiateGraphTemplateParams,
  ) => Promise<InstantiateGraphTemplateResult>;
}>;

export type GraphTemplateMembersResult = Readonly<{
  /**
   * Not a `GraphBackend` member — an adoption-step primitive the caller's
   * `baseSchemaLifecycle` calls directly, the same way it always has.
   * Kept out of `members` so a caller that spreads `members` onto the
   * backend object can never leak it as a public surface.
   */
  ensureGraphTemplatesTable: () => Promise<void>;
  members: GraphTemplateMembers;
}>;

/**
 * Builds the graph-template member group. Moved out of the two dialect
 * files unchanged: same insert-then-verify registration, same
 * instantiation statement, same SQLite-only marker-copy follow-up.
 */
export function createGraphTemplateMembers(
  deps: CreateGraphTemplateMembersDeps,
): GraphTemplateMembersResult {
  const {
    dialect,
    graphTemplatesTableDdl,
    ensureTable,
    execute,
    tableNames,
    toSchemaVersionRow,
    rowAccess,
    copyContributionMarkers,
  } = deps;

  return {
    async ensureGraphTemplatesTable(): Promise<void> {
      await ensureTable(graphTemplatesTableDdl);
    },

    members: {
      async registerGraphTemplate(
        params: RegisterGraphTemplateParams,
      ): Promise<GraphTemplateRow> {
        await rowAccess.insertIgnoringConflict(params);
        const row = await rowAccess.selectByTemplateId(params.templateId);
        if (row?.schemaHash !== params.schemaHash) {
          throw new ConfigurationError(
            `Graph template "${params.templateId}" already exists with different schema content.`,
            {
              code: "GRAPH_TEMPLATE_CONTENT_CONFLICT",
              templateId: params.templateId,
            },
          );
        }
        return {
          template_id: row.templateId,
          schema_hash: row.schemaHash,
          schema_doc: row.schemaDoc,
          created_at: row.createdAt,
        };
      },

      async instantiateGraphTemplate(
        params: InstantiateGraphTemplateParams,
      ): Promise<InstantiateGraphTemplateResult> {
        const sqlParams: CopyGraphTemplateContributionMarkersSqlParams = {
          graphId: params.graphId,
          schemaHash: params.schemaHash,
          schemaVersionsTableName: tableNames.schemaVersions,
          templatesTableName: tableNames.graphTemplates,
          contributionMaterializationsTableName:
            tableNames.contributionMaterializations,
          templateId: params.templateId,
          templateSchemaHash: params.templateSchemaHash,
        };
        const rows = await execute<Record<string, unknown>>(
          instantiateGraphTemplateSql({ dialect, ...sqlParams }),
        );
        const row = rows[0];
        if (row === undefined) return { status: "refused" } as const;
        await copyContributionMarkers?.(sqlParams);
        return { status: "ready", row: toSchemaVersionRow(row) } as const;
      },
    },
  };
}
