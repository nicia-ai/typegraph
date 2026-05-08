/**
 * Shared building blocks for the `typegraph_index_materializations`
 * status-table operations on both SQLite and Postgres backends.
 *
 * The two dialect adapters used to carry near-identical implementations
 * of `getIndexMaterialization` and `recordIndexMaterialization`. They
 * differ only in (a) how timestamps cross the Drizzle boundary —
 * SQLite stores ISO strings in TEXT columns, Postgres stores `Date`
 * objects in TIMESTAMPTZ columns — and (b) the raw-DDL exec call used
 * to bootstrap the table. Everything else (the row shape, the
 * `onConflictDoUpdate` set clause, the `materializedAt` COALESCE
 * preservation rule for failed re-attempts) is dialect-agnostic and
 * lives here.
 */

import { sql } from "drizzle-orm";

import type { IndexEntity } from "../../core/types";
import type {
  IndexMaterializationRow,
  RecordIndexMaterializationParams,
} from "../types";
import { formatPostgresTimestamp } from "./row-mappers";

/**
 * Bridges the dialect-specific timestamp column representation to the
 * canonical ISO-8601 strings used by `IndexMaterializationRow` and
 * `RecordIndexMaterializationParams`. Generic over the encoded type so
 * each dialect's `.values()` call gets a Drizzle-compatible shape:
 * `string` for SQLite TEXT, `Date` for Postgres TIMESTAMPTZ.
 */
type IndexMaterializationTimestampAdapter<TEncoded> = Readonly<{
  /** Convert a stored column value to ISO-8601 (or `undefined`). */
  decode(value: unknown): string | undefined;
  /** Convert an ISO-8601 string to the value Drizzle expects on insert. */
  encode(value: string): TEncoded;
}>;

export const SQLITE_INDEX_MAT_TIMESTAMPS: IndexMaterializationTimestampAdapter<string> =
  {
    decode: (value) => (typeof value === "string" ? value : undefined),
    encode: (value) => value,
  };

export const POSTGRES_INDEX_MAT_TIMESTAMPS: IndexMaterializationTimestampAdapter<Date> =
  {
    decode: formatPostgresTimestamp,
    encode: (value) => new Date(value),
  };

/**
 * Raw shape returned by Drizzle for one row of the
 * `typegraph_index_materializations` table. The caller has already
 * narrowed via the typed table query; this type just spells out the
 * dialect-shared field set so `mapMaterializationRow` can decode it.
 */
type RawIndexMaterializationRow = Readonly<{
  indexName: string;
  graphId: string;
  entity: string;
  kind: string;
  signature: string;
  schemaVersion: number;
  materializedAt: unknown;
  lastAttemptedAt: unknown;
  lastError: string | null;
}>;

export function mapMaterializationRow(
  row: RawIndexMaterializationRow,
  decode: (value: unknown) => string | undefined,
): IndexMaterializationRow {
  const lastAttemptedAt = decode(row.lastAttemptedAt);
  if (lastAttemptedAt === undefined) {
    throw new Error(
      `materialization row missing required last_attempted_at: ${row.indexName}`,
    );
  }
  return {
    indexName: row.indexName,
    graphId: row.graphId,
    entity: row.entity as IndexEntity,
    kind: row.kind,
    signature: row.signature,
    schemaVersion: row.schemaVersion,
    materializedAt: decode(row.materializedAt),
    lastAttemptedAt,
    lastError: row.lastError ?? undefined,
  };
}

/**
 * Build the column values for the upsert. Timestamp columns are
 * encoded through the adapter so the dialect's Drizzle column type
 * gets the value-shape it expects.
 */
export function buildMaterializationInsertValues<TEncoded>(
  params: RecordIndexMaterializationParams,
  encode: (value: string) => TEncoded,
): Readonly<{
  indexName: string;
  graphId: string;
  entity: IndexEntity;
  kind: string;
  signature: string;
  schemaVersion: number;
  materializedAt: TEncoded | undefined;
  lastAttemptedAt: TEncoded;
  lastError: string | undefined;
}> {
  return {
    indexName: params.indexName,
    graphId: params.graphId,
    entity: params.entity,
    kind: params.kind,
    signature: params.signature,
    schemaVersion: params.schemaVersion,
    materializedAt:
      params.materializedAt === undefined ?
        undefined
      : encode(params.materializedAt),
    lastAttemptedAt: encode(params.attemptedAt),
    lastError: params.error,
  };
}

/**
 * Build the `set` clause for the upsert's ON CONFLICT DO UPDATE.
 *
 * The `materializedAt` column uses `COALESCE` to preserve any prior
 * successful timestamp when this attempt failed (`materializedAt ===
 * undefined`). On success the new timestamp wins. This keeps the
 * status table truthful: the most recent successful materialization
 * timestamp survives even if a subsequent re-attempt errored.
 */
export function buildMaterializationOnConflictSet(
  materializedAtColumn: unknown,
  paramsMaterializedAt: string | undefined,
): Readonly<Record<string, ReturnType<typeof sql>>> {
  const materializedAtSet =
    paramsMaterializedAt === undefined ?
      sql`COALESCE(excluded.${sql.identifier("materialized_at")}, ${materializedAtColumn})`
    : sql`excluded.${sql.identifier("materialized_at")}`;
  return {
    graphId: sql`excluded.${sql.identifier("graph_id")}`,
    entity: sql`excluded.${sql.identifier("entity")}`,
    kind: sql`excluded.${sql.identifier("kind")}`,
    signature: sql`excluded.${sql.identifier("signature")}`,
    schemaVersion: sql`excluded.${sql.identifier("schema_version")}`,
    materializedAt: materializedAtSet,
    lastAttemptedAt: sql`excluded.${sql.identifier("last_attempted_at")}`,
    lastError: sql`excluded.${sql.identifier("last_error")}`,
  };
}
