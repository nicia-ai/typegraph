/**
 * The backend's optional catalog-introspection surface: physical-schema
 * probes a store path consults directly, spelled once per dialect by the
 * two bundled profiles instead of a `dialect === "postgres"` branch at each
 * call site.
 *
 * Every member is a read-only probe except `dropInvalidIndex`, which issues
 * the one DDL statement that heals a crashed concurrent index build.
 * Nothing here writes a graph row, a sidecar row, or a status row.
 */
import { ConfigurationError } from "../../errors";
import { type GraphBackend } from "../types";

/**
 * A physical index's presence and, on engines that can leave a build
 * half-finished, whether the leftover is usable.
 *
 * `invalid` is PostgreSQL's `pg_index.indisvalid = false` — an interrupted
 * `CREATE INDEX CONCURRENTLY` leaves a same-named index behind that a later
 * `IF NOT EXISTS` build would otherwise accept silently. SQLite has no such
 * state: `invalid` is always `false` there, and `exists` alone is the whole
 * answer.
 */
export type IndexState = Readonly<{
  /** The physical SQL index name that was probed. */
  name: string;
  /** Whether an index with this name exists in the engine catalog. */
  exists: boolean;
  /** PostgreSQL's invalid-build leftover flag; always `false` on SQLite. */
  invalid: boolean;
}>;

/**
 * A physical column's declared type, reduced to the family the two callers
 * that classify a recorded-time column actually distinguish: an integer
 * counter, text (SQLite's affinity for a wall-clock column stored as an
 * ISO-8601 string), PostgreSQL's exact `timestamp with time zone`, or
 * anything else. Kept this coarse on purpose — no caller needs a finer
 * classification, and each dialect's own probe decides which of these a
 * given declared type maps to, using that engine's own type rules (exact
 * match on PostgreSQL, affinity on SQLite).
 *
 * PostgreSQL's own normalizer never reports `"text"` — a declared `text`
 * column on that dialect falls through to `"other"`, since nothing
 * PostgreSQL-side stores a recorded-time column that way. That asymmetry is
 * why a revision or wall-time comparison must compare against
 * {@link REVISION_COLUMN_KINDS} / {@link WALL_TIME_COLUMN_KINDS} rather than
 * a single literal: the two dialects agree on the revision kind but not on
 * the wall-time one.
 */
export type NormalizedColumnKind =
  "integer" | "text" | "timestamp-with-time-zone" | "other";

/**
 * The `columnTypes` kinds that count as a revision counter. Both dialects
 * normalize one to `"integer"`, so this is a single-member set today — named
 * and exported so a caller compares against ONE owned set instead of
 * re-spelling `=== "integer"` inline. Consumed by
 * `store/recorded-capture/schema-version.ts`'s `isCompatibleColumnKind`,
 * which replaced that file's dialect-branching `isCompatibleColumnType` and
 * its SQLite-affinity twin (`hasSqliteAffinity`) with this owned set.
 */
export const REVISION_COLUMN_KINDS: readonly NormalizedColumnKind[] = [
  "integer",
];

/**
 * The `columnTypes` kinds that count as a wall-clock timestamp. SQLite
 * stores one as an ISO-8601 string (`"text"`); PostgreSQL stores one as
 * `timestamp with time zone` (`"timestamp-with-time-zone"`) and never
 * normalizes a declared column to `"text"` at all — so this set stays exact
 * on both dialects without a caller ever branching on `dialect`. Consumed
 * by `store/recorded-capture/schema-version.ts`'s `isCompatibleColumnKind`,
 * alongside {@link REVISION_COLUMN_KINDS}.
 */
export const WALL_TIME_COLUMN_KINDS: readonly NormalizedColumnKind[] = [
  "text",
  "timestamp-with-time-zone",
];

/**
 * One physical column's name, normalized type family, and raw declared
 * type — trimmed and lower-cased, but otherwise exactly what the engine's
 * own catalog reports (`"bigint"`, `"timestamp with time zone"`, a SQLite
 * declared type such as `"integer"` or `"text"`, and so on). `kind` is what
 * a comparison should classify against; `declaredType` is what a
 * diagnostic should show a human, since `kind` discards the declared
 * spelling entirely.
 */
export type CatalogColumn = Readonly<{
  name: string;
  kind: NormalizedColumnKind;
  declaredType: string;
}>;

/** One physical table's catalog presence. See {@link BackendCatalogProbes.tablesExist}. */
export type TableState = Readonly<{
  /** The physical SQL table name that was probed. */
  name: string;
  /** Whether a table with this name exists in the engine catalog. */
  exists: boolean;
}>;

/**
 * The three facts index materialization used to keep in its own
 * dialect-keyed record: whether this engine can build an index
 * concurrently (without blocking readers/writers), whether a concurrent
 * build can be interrupted into a usable-but-invalid leftover, and whether
 * it offers the GIN index family fulltext/trigram indexing needs.
 */
export type CatalogIndexBehavior = Readonly<{
  concurrentBuilds: boolean;
  hasInvalidIndexState: boolean;
  supportsGinFamily: boolean;
}>;

/**
 * Physical-schema introspection a store path consults directly: table and
 * index presence, PostgreSQL's invalid-index leftover state and its
 * self-heal, normalized column types, and the per-dialect index-build
 * facts above.
 *
 * Optional: a custom backend that omits it loses the store paths that
 * consult it directly — index materialization (`store.materializeIndexes()`
 * refuses only once its empty-candidate short circuit and the index-
 * materialization status table's `CREATE TABLE` have already run;
 * `store.materializeSystemIndexes()`, which has no candidate short circuit,
 * refuses only once that same status-table `CREATE TABLE` has run), the
 * recorded-time schema check, and the recorded-time migration's column read.
 */
export type BackendCatalogProbes = Readonly<{
  /**
   * Whether a table with this physical name exists in the engine catalog —
   * on PostgreSQL, anything an unqualified `DELETE`/`ANALYZE` against the
   * name could hit (ordinary and partitioned tables, views, materialized
   * views, foreign tables), matching the dialect operation strategy's own
   * DDL-target probe. A caller that means specifically "is this a TABLE",
   * as opposed to any relation an unqualified statement could resolve to,
   * wants {@link BackendCatalogProbes.tablesExist} instead — its narrower
   * predicate excludes views, materialized views, and foreign tables.
   */
  tableExists: (this: void, name: string) => Promise<boolean>;
  /**
   * The catalog state of each named physical TABLE, one entry per input
   * name (an absent name reports `exists: false`), resolved in one round
   * trip. On PostgreSQL this is ordinary and partitioned tables only
   * (`relkind IN ('r', 'p')`) — narrower than {@link tableExists}, which
   * also matches views, materialized views, and foreign tables. A caller
   * gating bulk, table-scoped work (a preload ahead of table DDL, say)
   * wants this member so it gets one round trip and the strict predicate,
   * rather than looping {@link tableExists} or accepting its wider match.
   */
  tablesExist: (
    this: void,
    names: readonly string[],
  ) => Promise<readonly TableState[]>;
  /**
   * The catalog state of each named physical index, one entry per input
   * name (an absent index reports `exists: false`), resolved in one
   * round trip.
   */
  indexStates: (
    this: void,
    names: readonly string[],
  ) => Promise<readonly IndexState[]>;
  /**
   * Drops the named index if — and only if — it is a PostgreSQL INVALID
   * leftover from an interrupted `CREATE INDEX CONCURRENTLY`. A no-op on
   * an engine whose `indexBehavior.hasInvalidIndexState` is `false`, and
   * a no-op for a valid or absent index on every engine.
   *
   * A ROOT-BACKEND operation: PostgreSQL refuses `DROP INDEX CONCURRENTLY`
   * inside a transaction block, so the `catalog` a `transaction()` handle
   * exposes throws a typed `ConfigurationError` from this member instead of
   * attempting the DDL — every other member here stays a plain read on
   * that same transaction-scoped bag.
   */
  dropInvalidIndex: (this: void, name: string) => Promise<void>;
  /** Every column's name and normalized type family for one physical table. */
  columnTypes: (this: void, table: string) => Promise<readonly CatalogColumn[]>;
  /** This engine's index-build facts. See {@link CatalogIndexBehavior}. */
  indexBehavior: CatalogIndexBehavior;
}>;

/**
 * THE refusal for a store path that needs the backend's catalog probes and
 * finds them absent, naming the missing port so a caller can add it — or
 * switch to a bundled backend — instead of chasing a `TypeError` two calls
 * deep into `materializeIndexes` or a recorded-time migration.
 */
export function requireCatalog(
  backend: Pick<GraphBackend, "catalog">,
  operation: string,
): BackendCatalogProbes {
  const catalog = backend.catalog;
  if (catalog === undefined) {
    throw new ConfigurationError(
      `${operation} requires the backend's catalog probes, but this backend declares no \`catalog\`.`,
      { code: "CATALOG_UNAVAILABLE", operation },
      {
        suggestion:
          "Implement `catalog` on this backend, or use a built-in SQLite or PostgreSQL backend.",
      },
    );
  }
  return catalog;
}
