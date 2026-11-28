/**
 * The `typegraph_kind_removals` status-table CRUD: ensuring the table
 * exists, reading a graph's pending or all removal rows, and the
 * `removed_at`-preserving upsert — shared verbatim by every SQL engine
 * profile. Unlike `index-materialization-members.ts`'s table, this one is a
 * full mirror: neither dialect runs a migration beyond the initial CREATE.
 *
 * The three row-shaped statements (select pending, select all, upsert) go
 * through `rowAccess` rather than Drizzle's typed table API directly, for
 * the same reason `index-materialization-members.ts`'s module doc comment
 * gives: `PgTable` and `SQLiteTable` share no common supertype, so one
 * shared body cannot call `.from()` / `.insert()` on a generic table
 * parameter. Each dialect binds the three-line access closures to its own
 * `db` and table object; the row-shaping and decoding logic
 * (`mapKindRemovalRow`, `buildKindRemovalInsertValues`,
 * `buildKindRemovalOnConflictSet`) already lived in `kind-removals.ts`
 * before this extraction and is unchanged.
 */
import type { KindRemovalRow, RecordKindRemovalParams } from "../../../types";
import {
  mapKindRemovalRow,
  type RawKindRemovalRow,
} from "../../kind-removals";

/**
 * The three statements the kind-removals table needs, bound to one
 * dialect's `db` and table object by the caller. `upsert` takes the same
 * domain params `recordKindRemoval` does, rather than a pre-shaped Drizzle
 * payload, so the timestamp encoding and the ON CONFLICT `set` clause stay
 * inside the per-dialect binding, where the table's own typed columns are
 * in scope.
 */
type KindRemovalRowAccess = Readonly<{
  selectPending: (graphId: string) => Promise<readonly RawKindRemovalRow[]>;
  selectAll: (graphId: string) => Promise<readonly RawKindRemovalRow[]>;
  upsert: (params: RecordKindRemovalParams) => Promise<void>;
}>;

export type CreateKindRemovalMembersDeps = Readonly<{
  /** Idempotent `CREATE TABLE ...` for the kind-removals table, rendered once by the caller from its own dialect's table-DDL generator. */
  kindRemovalsTableDdl: string;
  /** Runs one idempotent CREATE-shaped DDL statement — the same closure the profile's own `EngineProvisioning.ensureTable` uses. */
  ensureTable: (ddl: string) => Promise<void>;
  /** Decodes the dialect's timestamp column representation to a canonical ISO-8601 string. */
  timestamps: Readonly<{ decode: (value: unknown) => string | undefined }>;
  rowAccess: KindRemovalRowAccess;
}>;

export type KindRemovalMembers = Readonly<{
  ensureKindRemovalsTable: () => Promise<void>;
  getPendingKindRemovals: (
    graphId: string,
  ) => Promise<readonly KindRemovalRow[]>;
  getAllKindRemovals: (graphId: string) => Promise<readonly KindRemovalRow[]>;
  recordKindRemoval: (params: RecordKindRemovalParams) => Promise<void>;
}>;

/**
 * Builds the kind-removals member group. Moved out of the two dialect files
 * unchanged: same idempotent provisioning, same row decoding, same
 * `removed_at`-preserving upsert.
 */
export function createKindRemovalMembers(
  deps: CreateKindRemovalMembersDeps,
): KindRemovalMembers {
  const { kindRemovalsTableDdl, ensureTable, timestamps, rowAccess } = deps;

  return {
    async ensureKindRemovalsTable(): Promise<void> {
      await ensureTable(kindRemovalsTableDdl);
    },

    async getPendingKindRemovals(
      graphId: string,
    ): Promise<readonly KindRemovalRow[]> {
      const rows = await rowAccess.selectPending(graphId);
      return rows.map((row) => mapKindRemovalRow(row, timestamps.decode));
    },

    async getAllKindRemovals(
      graphId: string,
    ): Promise<readonly KindRemovalRow[]> {
      const rows = await rowAccess.selectAll(graphId);
      return rows.map((row) => mapKindRemovalRow(row, timestamps.decode));
    },

    async recordKindRemoval(params: RecordKindRemovalParams): Promise<void> {
      await rowAccess.upsert(params);
    },
  };
}
