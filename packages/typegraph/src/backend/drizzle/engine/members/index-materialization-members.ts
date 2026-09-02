/**
 * The `typegraph_index_materializations` status-table CRUD: ensuring the
 * table exists, reading one or many rows, and the `materializedAt`-preserving
 * upsert — shared verbatim by every SQL engine profile.
 *
 * `ensureIndexMaterializationsTable` is not a full mirror: PostgreSQL runs an
 * additive-column migration (`ADD COLUMN IF NOT EXISTS`) for the build-claim
 * columns right after the `CREATE TABLE`, for a table created before those
 * columns existed — a fresh install already has them from the `CREATE`
 * itself. SQLite has no such migration to run. That asymmetry is threaded
 * through as the optional `ensureIndexMaterializationColumns` dep, the same
 * shape `EngineProvisioning` exposes it as, rather than re-spelled here.
 *
 * The three row-shaped statements (SELECT one, SELECT many by name, upsert)
 * go through `rowAccess` rather than Drizzle's typed table API directly, for
 * the same reason `contribution-members.ts`'s module doc comment gives:
 * `PgTable` and `SQLiteTable` share no common supertype, so one shared body
 * cannot call `.from()` / `.insert()` on a generic table parameter. Each
 * dialect binds the three-line access closures to its own `db` and table
 * object; the row-shaping and decoding logic (`mapMaterializationRow`,
 * `buildMaterializationInsertValues`, `buildMaterializationOnConflictSet`)
 * already lived in `index-materializations.ts` before this extraction and is
 * unchanged.
 */
import type {
  IndexMaterializationRow,
  RecordIndexMaterializationParams,
} from "../../../types";
import {
  mapMaterializationRow,
  type RawIndexMaterializationRow,
} from "../../index-materializations";

/**
 * The three statements the index-materializations table needs, bound to one
 * dialect's `db` and table object by the caller. `upsert` takes the same
 * domain params `recordIndexMaterialization` does, rather than a pre-shaped
 * Drizzle payload, so the timestamp encoding and the ON CONFLICT `set` clause
 * stay inside the per-dialect binding, where the table's own typed columns
 * are in scope.
 */
type IndexMaterializationRowAccess = Readonly<{
  selectByIndexName: (
    indexName: string,
  ) => Promise<readonly RawIndexMaterializationRow[]>;
  selectByIndexNames: (
    indexNames: readonly string[],
  ) => Promise<readonly RawIndexMaterializationRow[]>;
  upsert: (params: RecordIndexMaterializationParams) => Promise<void>;
}>;

export type CreateIndexMaterializationMembersDeps = Readonly<{
  /** Idempotent `CREATE TABLE ...` for the index-materializations table, rendered once by the caller from its own dialect's table-DDL generator. */
  indexMaterializationsTableDdl: string;
  /** Runs one idempotent CREATE-shaped DDL statement — the same closure the profile's own `EngineProvisioning.ensureTable` uses. */
  ensureTable: (ddl: string) => Promise<void>;
  /**
   * PostgreSQL's additive-column migration for a table created before the
   * build-claim columns existed — the same optional hook
   * `EngineProvisioning.ensureIndexMaterializationColumns` exposes. Absent on
   * a dialect with no such migration to run (SQLite).
   */
  ensureIndexMaterializationColumns?: (tableName: string) => Promise<void>;
  /** The index-materializations table's resolved physical name, passed to `ensureIndexMaterializationColumns`. */
  tableName: string;
  /** Decodes the dialect's timestamp column representation to a canonical ISO-8601 string. */
  timestamps: Readonly<{ decode: (value: unknown) => string | undefined }>;
  rowAccess: IndexMaterializationRowAccess;
}>;

export type IndexMaterializationMembers = Readonly<{
  ensureIndexMaterializationsTable: () => Promise<void>;
  getIndexMaterialization: (
    indexName: string,
  ) => Promise<IndexMaterializationRow | undefined>;
  getIndexMaterializations: (
    statusKeys: readonly string[],
  ) => Promise<readonly IndexMaterializationRow[]>;
  recordIndexMaterialization: (
    params: RecordIndexMaterializationParams,
  ) => Promise<void>;
}>;

/**
 * Builds the index-materializations member group. Moved out of the two
 * dialect files unchanged: same idempotent provisioning (plus PostgreSQL's
 * additive-column migration where the dep supplies it), same row decoding,
 * same `materializedAt`-preserving upsert.
 */
export function createIndexMaterializationMembers(
  deps: CreateIndexMaterializationMembersDeps,
): IndexMaterializationMembers {
  const {
    indexMaterializationsTableDdl,
    ensureTable,
    ensureIndexMaterializationColumns,
    tableName,
    timestamps,
    rowAccess,
  } = deps;

  return {
    async ensureIndexMaterializationsTable(): Promise<void> {
      await ensureTable(indexMaterializationsTableDdl);
      await ensureIndexMaterializationColumns?.(tableName);
    },

    async getIndexMaterialization(
      indexName: string,
    ): Promise<IndexMaterializationRow | undefined> {
      const rows = await rowAccess.selectByIndexName(indexName);
      const row = rows[0];
      if (row === undefined) return undefined;
      return mapMaterializationRow(row, timestamps.decode);
    },

    async getIndexMaterializations(
      statusKeys: readonly string[],
    ): Promise<readonly IndexMaterializationRow[]> {
      if (statusKeys.length === 0) return [];
      const rows = await rowAccess.selectByIndexNames(statusKeys);
      return rows.map((row) => mapMaterializationRow(row, timestamps.decode));
    },

    async recordIndexMaterialization(
      params: RecordIndexMaterializationParams,
    ): Promise<void> {
      await rowAccess.upsert(params);
    },
  };
}
