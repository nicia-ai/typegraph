/**
 * Operational Identity and recorded-time relation provisioning: the
 * revision-origins table, the four identity relations' idempotent
 * enablement surface, and the DDL both identity and recorded relations
 * hand back as data instead of executing — shared verbatim by every SQL
 * engine profile.
 *
 * Building the actual Drizzle table objects for a caller-supplied physical
 * name and walking them into `TableContribution`s stays dialect-owned:
 * `PgTable` and `SQLiteTable` share no common supertype, exactly the
 * restriction `contribution-members.ts`'s module doc comment describes for
 * the marker tables. `contributionsForTableNames` is the one dependency
 * that composes each dialect's own `createXTables` + `xContributions`;
 * everything downstream of it — which barrel keys belong to which relation
 * set, how a missing table is detected, how a recorded relation's DDL
 * splits into `createTable` / `indexes` — is genuinely identical.
 */
import { requireDefined } from "../../../../utils/presence";
import type { TableContribution } from "../../../table-contribution";
import type {
  IdentityTableNames,
  RecordedRelationDdl,
  RecordedTableNames,
} from "../../../types";

/**
 * Barrel keys (contribution logical names) of the four relations that hold
 * Operational Identity state: current assertions, recorded-time assertions,
 * the derived closure, and the derived separation relation.
 * `ensureIdentityTables()` scopes its idempotent CREATE TABLE / CREATE INDEX
 * to exactly these when identity is first enabled on an existing database.
 */
const IDENTITY_TABLE_LOGICAL_NAMES: ReadonlySet<string> = new Set([
  "identityAssertions",
  "recordedIdentityAssertions",
  "identityClosure",
  "identitySeparation",
]);

/**
 * Barrel keys (contribution logical names) of the three relations that hold
 * timestamp-only recorded-time state. `recordedTableDdl()` scopes its
 * projected DDL to exactly these.
 */
const RECORDED_TABLE_LOGICAL_NAMES: ReadonlySet<string> = new Set([
  "recordedNodes",
  "recordedEdges",
  "recordedClock",
]);

export type CreateIdentityMembersDeps = Readonly<{
  /** Idempotent `CREATE TABLE ...` for the revision-origins table, rendered once by the caller from its own dialect's table-DDL generator. */
  revisionOriginsTableDdl: string;
  /** Runs one idempotent CREATE-shaped DDL statement — the same closure the profile's own `EngineProvisioning.ensureTable` uses. */
  ensureTable: (ddl: string) => Promise<void>;
  /** Whether the given physical table name currently exists — the same catalog probe `createContributionMembers` builds. */
  contributionTableExists: (tableName: string) => Promise<boolean>;
  /**
   * This dialect's authoritative `TableContribution` set for a
   * caller-supplied physical-name override — i.e. `xContributions(buildXTables(overrides), fulltextStrategy)`.
   * Pure: builds Drizzle table objects and walks them, issuing no SQL. The
   * one seam a shared implementation cannot call directly, for the same
   * reason `contribution-members.ts` cannot call `.from()` / `.insert()`
   * on a generic table parameter.
   */
  contributionsForTableNames: (
    overrides: Readonly<Record<string, string>>,
  ) => readonly TableContribution[];
  /**
   * Names a recorded relation's PRIMARY KEY constraint from its resolved
   * physical table name (PostgreSQL: `<table>_pkey`, the name the server
   * derives for the unnamed inline `PRIMARY KEY (…)` both dialects emit).
   * Absent on a dialect that does not name PRIMARY KEY constraints
   * separately (SQLite) — `recordedTableDdl` then omits the field entirely
   * rather than setting it to `undefined`.
   */
  primaryKeyConstraintNameFor?: (tableName: string) => string;
}>;

export type IdentityMembers = Readonly<{
  ensureRevisionOriginsTable: () => Promise<void>;
  ensureIdentityTables: (
    tableNames: IdentityTableNames,
    options: Readonly<{ provisionMissing: boolean }>,
  ) => Promise<readonly string[]>;
  identityTableDdl: (tableNames: IdentityTableNames) => readonly string[];
  recordedTableDdl: (
    tableNames: RecordedTableNames,
  ) => Readonly<Record<keyof RecordedTableNames, RecordedRelationDdl>>;
}>;

/**
 * Builds the identity/recorded-relation member group. Moved out of the two
 * dialect files unchanged: same missing-table detection, same idempotent
 * provisioning, same recorded-relation DDL split.
 */
export function createIdentityMembers(
  deps: CreateIdentityMembersDeps,
): IdentityMembers {
  const {
    revisionOriginsTableDdl,
    ensureTable,
    contributionTableExists,
    contributionsForTableNames,
    primaryKeyConstraintNameFor,
  } = deps;

  /**
   * The contribution descriptors for exactly the identity relations, under
   * caller-supplied physical names. Pure — nothing is executed here — and
   * the single owner of "which DDL belongs to the identity relations",
   * shared by `ensureIdentityTables` (which runs it) and `identityTableDdl`
   * (which hands it to a transaction).
   */
  function identityContributionsFor(
    identityTableNames: IdentityTableNames,
  ): readonly TableContribution[] {
    return contributionsForTableNames(identityTableNames).filter(
      (contribution) =>
        IDENTITY_TABLE_LOGICAL_NAMES.has(contribution.logicalName),
    );
  }

  /**
   * The contribution descriptors for exactly the three recorded relations,
   * under caller-supplied physical names. Pure — nothing is executed here —
   * and the single owner of "which DDL belongs to the recorded relations",
   * handed to `recordedTableDdl`'s caller (the offline legacy-schema
   * migration) rather than executed directly.
   */
  function recordedContributionsFor(
    recordedTableNames: RecordedTableNames,
  ): readonly TableContribution[] {
    return contributionsForTableNames(recordedTableNames).filter(
      (contribution) =>
        RECORDED_TABLE_LOGICAL_NAMES.has(contribution.logicalName),
    );
  }

  return {
    async ensureRevisionOriginsTable(): Promise<void> {
      await ensureTable(revisionOriginsTableDdl);
    },

    async ensureIdentityTables(
      identityTableNames: IdentityTableNames,
      options: Readonly<{ provisionMissing: boolean }>,
    ): Promise<readonly string[]> {
      // First enablement of Operational Identity on an existing populated
      // database: createStore / createXBackend run no DDL, so the four
      // identity relations the enablement preflight reads/writes may not
      // exist yet. Ensure them (and their indexes and CHECK constraints)
      // idempotently — CREATE TABLE / CREATE INDEX IF NOT EXISTS — reusing
      // the same contribution DDL bootstrapTables emits, scoped to the
      // identity relations. Stores run this before opening the
      // schema-commit transaction so DDL does not re-enter its per-graph
      // write lock.
      const identityContributions =
        identityContributionsFor(identityTableNames);
      const missing: string[] = [];
      for (const contribution of identityContributions) {
        if (!(await contributionTableExists(contribution.tableName))) {
          missing.push(contribution.logicalName);
        }
      }
      // Do not turn a missing assertion ledger on an already-enabled graph
      // into an empty-but-present table. Otherwise the first open fails,
      // then a retry silently accepts lost identity truth. First enablement
      // opts into provisioning; when all tables exist, idempotent DDL still
      // repairs missing secondary indexes.
      if (missing.length === 0 || options.provisionMissing) {
        for (const contribution of identityContributions) {
          for (const ddl of contribution.createDdl) {
            await ensureTable(ddl);
          }
        }
      }
      return missing;
    },

    identityTableDdl(identityTableNames: IdentityTableNames): readonly string[] {
      return identityContributionsFor(identityTableNames).flatMap(
        (contribution) => [...contribution.createDdl],
      );
    },

    recordedTableDdl(
      recordedTableNames: RecordedTableNames,
    ): Readonly<Record<keyof RecordedTableNames, RecordedRelationDdl>> {
      const contributions = recordedContributionsFor(recordedTableNames);
      function ddlFor(
        logicalName: keyof RecordedTableNames,
      ): RecordedRelationDdl {
        const contribution = requireDefined(
          contributions.find((entry) => entry.logicalName === logicalName),
          `recordedTableDdl: no contribution for ${logicalName}.`,
        );
        return {
          createTable: requireDefined(
            contribution.createDdl[0],
            `recordedTableDdl: empty DDL for ${logicalName}.`,
          ),
          indexes: contribution.createDdl.slice(1),
          ...(primaryKeyConstraintNameFor === undefined ?
            {}
          : {
              primaryKeyConstraintName: primaryKeyConstraintNameFor(
                contribution.tableName,
              ),
            }),
        };
      }
      return {
        recordedClock: ddlFor("recordedClock"),
        recordedEdges: ddlFor("recordedEdges"),
        recordedNodes: ddlFor("recordedNodes"),
      };
    },
  };
}
