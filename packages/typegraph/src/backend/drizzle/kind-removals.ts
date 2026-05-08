/**
 * Shared building blocks for the `typegraph_kind_removals` status-table
 * operations on both SQLite and Postgres backends.
 *
 * Same shape as `index-materializations.ts`: the dialects differ only
 * in (a) timestamp encoding (SQLite TEXT vs Postgres TIMESTAMPTZ) and
 * (b) the raw-DDL exec call used to bootstrap the table. The row
 * mapper, the `onConflictDoUpdate` set clause, and the
 * `removed_at` COALESCE-on-failure preservation rule are dialect-
 * agnostic and live here. Two near-identical adapter copies in
 * `sqlite.ts` / `postgres.ts` collapse to ~15 lines each.
 */

import { sql } from "drizzle-orm";

import type { KindRemovalRow, RecordKindRemovalParams } from "../types";
import { formatPostgresTimestamp } from "./row-mappers";

/**
 * Bridges the dialect-specific timestamp column representation to the
 * canonical ISO-8601 strings used by `KindRemovalRow` and
 * `RecordKindRemovalParams`. Generic over the encoded type so each
 * dialect's `.values()` call gets a Drizzle-compatible shape: `string`
 * for SQLite TEXT, `Date` for Postgres TIMESTAMPTZ.
 */
type KindRemovalTimestampAdapter<TEncoded> = Readonly<{
  /** Convert a stored column value to ISO-8601 (or `undefined`). */
  decode(value: unknown): string | undefined;
  /** Convert an ISO-8601 string to the value Drizzle expects on insert. */
  encode(value: string): TEncoded;
}>;

export const SQLITE_KIND_REMOVAL_TIMESTAMPS: KindRemovalTimestampAdapter<string> =
  {
    decode: (value) => (typeof value === "string" ? value : undefined),
    encode: (value) => value,
  };

export const POSTGRES_KIND_REMOVAL_TIMESTAMPS: KindRemovalTimestampAdapter<Date> =
  {
    decode: formatPostgresTimestamp,
    encode: (value) => new Date(value),
  };

/**
 * Raw shape returned by Drizzle for one row of the
 * `typegraph_kind_removals` table.
 */
type RawKindRemovalRow = Readonly<{
  graphId: string;
  kindName: string;
  entity: string;
  schemaVersion: number;
  removedAt: unknown;
  lastAttemptedAt: unknown;
  lastError: string | null;
}>;

export function mapKindRemovalRow(
  row: RawKindRemovalRow,
  decode: (value: unknown) => string | undefined,
): KindRemovalRow {
  const lastAttemptedAt = decode(row.lastAttemptedAt);
  if (lastAttemptedAt === undefined) {
    throw new Error(
      `kind removal row missing required last_attempted_at: ${row.kindName}`,
    );
  }
  return {
    graphId: row.graphId,
    kindName: row.kindName,
    entity: row.entity as "node" | "edge",
    schemaVersion: row.schemaVersion,
    removedAt: decode(row.removedAt),
    lastAttemptedAt,
    lastError: row.lastError ?? undefined,
  };
}

/**
 * Build the column values for the upsert. Timestamp columns are
 * encoded through the adapter so the dialect's Drizzle column type
 * gets the value-shape it expects.
 */
export function buildKindRemovalInsertValues<TEncoded>(
  params: RecordKindRemovalParams,
  encode: (value: string) => TEncoded,
): Readonly<{
  graphId: string;
  kindName: string;
  entity: "node" | "edge";
  schemaVersion: number;
  removedAt: TEncoded | undefined;
  lastAttemptedAt: TEncoded;
  lastError: string | undefined;
}> {
  return {
    graphId: params.graphId,
    kindName: params.kindName,
    entity: params.entity,
    schemaVersion: params.schemaVersion,
    removedAt:
      params.removedAt === undefined ? undefined : encode(params.removedAt),
    lastAttemptedAt: encode(params.attemptedAt),
    lastError: params.error,
  };
}

/**
 * Build the `set` clause for the upsert's ON CONFLICT DO UPDATE.
 *
 * `removed_at` uses `COALESCE` to preserve any prior successful
 * timestamp when this attempt failed (`removedAt === undefined`). On
 * success, the new timestamp wins. Mirrors the materializations-table
 * preservation rule.
 */
export function buildKindRemovalOnConflictSet(
  removedAtColumn: unknown,
  paramsRemovedAt: string | undefined,
): Readonly<Record<string, ReturnType<typeof sql>>> {
  const removedAtSet =
    paramsRemovedAt === undefined ?
      sql`COALESCE(excluded.${sql.identifier("removed_at")}, ${removedAtColumn})`
    : sql`excluded.${sql.identifier("removed_at")}`;
  return {
    entity: sql`excluded.${sql.identifier("entity")}`,
    schemaVersion: sql`excluded.${sql.identifier("schema_version")}`,
    removedAt: removedAtSet,
    lastAttemptedAt: sql`excluded.${sql.identifier("last_attempted_at")}`,
    lastError: sql`excluded.${sql.identifier("last_error")}`,
  };
}
