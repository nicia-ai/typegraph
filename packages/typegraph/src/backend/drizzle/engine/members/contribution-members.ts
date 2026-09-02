/**
 * Contribution-marker bookkeeping: the durable-marker CRUD, the
 * `ContributionMaterializer` wiring, and the adapter-facing members it
 * backs — shared verbatim by every SQL engine profile.
 *
 * Every marker-table statement goes through one of two seams the caller
 * supplies rather than through Drizzle's typed table API directly: a
 * `ContributionMarkerRowAccess` / `ReconciliationMarkerRowAccess` pair for
 * the two tables' SELECT/INSERT..ON CONFLICT/DELETE, and `ensureTable` /
 * `execute` for DDL and the catalog probe. Drizzle's own `.from()` /
 * `.insert()` / `.delete()` builders are typed against each dialect's own
 * table class (`PgTable` vs `SQLiteTable`) with no common supertype, so one
 * shared implementation cannot call them directly on a generic table
 * parameter — the identity-matching, row-decoding, and upsert-shaping logic
 * lives here instead, and each dialect binds the three-line access closures
 * to its own `db` and table objects. `ensureTable` and `execute` carry no
 * such restriction: `EngineProvisioning.ensureTable` and the root execution
 * adapter's `execute` are already uniform across dialects (SQLite's queue
 * bypass and PostgreSQL's concurrent-create retry live inside the closures
 * the caller passes in, unchanged).
 */
import { and, type AnyColumn, eq, type SQL } from "drizzle-orm";

import type { FulltextStrategy } from "../../../../query/dialect/fulltext-strategy";
import type { SqlDialect } from "../../../../query/dialect/types";
import {
  type VectorSlot,
  type VectorStrategy,
} from "../../../../query/dialect/vector-strategy";
import { requireDefined } from "../../../../utils/presence";
import type { WriteFenceTarget } from "../../../capabilities/write-fence";
import type {
  ContributionDiagnostic,
  ContributionMaterializationIdentity,
  ContributionMaterializationRow,
  ContributionProbeEntry,
  ContributionRebuildResult,
  ContributionRebuildScope,
  ContributionRepairResult,
  ContributionRepopulationStats,
  RecordContributionMaterializationParams,
  SchemaWriteTransactionBackend,
  TransactionBackend,
} from "../../../types";
import {
  type ContributionMaterializer,
  createContributionMaterializer,
  mapContributionMaterializationRow,
  type RawContributionMaterializationRow,
} from "../../contribution-materializations";
import type { ExecutableSql } from "../../execution/types";
import {
  type CommonOperationStrategy,
  tableExistsFromRow,
} from "../../operations/strategy";

/** The contribution-marker table's identity columns, as generic Drizzle columns. */
type ContributionMarkerColumns = Readonly<{
  graphId: AnyColumn;
  logicalName: AnyColumn;
  owner: AnyColumn;
  tableName: AnyColumn;
}>;

/**
 * The three statements the contribution-marker table needs, bound to one
 * dialect's `db` and table object by the caller. `upsert` takes the same
 * domain params `recordContributionMaterialization` does, rather than a
 * pre-shaped Drizzle payload: shaping the insert values and the
 * ON CONFLICT `set` clause (via `buildContributionInsertValues` /
 * `buildContributionOnConflictSet`) stays inside the per-dialect binding,
 * where the table's own typed columns are in scope, so Drizzle keeps
 * checking the payload against the table instead of the call being widened
 * to `never` to paper over the two dialects' distinct table types.
 */
type ContributionMarkerRowAccess = Readonly<{
  selectWhere: (
    condition: SQL,
  ) => Promise<readonly RawContributionMaterializationRow[]>;
  upsert: (params: RecordContributionMaterializationParams) => Promise<void>;
  deleteWhere: (condition: SQL) => Promise<void>;
}>;

/** The reconciliation-marker table's one identity column. */
type ReconciliationMarkerColumns = Readonly<{ graphId: AnyColumn }>;

/** The two statements the reconciliation-marker table needs. See {@link ContributionMarkerRowAccess}. */
type ReconciliationMarkerRowAccess = Readonly<{
  selectWhere: (
    condition: SQL,
  ) => Promise<readonly Readonly<{ reconciledToVersion: number }>[]>;
  upsert: (graphId: string, version: number) => Promise<void>;
}>;

/** Options accepted by every `ensureVectorSlotContribution(s)` call. */
type EnsureVectorSlotOptions = Readonly<{
  force?: boolean;
  onDrift?: "throw" | "skip";
}>;

export type CreateContributionMembersDeps = Readonly<{
  dialect: SqlDialect;
  fulltextStrategy: FulltextStrategy;
  fulltextTableName: string;
  vectorStrategy: VectorStrategy | undefined;
  /** ONE fence target the materializer's two lock sites resolve, shared with every other lock this backend can take. */
  fenceTarget: WriteFenceTarget;
  /** Idempotent `CREATE TABLE ...` for the contribution-marker table, rendered once by the caller from its own dialect's table-DDL generator. */
  contributionTableDdl: string;
  /** Idempotent `CREATE TABLE ...` for the reconciliation-marker table. */
  reconciliationMarkersTableDdl: string;
  /** Runs one idempotent CREATE-shaped DDL statement — the same closure the profile's own `EngineProvisioning.ensureTable` uses. */
  ensureTable: (ddl: string) => Promise<void>;
  /** The root execution adapter's raw statement runner, for the uncached catalog probe backing `verifyContributions`. */
  execute: <TRow>(query: ExecutableSql) => Promise<readonly TRow[]>;
  operationStrategy: Pick<CommonOperationStrategy, "buildTableExists">;
  /**
   * Decodes the dialect's timestamp column representation to a canonical
   * ISO-8601 string. The reverse direction (`encode`) is not a dep here:
   * shaping the insert payload happens inside `contributionMarkerRows.upsert`,
   * in the per-dialect binding.
   */
  timestamps: Readonly<{
    decode: (value: unknown) => string | undefined;
  }>;
  contributionMarkerColumns: ContributionMarkerColumns;
  contributionMarkerRows: ContributionMarkerRowAccess;
  reconciliationMarkerColumns: ReconciliationMarkerColumns;
  reconciliationMarkerRows: ReconciliationMarkerRowAccess;
  /**
   * Runs an administrative callback under the same per-graph fence as a
   * schema commit. Absent on a backend with no transactional schema fence,
   * which declines the destructive rebuild rather than running it unfenced.
   */
  schemaWriteTransaction?: <T>(
    graphId: string,
    fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
  ) => Promise<T>;
}>;

type ContributionMembers = Readonly<{
  ensureContributionMaterializationsTable: () => Promise<void>;
  getContributionMaterialization: (
    identity: ContributionMaterializationIdentity,
  ) => Promise<ContributionMaterializationRow | undefined>;
  recordContributionMaterialization: (
    params: RecordContributionMaterializationParams,
  ) => Promise<void>;
  assertRuntimeContributionsInitialized: (graphId: string) => Promise<void>;
  ensureRuntimeContributions: (graphId: string) => Promise<void>;
  /**
   * Superseded by `ensureRuntimeContributions(graphId)` (#129). Retained as
   * a thin back-compat wrapper for callers predating #129; #135 routed it
   * through the durable-marker writer.
   */
  ensureFulltextTable: (graphId: string) => Promise<void>;
  verifyContributions: (
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ) => Promise<readonly ContributionDiagnostic[]>;
  repairContributions: (
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ) => Promise<ContributionRepairResult>;
  probeContributions: (
    graphId: string,
    vectorSlots: readonly VectorSlot[],
  ) => Promise<readonly ContributionProbeEntry[]>;
  rebuildContribution: (
    graphId: string,
    scope: ContributionRebuildScope,
    repopulate: (
      target: TransactionBackend,
    ) => Promise<ContributionRepopulationStats>,
  ) => Promise<ContributionRebuildResult>;
  // Vector counterparts of the runtime-contribution methods. Present only
  // when a vector strategy is wired (omitted under `vector: false`),
  // mirroring the embedding/search methods.
  ensureVectorSlotContribution?: (
    slot: VectorSlot,
    options?: EnsureVectorSlotOptions,
  ) => Promise<void>;
  ensureVectorSlotContributions?: (
    slots: readonly VectorSlot[],
    options?: EnsureVectorSlotOptions,
  ) => Promise<void>;
  assertVectorSlotInitialized?: (slot: VectorSlot) => Promise<void>;
  assertVectorSlotsInitialized?: (
    slots: readonly VectorSlot[],
  ) => Promise<void>;
  deleteVectorSlotContribution?: (slot: VectorSlot) => Promise<void>;
  ensureReconciliationMarkersTable: () => Promise<void>;
  getReconciliationMarker: (graphId: string) => Promise<number | undefined>;
  setReconciliationMarker: (
    graphId: string,
    version: number,
  ) => Promise<void>;
}>;

/**
 * Transaction-scoped contribution marker stamp, part of the internal
 * operation-backend layer rather than the public adapter surface. Present
 * so the destructive rebuild can commit its marker with the DDL that
 * produced it; without it the stamp would land outside the transaction and
 * could survive a rolled-back drop.
 *
 * States the row outright rather than reusing the top-level upsert, whose
 * `materialized_at` COALESCE preserves an earlier success so a failed
 * re-attempt cannot erase it. A completed rebuild replaced the storage, so
 * the recorded timestamp must be the rebuild's.
 */
export type ContributionOperationMembers = Readonly<{
  recordContributionMaterialization: (
    params: RecordContributionMaterializationParams,
  ) => Promise<void>;
}>;

export type ContributionMembersResult = Readonly<{
  contributionMaterializer: ContributionMaterializer;
  /**
   * Uncached catalog probe backing `verifyContributions`. Exposed alongside
   * `members` because a still-inline adapter member outside this module
   * (identity-relation adoption) also reads it directly.
   */
  contributionTableExists: (tableName: string) => Promise<boolean>;
  members: ContributionMembers;
}>;

/**
 * Builds the contribution-marker member group: the durable-marker CRUD,
 * the `ContributionMaterializer` this profile's dialect wires up, and the
 * adapter members that read and write through it.
 *
 * Built ahead of the operation-backend layer (which still needs the
 * returned `contributionMaterializer` to construct itself) rather than
 * from inside it — unlike this module's other member group,
 * {@link createContributionOperationMembers}.
 */
export function createContributionMembers(
  deps: CreateContributionMembersDeps,
): ContributionMembersResult {
  const {
    dialect,
    fulltextStrategy,
    fulltextTableName,
    vectorStrategy,
    fenceTarget,
    contributionTableDdl,
    reconciliationMarkersTableDdl,
    ensureTable,
    execute,
    operationStrategy,
    timestamps,
    contributionMarkerColumns,
    contributionMarkerRows,
    reconciliationMarkerColumns,
    reconciliationMarkerRows,
    schemaWriteTransaction,
  } = deps;

  function contributionMarkerIdentityCondition(
    identity: ContributionMaterializationIdentity,
  ): SQL {
    // `and(...)` of four `eq(...)` calls is always defined; `requireDefined`
    // matches `and`'s own `SQL | undefined` signature for the
    // zero-condition case, which never applies here.
    return requireDefined(
      and(
        eq(contributionMarkerColumns.graphId, identity.graphId),
        eq(contributionMarkerColumns.logicalName, identity.logicalName),
        eq(contributionMarkerColumns.owner, identity.owner),
        eq(contributionMarkerColumns.tableName, identity.tableName),
      ),
    );
  }

  async function ensureContributionMaterializationsTableImpl(): Promise<void> {
    await ensureTable(contributionTableDdl);
  }

  async function getContributionMaterializationRow(
    identity: ContributionMaterializationIdentity,
  ): Promise<ContributionMaterializationRow | undefined> {
    const rows = await contributionMarkerRows.selectWhere(
      contributionMarkerIdentityCondition(identity),
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return mapContributionMaterializationRow(row, timestamps.decode);
  }

  async function getContributionMaterializationRows(
    graphId: string,
  ): Promise<readonly ContributionMaterializationRow[]> {
    const rows = await contributionMarkerRows.selectWhere(
      eq(contributionMarkerColumns.graphId, graphId),
    );
    return rows.map((row) =>
      mapContributionMaterializationRow(row, timestamps.decode),
    );
  }

  async function recordContributionMaterializationRow(
    params: RecordContributionMaterializationParams,
  ): Promise<void> {
    await contributionMarkerRows.upsert(params);
  }

  async function deleteContributionMaterializationRow(
    identity: ContributionMaterializationIdentity,
  ): Promise<void> {
    await contributionMarkerRows.deleteWhere(
      contributionMarkerIdentityCondition(identity),
    );
  }

  /**
   * Uncached catalog probe backing `verifyContributions`. The shared
   * `createCachedTableExistence` wrapper is deliberately NOT used: this
   * diagnostic's whole job is to notice that a table confirmed present
   * earlier has since been dropped.
   */
  async function contributionTableExists(
    tableName: string,
  ): Promise<boolean> {
    const rows = await execute<Record<string, unknown>>(
      operationStrategy.buildTableExists(tableName),
    );
    return tableExistsFromRow(rows[0]);
  }

  const contributionMaterializer = createContributionMaterializer({
    dialect,
    fenceTarget,
    fulltextStrategy,
    fulltextTableName,
    vectorStrategy,
    // Contribution DDL is `CREATE ... IF NOT EXISTS` reached from every
    // booting replica, so it carries the same concurrent-create retry (or,
    // on SQLite, the same queue bypass) `ensureTable` already does. Without
    // the retry, on an engine that races concurrent creates the loser's
    // duplicate-key error is recorded as `lastError` on the marker row and
    // reported as a failed materialization, when the table it wanted is in
    // fact present.
    execDdl: ensureTable,
    ensureMarkerTable: ensureContributionMaterializationsTableImpl,
    getMarkers: getContributionMaterializationRows,
    recordMarker: recordContributionMaterializationRow,
    deleteMarker: deleteContributionMaterializationRow,
    tableExists: contributionTableExists,
    // Withheld rather than wired-and-throwing when the driver cannot hold a
    // session: the rebuild must refuse with its own typed error naming the
    // absent fence, matching `capabilities.contributions.rebuild`.
    ...(schemaWriteTransaction === undefined ?
      {}
    : { schemaWriteTransaction }),
  });

  const members: ContributionMembers = {
    async ensureContributionMaterializationsTable(): Promise<void> {
      await ensureContributionMaterializationsTableImpl();
    },

    async getContributionMaterialization(
      identity: ContributionMaterializationIdentity,
    ): Promise<ContributionMaterializationRow | undefined> {
      return getContributionMaterializationRow(identity);
    },

    async recordContributionMaterialization(
      params: RecordContributionMaterializationParams,
    ): Promise<void> {
      await recordContributionMaterializationRow(params);
    },

    async assertRuntimeContributionsInitialized(
      graphId: string,
    ): Promise<void> {
      await contributionMaterializer.assertInitialized(graphId);
    },

    async ensureRuntimeContributions(graphId: string): Promise<void> {
      await contributionMaterializer.ensureRuntimeContributions(graphId);
    },

    async ensureFulltextTable(graphId: string): Promise<void> {
      await contributionMaterializer.ensureRuntimeContributions(graphId);
    },

    async verifyContributions(
      graphId: string,
      vectorSlots: readonly VectorSlot[],
    ): Promise<readonly ContributionDiagnostic[]> {
      return contributionMaterializer.verifyContributions(
        graphId,
        vectorSlots,
      );
    },

    async repairContributions(
      graphId: string,
      vectorSlots: readonly VectorSlot[],
    ): Promise<ContributionRepairResult> {
      return contributionMaterializer.repairContributions(
        graphId,
        vectorSlots,
      );
    },

    async probeContributions(
      graphId: string,
      vectorSlots: readonly VectorSlot[],
    ): Promise<readonly ContributionProbeEntry[]> {
      return contributionMaterializer.probeContributions(
        graphId,
        vectorSlots,
      );
    },

    async rebuildContribution(
      graphId: string,
      scope: ContributionRebuildScope,
      repopulate: (
        target: TransactionBackend,
      ) => Promise<ContributionRepopulationStats>,
    ): Promise<ContributionRebuildResult> {
      return contributionMaterializer.rebuildContribution(
        graphId,
        scope,
        repopulate,
      );
    },

    ...(vectorStrategy === undefined ?
      {}
    : {
        async ensureVectorSlotContribution(
          slot: VectorSlot,
          options?: EnsureVectorSlotOptions,
        ): Promise<void> {
          await contributionMaterializer.ensureVectorSlot(slot, options);
        },

        async ensureVectorSlotContributions(
          slots: readonly VectorSlot[],
          options?: EnsureVectorSlotOptions,
        ): Promise<void> {
          await contributionMaterializer.ensureVectorSlots(slots, options);
        },

        async assertVectorSlotInitialized(slot: VectorSlot): Promise<void> {
          await contributionMaterializer.assertVectorSlot(slot);
        },

        async assertVectorSlotsInitialized(
          slots: readonly VectorSlot[],
        ): Promise<void> {
          await contributionMaterializer.assertVectorSlots(slots);
        },

        async deleteVectorSlotContribution(
          slot: VectorSlot,
        ): Promise<void> {
          await contributionMaterializer.dropVectorSlot(slot);
        },
      }),

    async ensureReconciliationMarkersTable(): Promise<void> {
      await ensureTable(reconciliationMarkersTableDdl);
    },

    async getReconciliationMarker(
      graphId: string,
    ): Promise<number | undefined> {
      const rows = await reconciliationMarkerRows.selectWhere(
        eq(reconciliationMarkerColumns.graphId, graphId),
      );
      return rows[0]?.reconciledToVersion;
    },

    async setReconciliationMarker(
      graphId: string,
      version: number,
    ): Promise<void> {
      await reconciliationMarkerRows.upsert(graphId, version);
    },
  };

  return {
    contributionMaterializer,
    contributionTableExists,
    members,
  };
}

export type CreateContributionOperationMembersDeps = Readonly<{
  /** The dialect's own statement runner for the transaction-scoped contribution stamp. */
  execRun: (query: ExecutableSql) => Promise<void>;
  operationStrategy: Pick<
    CommonOperationStrategy,
    "buildInsertContributionMaterialization"
  >;
}>;

/**
 * Builds the transaction-scoped contribution marker stamp alone. Unlike
 * {@link createContributionMembers}, this one is built from inside the
 * dialect's operation-backend construction (where `execRun` lives), the
 * same place `createFulltextMembers` / `createVectorMembers` are built.
 */
export function createContributionOperationMembers(
  deps: CreateContributionOperationMembersDeps,
): ContributionOperationMembers {
  const { execRun, operationStrategy } = deps;
  return {
    async recordContributionMaterialization(
      params: RecordContributionMaterializationParams,
    ): Promise<void> {
      await execRun(
        operationStrategy.buildInsertContributionMaterialization(params),
      );
    },
  };
}
