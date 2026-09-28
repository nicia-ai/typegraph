/**
 * TypeGraph-owned PostgreSQL table-backed working copies. The ledger lives in
 * the caller's database; each allocation gets its own complete table set.
 */
import { getTableName } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import { resolveGraphVectorSlots } from "../../core/embedding";
import {
  compareBaseVersionAtTarget,
  computeBaseVersion,
} from "../../graph-merge/base-version";
import type {
  DurableBranchOrigin,
  DurableWorkingCopyStrategy,
} from "../../graph-merge/durable-branch";
import { durableOriginsEqual } from "../../graph-merge/durable-branch";
import { BranchError } from "../../graph-merge/errors";
import { storeBackend, wrapWithManagedClose } from "../../graph-merge/typegraph-internal";
import type { BaseVersion } from "../../graph-merge/types";
import type { WorkingCopyStrategy } from "../../graph-merge/working-copy";
import { tsvectorStrategy } from "../../query/dialect/fulltext-strategy";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { markFixedSchemaWorkingCopyBackend } from "../../store/fixed-schema-working-copy";
import { createStore, createStoreWithSchema, type Store } from "../../store/store";
import type { StoreOptions, WorkingCopyOptions } from "../../store/types";
import { sha256Hex } from "../../utils/hash";
import { deriveBackend } from "../derive-backend";
import type { GraphBackend, TransactionBackend } from "../types";
import { CURRENT_BASE_SCHEMA_VERSION } from "./base-schema";
import {
  generatePostgresBaseSchemaMarkerSQL,
  generatePostgresDropSQL,
  postgresContributions,
  quoteDdlIdentifier,
} from "./ddl";
import { postgresTableLockSql } from "./postgres-fence-sql";
import {
  createPostgresTables,
  defaultPostgresTableNames,
  type PostgresTableNames,
  type PostgresTables,
} from "./schema/postgres";

const LEDGER = "typegraph_working_copy_allocations";
const FORMAT_VERSION = 1;
const STRATEGY_TYPE = "typegraph-postgres-tables";
const DEFAULT_CLEANUP_LOCK_TIMEOUT_MS = 5000;

type QuerySession = Pick<GraphBackend, "execute">;
type AllocationState = "allocating" | "sealed" | "ephemeral";
type AllocationRow = Readonly<{
  allocation_id: string;
  ownership_token: string;
  state: AllocationState;
  origin: DurableBranchOrigin | undefined;
  history: boolean;
  revision_tracking: boolean;
  created_at: string;
}>;

/** A non-secret locator; only the ledger can map it to physical tables. */
export type PostgresWorkingCopyLocator = Readonly<{ allocationId: string }>;

/** An unsealed allocation, which may still have an active owner. */
export type PostgresUnsealedAllocation = Readonly<{
  allocationId: string;
  createdAt: string;
  state: "allocating" | "ephemeral";
}>;

/**
 * `control` and `connect` must address the same PostgreSQL database as the
 * source. `connect` receives the complete generated name map and must bind a
 * new backend to those names. Source and connected backends must expose every
 * PostgreSQL table binding, including status relations, for attestation.
 * `connect` runs after allocation tables exist and may use any Drizzle
 * PostgreSQL driver.
 */
export type PostgresWorkingCopyOptions<G extends GraphDef> = Readonly<{
  control: GraphBackend;
  connect: (names: PostgresTableNames) => Promise<GraphBackend>;
  /** Names for source relations that the Store schema binding does not expose. */
  sourceTableNames?: Partial<PostgresTableNames>;
  /** Reattached process-local hooks and query options; physical names are owned here. */
  reopenOptions?: (graph: G) => PostgresWorkingCopyReopenOptions;
  /** A disposable clone skips ANALYZE by default. */
  refreshStatistics?: boolean;
  cleanupLockTimeoutMs?: number;
}>;

/** Process-local behavior that can be rebound without changing allocation identity. */
export type PostgresWorkingCopyReopenOptions = Omit<
  WorkingCopyOptions,
  "schema" | "recordedRead"
>;

export type PostgresWorkingCopyManager<G extends GraphDef> = Readonly<{
  ephemeral: WorkingCopyStrategy<G>;
  durable: DurableWorkingCopyStrategy<G, PostgresWorkingCopyLocator>;
  /** Bounded, ordered inventory of unsealed allocations, including live ones. */
  listUnsealedAllocations: (
    options?: Readonly<{ after?: string; limit?: number }>,
  ) => Promise<readonly PostgresUnsealedAllocation[]>;
  /** Explicit recovery after the caller confirms no active owner uses this allocation. */
  abortAllocation: (allocationId: string) => Promise<void>;
}>;

function rows<T>(
  session: QuerySession,
  query: SqlFragment,
): Promise<readonly T[]> {
  return session.execute<T>(asCompiledRowsSql(query));
}

function sqlName(name: string): SqlFragment {
  return sql.identifier(name);
}

function relationNamesForTables(tables: PostgresTables): readonly string[] {
  return postgresContributions(tables).map(
    (contribution) => contribution.tableName,
  );
}

function allocationNames(allocationId: string): Promise<PostgresTableNames> {
  return sha256Hex(allocationId, 12).then(
    (digest) =>
      Object.fromEntries(
        Object.keys(defaultPostgresTableNames).map((key) => [
          key,
          `tgw_${digest}_${key.slice(0, 15)}`,
        ]),
      ) as PostgresTableNames,
  );
}

function assertPostgresBackend(backend: GraphBackend): void {
  if (backend.dialect !== "postgres") {
    throw new BranchError(
      "PostgreSQL working copies require a PostgreSQL backend.",
    );
  }
}

function assertSourceBindings<G extends GraphDef>(
  source: Store<G>,
  sourceTables: PostgresTables,
): void {
  const bound = source.revisionSchema.tables;
  for (const [key, expected] of Object.entries(bound)) {
    if (!(key in sourceTables)) continue;
    const sourceTable = sourceTables[key as keyof PostgresTables];
    if (typeof sourceTable === "string") continue;
    if (getTableName(sourceTable) !== expected) {
      throw new BranchError(
        `Source table binding ${key} disagrees with sourceTables.`,
      );
    }
  }
  const sourceNames = Object.fromEntries(
    Object.keys(defaultPostgresTableNames).map((key) => [
      key,
      getTableName(sourceTables[key as keyof PostgresTableNames]),
    ]),
  ) as PostgresTableNames;
  assertBackendBindings(storeBackend(source), sourceNames, "Source");
}

function assertBackendBindings(
  backend: GraphBackend,
  names: PostgresTableNames,
  role: "Source" | "Working-copy",
): void {
  assertPostgresBackend(backend);
  const bound = backend.tableNames;
  if (bound === undefined)
    throw new BranchError(`${role} backend has no table bindings.`);
  const actualByKey = new Map(Object.entries(bound));
  for (const [key, expected] of Object.entries(names)) {
    const actual = actualByKey.get(key);
    if (actual === undefined) {
      throw new BranchError(`${role} backend is missing table binding ${key}.`);
    }
    if (actual !== expected) {
      throw new BranchError(
        `${role} backend table binding ${key} is incorrect.`,
      );
    }
  }
}

function assertTargetBindings(
  backend: GraphBackend,
  names: PostgresTableNames,
): void {
  assertBackendBindings(backend, names, "Working-copy");
}

function fixedSchemaError(operation: string): BranchError {
  return new BranchError(
    `Managed PostgreSQL table-backed working copies have a fixed schema; ${operation} is unsupported.`,
  );
}

function fixedSchemaBackend(backend: GraphBackend): GraphBackend {
  const guarded = deriveBackend(backend, {
    commitSchemaVersion: () =>
      Promise.reject(fixedSchemaError("commitSchemaVersion")),
    setActiveVersion: () =>
      Promise.reject(fixedSchemaError("setActiveVersion")),
    ...(backend.commitSchemaVersionIfKindsEmpty === undefined ?
      {}
    : {
        commitSchemaVersionIfKindsEmpty: () =>
          Promise.reject(fixedSchemaError("commitSchemaVersionIfKindsEmpty")),
      }),
    ...(backend.commitSchemaVersionWithPreflight === undefined ?
      {}
    : {
        commitSchemaVersionWithPreflight: () =>
          Promise.reject(fixedSchemaError("commitSchemaVersionWithPreflight")),
      }),
    ...(backend.instantiateGraphTemplate === undefined ?
      {}
    : {
        instantiateGraphTemplate: () =>
          Promise.reject(fixedSchemaError("instantiateGraphTemplate")),
      }),
    ...(backend.registerGraphTemplate === undefined ?
      {}
    : {
        registerGraphTemplate: () =>
          Promise.reject(fixedSchemaError("registerGraphTemplate")),
      }),
    ...(backend.schemaWriteTransaction === undefined ?
      {}
    : {
        schemaWriteTransaction: () =>
          Promise.reject(fixedSchemaError("schemaWriteTransaction")),
      }),
  });
  markFixedSchemaWorkingCopyBackend(guarded);
  return guarded;
}

function cloneOptions<G extends GraphDef>(source: Store<G>): StoreOptions {
  const { schema: _schema, recordedRead, ...options } =
    source.workingCopyOptions;
  if (recordedRead !== undefined) {
    throw new BranchError(
      "Table-backed PostgreSQL working copies cannot copy an external recorded-read relation.",
    );
  }
  return {
    ...options,
    history: source.historyEnabled,
    revisionTracking: source.revisionTrackingEnabled,
  };
}

function reopenedOptions<G extends GraphDef>(
  graph: G,
  row: AllocationRow,
  custom?: (graph: G) => PostgresWorkingCopyReopenOptions,
): StoreOptions {
  const options = custom?.(graph) ?? {};
  for (const forbidden of [
    "schema",
    "recordedRead",
    "history",
    "revisionTracking",
  ]) {
    if (Object.hasOwn(options, forbidden)) {
      throw new BranchError(
        `PostgreSQL working-copy reopenOptions cannot set ${forbidden}.`,
      );
    }
  }
  return {
    ...options,
    history: row.history,
    revisionTracking: row.revision_tracking,
  };
}

async function columns(
  session: QuerySession,
  table: string,
): Promise<readonly string[]> {
  const result = await rows<Readonly<{ name: string }>>(
    session,
    sql`SELECT attname AS name FROM pg_attribute WHERE attrelid = to_regclass(${quoteDdlIdentifier(table)}) AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
  );
  if (result.length === 0)
    throw new BranchError(
      `Source relation ${table} is missing or empty of columns.`,
    );
  return result.map((column) => column.name);
}

async function cloneRelations(
  transaction: TransactionBackend,
  sourceTables: PostgresTables,
  targetTables: PostgresTables,
  graphId: string,
  assertSourceVersion: (transaction: TransactionBackend) => Promise<void>,
): Promise<void> {
  const source = postgresContributions(sourceTables);
  const target = postgresContributions(targetTables);
  const sourceNames = source.map((contribution) => contribution.tableName);
  // A table lock on the pinned source transaction prevents writes between the
  // source token check and every INSERT ... SELECT. SHARE blocks ROW EXCLUSIVE.
  await rows(transaction, postgresTableLockSql(sourceNames, "share"));
  await assertSourceVersion(transaction);
  const sourceMarker = getTableName(sourceTables.baseSchemaVersions);
  const marker = await rows<Readonly<{ version: number }>>(
    transaction,
    sql`SELECT version FROM ${sqlName(sourceMarker)} WHERE installation = 1`,
  );
  if (marker[0]?.version !== CURRENT_BASE_SCHEMA_VERSION) {
    throw new BranchError("Source base schema marker is not current.");
  }
  for (const [index, contribution] of source.entries()) {
    const from = contribution.tableName;
    // These are installation or physical-index state, not graph content.
    // The destination DDL seeds the base marker and indexes; fences begin
    // empty. Physical materialization keys cannot be carried across names.
    if (
      from === sourceMarker ||
      contribution.logicalName === "fences" ||
      contribution.logicalName === "indexMaterializations" ||
      contribution.logicalName === "contributionMaterializations"
    )
      continue;
    const to = target[index]?.tableName;
    if (
      to === undefined ||
      target[index]?.logicalName !== contribution.logicalName
    ) {
      throw new BranchError("Working-copy inventory changed during clone.");
    }
    const names = await columns(transaction, from);
    const selected = sql.join(
      names.map((name) => sqlName(name)),
      sql`, `,
    );
    if (contribution.logicalName === "graphTemplates") {
      await rows(
        transaction,
        sql`INSERT INTO ${sqlName(to)} (${selected}) SELECT ${selected} FROM ${sqlName(from)} WHERE schema_doc->>'graphId' = ${graphId}`,
      );
    } else if (names.includes("graph_id")) {
      await rows(
        transaction,
        sql`INSERT INTO ${sqlName(to)} (${selected}) SELECT ${selected} FROM ${sqlName(from)} WHERE graph_id = ${graphId}`,
      );
    } else {
      throw new BranchError(
        `Working-copy relation ${from} has no graph scope.`,
      );
    }
  }
}

function readAllocation(
  control: GraphBackend,
  allocationId: string,
): Promise<AllocationRow | undefined> {
  return rows<AllocationRow>(
    control,
    sql`SELECT allocation_id, ownership_token, state, origin, history, revision_tracking, created_at::text FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId}`,
  ).then((found) => found[0]);
}

async function assertAllocationSession(
  session: QuerySession,
  allocationId: string,
  ownershipToken: string,
): Promise<void> {
  const observed = await rows<Readonly<{ ownership_token: string }>>(
    session,
    sql`SELECT ownership_token FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId}`,
  );
  if (observed[0]?.ownership_token !== ownershipToken) {
    throw new BranchError(
      "Working-copy connection is not bound to the allocation database.",
    );
  }
}

/** Build both ephemeral and durable strategies over one TypeGraph ledger. */
export function createPostgresWorkingCopyManager<G extends GraphDef>(
  options: PostgresWorkingCopyOptions<G>,
): PostgresWorkingCopyManager<G> {
  const { control, connect } = options;
  assertPostgresBackend(control);
  if (control.executeDdl === undefined) {
    throw new BranchError(
      "PostgreSQL working-copy control backend must support DDL.",
    );
  }
  const cleanupLockTimeoutMs =
    options.cleanupLockTimeoutMs ?? DEFAULT_CLEANUP_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(cleanupLockTimeoutMs) || cleanupLockTimeoutMs < 1) {
    throw new BranchError("cleanupLockTimeoutMs must be a positive integer.");
  }

  async function ensureLedger(): Promise<void> {
    await control.executeDdl?.(`CREATE TABLE IF NOT EXISTS ${quoteDdlIdentifier(LEDGER)} (
      allocation_id text PRIMARY KEY,
      physical_prefix text NOT NULL UNIQUE,
      ownership_token text NOT NULL,
      state text NOT NULL CHECK (state IN ('allocating', 'sealed', 'ephemeral')),
      origin jsonb,
      history boolean NOT NULL,
      revision_tracking boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async function dropAllocation(
    allocationId: string,
    expectedOrigin?: DurableBranchOrigin,
  ): Promise<void> {
    await ensureLedger();
    await control.transaction(async (transaction) => {
      await rows(
        transaction,
        sql`SELECT set_config('lock_timeout', ${`${cleanupLockTimeoutMs}ms`}, true)`,
      );
      const found = await rows<AllocationRow>(
        transaction,
        sql`SELECT allocation_id, ownership_token, state, origin, history, revision_tracking, created_at::text FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId} FOR UPDATE`,
      );
      const row = found[0];
      if (row === undefined)
        throw new BranchError(
          `Working-copy allocation ${allocationId} does not exist.`,
        );
      if (expectedOrigin === undefined && row.state === "sealed") {
        throw new BranchError(
          "A sealed working copy requires its attested origin for destroy.",
        );
      }
      if (
        expectedOrigin !== undefined &&
        (row.state !== "sealed" ||
          row.origin === undefined ||
          !durableOriginsEqual(row.origin, expectedOrigin))
      ) {
        throw new BranchError(
          "Working-copy destroy origin does not match the sealed allocation.",
        );
      }
      const names = await allocationNames(allocationId);
      await rows(
        transaction,
        sql.raw(generatePostgresDropSQL(createPostgresTables(names))),
      );
      await rows(
        transaction,
        sql`DELETE FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId}`,
      );
    });
  }

  async function allocate(
    source: Store<G>,
    base: BaseVersion,
    allocationId: string,
    state: "allocating" | "ephemeral",
  ): Promise<
    Readonly<{ store: Store<G>; descriptor: PostgresWorkingCopyLocator }>
  > {
    const sourceBackend = storeBackend(source);
    assertPostgresBackend(sourceBackend);
    // External recorded reads can name relations outside the bundled inventory.
    // Refuse before writing the ledger or provisioning any target table.
    const inheritedOptions = cloneOptions(source);
    if (resolveGraphVectorSlots(source.graph).length > 0) {
      throw new BranchError(
        "Table-backed PostgreSQL working copies cannot isolate graph-scoped vector tables; use a native database fork for this graph.",
      );
    }
    if (sourceBackend.fulltextStrategy !== tsvectorStrategy) {
      throw new BranchError(
        "Table-backed PostgreSQL working copies require the bundled tsvector fulltext strategy.",
      );
    }
    if ((source.graph.indexes?.length ?? 0) > 0) {
      throw new BranchError(
        "Table-backed PostgreSQL working copies cannot isolate graph-declared index names in the same database; use a native database fork.",
      );
    }
    const sourceTables = createPostgresTables({
      ...source.revisionSchema.tables,
      ...options.sourceTableNames,
    });
    assertSourceBindings(source, sourceTables);
    const names = await allocationNames(allocationId);
    const targetTables = createPostgresTables(names);
    await ensureLedger();
    const existing = await rows<Readonly<{ name: string }>>(
      control,
      sql`SELECT name FROM unnest(${[...new Set(relationNamesForTables(targetTables))]}::text[]) AS name WHERE to_regclass(quote_ident(name)) IS NOT NULL`,
    );
    if (existing.length > 0) {
      throw new BranchError(
        "Working-copy allocation names already exist; recover their owner before retrying.",
      );
    }
    const physicalPrefix = names.nodes.slice(0, -"nodes".length);
    const ownershipToken = globalThis.crypto.randomUUID();
    await rows(
      control,
      sql`INSERT INTO ${sqlName(LEDGER)} (allocation_id, physical_prefix, ownership_token, state, history, revision_tracking) VALUES (${allocationId}, ${physicalPrefix}, ${ownershipToken}, ${state}, ${source.historyEnabled}, ${source.revisionTrackingEnabled})`,
    );
    let backend: GraphBackend | undefined;
    let provisioned = false;
    try {
      await control.transaction(async (transaction) => {
        for (const contribution of postgresContributions(targetTables)) {
          for (const ddl of contribution.createDdl) {
            const strictDdl = ddl
              .replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE")
              .replace(
                "CREATE UNIQUE INDEX IF NOT EXISTS",
                "CREATE UNIQUE INDEX",
              )
              .replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX");
            await rows(transaction, sql.raw(strictDdl));
          }
        }
        await rows(transaction, sql.raw(generatePostgresBaseSchemaMarkerSQL(targetTables)));
      });
      provisioned = true;
      // Refuse partial custom bindings before clone or Store writes can use
      // shared default tables; the catch path removes this allocation.
      backend = await connect(names);
      assertTargetBindings(backend, names);
      await assertAllocationSession(backend, allocationId, ownershipToken);
      await sourceBackend.transaction(async (transaction) => {
        await assertAllocationSession(
          transaction,
          allocationId,
          ownershipToken,
        );
        await cloneRelations(
          transaction,
          sourceTables,
          targetTables,
          source.graphId,
          async (lockedTransaction) => {
            const comparison = await compareBaseVersionAtTarget(
              source,
              lockedTransaction,
              base,
            );
            if (!comparison.matches) {
              throw new BranchError(
                "Source advanced before its working-copy clone snapshot was taken.",
                { details: comparison },
              );
            }
          },
        );
      });
      const current = await computeBaseVersion(source);
      if (current !== base)
        throw new BranchError(
          "Source advanced while its working copy was allocated.",
        );
      // Rebuild physical-name materialization markers for the new relations.
      // The base-schema marker is already current, so this does not replay
      // adoption DDL; it does install graph-scoped fulltext projections.
      const [store] = await createStoreWithSchema(
        source.graph,
        backend,
        inheritedOptions,
      );
      if (options.refreshStatistics === true) await store.refreshStatistics();
      const [fixedStore] = await createStoreWithSchema(
        source.graph,
        fixedSchemaBackend(backend),
        inheritedOptions,
      );
      return { store: fixedStore, descriptor: { allocationId } };
    } catch (error) {
      try {
        await backend?.close();
      } catch {
        /* Preserve allocation error. */
      }
      try {
        if (provisioned) await dropAllocation(allocationId);
        else
          await rows(
            control,
            sql`DELETE FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId}`,
          );
      } catch {
        /* Orphan remains discoverable. */
      }
      throw error;
    }
  }

  const durable: DurableWorkingCopyStrategy<G, PostgresWorkingCopyLocator> = {
    type: STRATEGY_TYPE,
    version: FORMAT_VERSION,
    create: async (source, base, _branchId, allocationId) => {
      const created = await allocate(source, base, allocationId, "allocating");
      return { ...created, access: { kind: "engine-fenced" } };
    },
    seal: async (descriptor, origin) => {
      if (descriptor.allocationId !== origin.allocationId) {
        throw new BranchError(
          "Working-copy seal origin allocation id does not match its locator.",
        );
      }
      await ensureLedger();
      const updated = await rows<Readonly<{ allocation_id: string }>>(
        control,
        sql`UPDATE ${sqlName(LEDGER)} SET state = 'sealed', origin = ${JSON.stringify(origin)}::jsonb WHERE allocation_id = ${descriptor.allocationId} AND state = 'allocating' RETURNING allocation_id`,
      );
      if (updated.length !== 1) {
        throw new BranchError(
          "Working-copy seal found a missing or mismatched allocation.",
        );
      }
    },
    abort: async (descriptor) => dropAllocation(descriptor.allocationId),
    reopen: async (graph, descriptor, descriptorVersion) => {
      if (descriptorVersion !== FORMAT_VERSION)
        throw new BranchError(
          "Unsupported PostgreSQL working-copy locator version.",
        );
      await ensureLedger();
      const row = await readAllocation(control, descriptor.allocationId);
      if (row?.state !== "sealed" || row.origin === undefined) {
        throw new BranchError("PostgreSQL working copy is absent or unsealed.");
      }
      const names = await allocationNames(descriptor.allocationId);
      const backend = await connect(names);
      try {
        assertTargetBindings(backend, names);
        await assertAllocationSession(
          backend,
          descriptor.allocationId,
          row.ownership_token,
        );
        const store = createStore(
          graph,
          fixedSchemaBackend(backend),
          reopenedOptions(graph, row, options.reopenOptions),
        );
        return { store, origin: row.origin, access: { kind: "engine-fenced" } };
      } catch (error) {
        await backend.close();
        throw error;
      }
    },
    destroy: async (descriptor, origin, descriptorVersion) => {
      if (descriptorVersion !== FORMAT_VERSION)
        throw new BranchError(
          "Unsupported PostgreSQL working-copy locator version.",
        );
      await dropAllocation(descriptor.allocationId, origin);
    },
  };

  const ephemeral: WorkingCopyStrategy<G> = {
    create: async (source, base) => {
      const allocationId = globalThis.crypto.randomUUID();
      const created = await allocate(source, base, allocationId, "ephemeral");
      const backend = storeBackend(created.store);
      const disposableBackend = wrapWithManagedClose(backend, () =>
        dropAllocation(allocationId),
      );
      markFixedSchemaWorkingCopyBackend(disposableBackend);
      return createStore(
        source.graph,
        disposableBackend,
        cloneOptions(source),
      );
    },
  };

  return {
    ephemeral,
    durable,
    listUnsealedAllocations: async ({ after = "", limit = 100 } = {}) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new BranchError(
          "Unsealed-allocation inventory limit must be 1 to 1000.",
        );
      }
      await ensureLedger();
      const found = await rows<AllocationRow>(
        control,
        sql`SELECT allocation_id, ownership_token, state, origin, history, revision_tracking, created_at::text FROM ${sqlName(LEDGER)} WHERE state IN ('allocating', 'ephemeral') AND allocation_id > ${after} ORDER BY allocation_id LIMIT ${limit}`,
      );
      return found.map((row) => ({
        allocationId: row.allocation_id,
        createdAt: row.created_at,
        state:
          row.state === "ephemeral" ?
            ("ephemeral" as const)
          : ("allocating" as const),
      }));
    },
    abortAllocation: async (allocationId) => dropAllocation(allocationId),
  };
}
