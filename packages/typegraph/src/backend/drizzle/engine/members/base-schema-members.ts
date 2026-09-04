/**
 * The base-schema lifecycle members every SQL engine profile exposes:
 * `adoptBaseSchema`, `assertBaseSchemaCurrent`, `bootstrapTables`, and
 * `executeDdl`. All four wrap one `BaseSchemaLifecycle` (`../../base-schema`)
 * built from this dialect's own version-marker access and adoption steps.
 *
 * `executeDdl` is not wrapped at all — the `GraphBackend` member IS the
 * profile's own `EngineProvisioning.executeDdl`, unchanged, so it arrives
 * here as a dep and is exposed verbatim rather than re-wrapped in a new
 * closure.
 *
 * `bootstrapTables` runs every statement `generateDdl` produces through
 * `ensureTable` rather than `executeDdl`: cold boot is the single most
 * contended DDL path there is — two replicas starting at once run exactly
 * this loop against the same database — so PostgreSQL's `ensureTable` takes
 * its concurrent-create retry here rather than trusting `IF NOT EXISTS`
 * (see `EngineProvisioning.ensureTable`'s own doc comment). SQLite's
 * `ensureTable` has no such retry to take, so this loop is byte-identical
 * to what it ran inline before this extraction.
 *
 * The version-marker access (`readVersion`, `writeVersion`) and the
 * edge-match-identity adoption step (`ensureEdgeMatchIdentityStorage`) stay
 * dialect-owned deps rather than shared bodies: both query or migrate
 * through Drizzle's typed table API or `executionAdapter`/`db` directly
 * (`PgTable` and `SQLiteTable` share no common supertype, and the two
 * migrations use unrelated introspection — `pg_attribute`/`pg_constraint`
 * on PostgreSQL, a `PRAGMA table_info` duplicate-column retry loop on
 * SQLite). Ensuring the version-marker table itself needs no such dep: it
 * is one idempotent `CREATE TABLE`, so it is built here from the
 * `ensureTable` primitive plus the caller's own rendered DDL string, the
 * same way `graph-template-members.ts` builds `ensureGraphTemplatesTable`.
 */
import {
  type BaseSchemaLifecycle,
  createBaseSchemaLifecycle,
} from "../../base-schema";

export type CreateBaseSchemaMembersDeps = Readonly<{
  /** Idempotent `CREATE TABLE ...` for the base-schema-version marker table, rendered once by the caller from its own dialect's table-DDL generator. */
  baseSchemaVersionsTableDdl: string;
  /** Runs one idempotent CREATE-shaped DDL statement — the same closure the profile's own `EngineProvisioning.ensureTable` uses. */
  ensureTable: (ddl: string) => Promise<void>;
  /** Runs one DDL statement with no concurrency handling — the profile's own `EngineProvisioning.executeDdl`, exposed here verbatim as the `GraphBackend` member of the same name. */
  executeDdl: (ddl: string) => Promise<void>;
  /** The full set of base-schema DDL statements for a fresh bootstrap — the profile's own `EngineProvisioning.generateDdl`. */
  generateDdl: () => readonly string[];
  /**
   * Reads the installed base-schema-version marker, or `undefined` when
   * none is installed yet. Dialect-owned: it selects through Drizzle's
   * typed table API directly, and `PgTable`/`SQLiteTable` share no common
   * supertype.
   */
  readVersion: () => Promise<number | undefined>;
  /**
   * Monotonically stamps `version` and returns the version observed
   * afterward. Dialect-owned for the same reason as `readVersion`, and
   * because the marker row's timestamp column type differs (a `Date` for
   * PostgreSQL, an ISO-8601 string for SQLite).
   */
  writeVersion: (version: number) => Promise<number | undefined>;
  /** The graph-templates table's own idempotent CREATE, the version-1 adoption step's other half — `graph-template-members.ts`'s `ensureGraphTemplatesTable`. */
  ensureGraphTemplatesTable: () => Promise<void>;
  /**
   * Ensures the edge table's match-identity columns, check constraint, and
   * unique index exist. Dialect-owned: PostgreSQL introspects
   * `pg_attribute`/`pg_constraint` and runs an additive migration; SQLite
   * re-reads `PRAGMA table_info` under a duplicate-column retry loop, since
   * it has no `ADD COLUMN IF NOT EXISTS`. Neither body goes through
   * `execution.execAll`/`execGet`/`execRun` or `EngineProvisioning`.
   */
  ensureEdgeMatchIdentityStorage: () => Promise<void>;
}>;

export type BaseSchemaMembers = Readonly<{
  adoptBaseSchema: () => Promise<void>;
  assertBaseSchemaCurrent: () => Promise<void>;
  bootstrapTables: () => Promise<void>;
  executeDdl: (ddl: string) => Promise<void>;
}>;

/**
 * Builds the base-schema member group. Moved out of the two dialect files
 * unchanged: same single release step (version 1: the graph-templates table
 * plus edge-match-identity adoption, run before bootstrap's generated DDL),
 * same prepare/adopt-before/adopt-after bootstrap sequencing.
 */
export function createBaseSchemaMembers(
  deps: CreateBaseSchemaMembersDeps,
): BaseSchemaMembers {
  const {
    baseSchemaVersionsTableDdl,
    ensureTable,
    executeDdl,
    generateDdl,
    readVersion,
    writeVersion,
    ensureGraphTemplatesTable,
    ensureEdgeMatchIdentityStorage,
  } = deps;

  const baseSchemaLifecycle: BaseSchemaLifecycle = createBaseSchemaLifecycle({
    readVersion,
    async ensureVersionTable(): Promise<void> {
      await ensureTable(baseSchemaVersionsTableDdl);
    },
    writeVersion,
    steps: [
      {
        version: 1,
        async adopt(): Promise<void> {
          await ensureGraphTemplatesTable();
          await ensureEdgeMatchIdentityStorage();
        },
        bootstrap: {
          phase: "before",
          adopt: ensureEdgeMatchIdentityStorage,
        },
      },
    ],
  });

  return {
    adoptBaseSchema: baseSchemaLifecycle.adopt,
    assertBaseSchemaCurrent: baseSchemaLifecycle.assertCurrent,

    async bootstrapTables(): Promise<void> {
      const startingBaseSchemaVersion =
        await baseSchemaLifecycle.prepareBootstrap();
      await baseSchemaLifecycle.adoptBeforeBootstrap(
        startingBaseSchemaVersion,
      );
      const statements = generateDdl();
      for (const statement of statements) {
        await ensureTable(statement);
      }
      await baseSchemaLifecycle.adoptAfterBootstrap(startingBaseSchemaVersion);
    },

    executeDdl,
  };
}
