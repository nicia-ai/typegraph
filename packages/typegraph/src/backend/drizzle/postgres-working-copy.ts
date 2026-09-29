/**
 * TypeGraph-owned PostgreSQL table-backed working copies. The ledger lives in
 * the caller's database; each allocation gets its own complete table set.
 */
import { getTableName } from "drizzle-orm";

import type { GraphDef } from "../../core/define-graph";
import { resolveGraphVectorSlots } from "../../core/embedding";
import { ConfigurationError } from "../../errors";
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
import {
  storeBackend,
  wrapWithManagedClose,
} from "../../graph-merge/typegraph-internal";
import type { BaseVersion } from "../../graph-merge/types";
import type {
  MakeBackend,
  WorkingCopyStrategy,
} from "../../graph-merge/working-copy";
import {
  bindRelationalIndexNameResolver,
  bindRelationalIndexNames,
  indexNameCollisionError,
  relationalIndexIdentity,
} from "../../indexes/physical-name";
import { resolveSystemIndexNames } from "../../indexes/system";
import type { IndexDeclaration } from "../../indexes/types";
import { tsvectorStrategy } from "../../query/dialect/fulltext-strategy";
import {
  allocationVectorTablePrefix,
  createPgvectorStrategyForAllocation,
  isPgvectorStrategy,
} from "../../query/dialect/vector/pgvector-strategy";
import type {
  VectorSlot,
  VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { markFixedSchemaWorkingCopyBackend } from "../../store/fixed-schema-working-copy";
import {
  createStore,
  createStoreWithSchema,
  type Store,
} from "../../store/store";
import type { StoreOptions, WorkingCopyOptions } from "../../store/types";
import { sha256Hex } from "../../utils/hash";
import { deriveBackend } from "../derive-backend";
import type { VectorIndexType, VectorMetric } from "../types";
import type { GraphBackend, TransactionBackend } from "../types";
import { CURRENT_BASE_SCHEMA_VERSION } from "./base-schema";
import {
  generatePostgresBaseSchemaMarkerSQL,
  postgresContributions,
  quoteDdlIdentifier,
} from "./ddl";
import {
  allocationSchemaOfBackend,
  allocationSchemaPin,
  bindNamesToAllocationSchema,
} from "./postgres-allocation-schema";
import {
  type PostgresCloneAction,
  resolvePostgresCloneActions,
} from "./postgres-clone-policy";
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
const WORKING_COPY_ROLE_MISMATCH = "WORKING_COPY_ROLE_MISMATCH";
/**
 * Ledger columns added after the first release. `ensureLedger` adds a missing
 * one to an existing ledger; a row written before `schema_name` existed
 * carries no schema and is resolved through the session that removes it.
 */
const ADDITIVE_LEDGER_COLUMNS = [
  { name: "vector_slots", definition: "jsonb NOT NULL DEFAULT '[]'::jsonb" },
  { name: "schema_name", definition: "text" },
] as const;

type QuerySession = Pick<GraphBackend, "execute">;
type AllocationState = "allocating" | "sealed" | "ephemeral";
type VectorSlotManifest = Readonly<{
  graphId: string;
  nodeKind: string;
  fieldPath: string;
  dimensions: number;
  metric: VectorMetric;
  indexType: VectorIndexType;
  indexParams?: VectorSlot["indexParams"];
  tableName: string;
  ownedTableNames: readonly string[];
}>;
type AllocationRow = Readonly<{
  allocation_id: string;
  physical_prefix: string;
  ownership_token: string;
  state: AllocationState;
  origin: DurableBranchOrigin | undefined;
  history: boolean;
  revision_tracking: boolean;
  vector_slots: readonly VectorSlotManifest[];
  /** The schema the allocation lives in; absent on a row written before it was recorded. */
  schema_name: string | null;
  created_at: string;
}>;
/** A ledger row read through `control`, carrying the role that read it. */
type ObservedAllocationRow = AllocationRow & Readonly<{ control_role: string }>;
/** What one session reports about itself; only the session can say. */
type SessionFacts = Readonly<{ role: string; schema: string }>;

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
 * source. `control.transaction().execute` must support transactional DDL;
 * a separate root `executeDdl` port is not required. `connect` receives the
 * complete generated name map and must bind a new backend to those names: build
 * its tables with `createPostgresTables(names)` from the object it is handed,
 * not a copy, because that object carries the allocation's schema. For a
 * cloned or durable copy of a vector graph `connect` also receives the
 * allocation-scoped strategy, and for `makeBackend` it always does (the graph is
 * not known yet); pass it to `createPostgresBackend({ vector: vectorStrategy })`.
 * A `makeBackend` connection must bind that strategy or disable vector support
 * with `vector: false`; any other strategy could create tables the allocation
 * does not own. `connect` may use any Drizzle PostgreSQL driver that holds an
 * interactive transaction.
 *
 * Every allocation lives in one schema, the `control` session's current schema
 * when it is allocated, recorded in the ledger. Provisioning, the connected
 * backend's DDL, the allocation's vector storage and removal all name that
 * schema explicitly, so a pooled connection's own `search_path` never decides
 * where an allocation's relations are created or dropped. The connection must
 * still resolve the allocation's tables, so its `search_path` must include
 * that schema.
 *
 * `connect` runs after the allocation's tables exist, except for `makeBackend`,
 * which connects first so it can refuse a bad connection before it writes
 * anything.
 */
export type PostgresWorkingCopyOptions<G extends GraphDef> = Readonly<{
  control: GraphBackend;
  /**
   * Opens a backend over one allocation. Its session must run as the same
   * PostgreSQL role as `control`: a connected Store creates objects that only
   * their owner can drop, and `control` removes them. A different role is
   * refused with a `ConfigurationError` whose `details.code` is
   * `WORKING_COPY_ROLE_MISMATCH`, and the allocation is not left behind.
   */
  connect: (
    names: PostgresTableNames,
    allocation?: Readonly<{ vectorStrategy: VectorStrategy }>,
  ) => Promise<GraphBackend>;
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
  /**
   * The PostgreSQL answer to `MakeBackend` for `branch`, `ingestionBranch`,
   * `planCandidateWriteSet`, and `branchForEvolution`. Each call allocates a
   * ledger-recorded, EMPTY, schema-mutable table set; closing the returned
   * backend drops it. A live allocation is listed by
   * `listUnsealedAllocations`, and `abortAllocation` removes one whose owner
   * crashed, including vector tables created after allocation.
   */
  makeBackend: MakeBackend;
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

function strictCreateDdl(ddl: string): string {
  return ddl
    .replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE")
    .replace("CREATE UNIQUE INDEX IF NOT EXISTS", "CREATE UNIQUE INDEX")
    .replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX");
}

function relationNamesForTables(tables: PostgresTables): readonly string[] {
  return postgresContributions(tables).map(
    (contribution) => contribution.tableName,
  );
}

/** Enumerates every table contribution and validates the strategy's primary name. */
function ownedVectorTableNames(
  slot: VectorSlot,
  strategy: VectorStrategy,
): readonly string[] {
  const tableNames = strategy.ownedTables(slot).map((item) => item.tableName);
  if (
    tableNames.length === 0 ||
    new Set(tableNames).size !== tableNames.length
  ) {
    throw new BranchError(
      "PostgreSQL working-copy vector strategy returned an empty or duplicate owned-table inventory.",
    );
  }
  if (
    !tableNames.includes(
      strategy.tableName(slot.graphId, slot.nodeKind, slot.fieldPath),
    )
  ) {
    throw new BranchError(
      "PostgreSQL working-copy vector strategy omitted its primary slot table from the owned-table inventory.",
    );
  }
  return tableNames;
}

function vectorSlotManifest(
  slots: readonly VectorSlot[],
  strategy: VectorStrategy,
): readonly VectorSlotManifest[] {
  return slots
    .map((slot) => ({
      graphId: slot.graphId,
      nodeKind: slot.nodeKind,
      fieldPath: slot.fieldPath,
      dimensions: slot.dimensions,
      metric: slot.metric,
      indexType: slot.indexType,
      ...(slot.indexParams === undefined ?
        {}
      : { indexParams: slot.indexParams }),
      tableName: strategy.tableName(
        slot.graphId,
        slot.nodeKind,
        slot.fieldPath,
      ),
      ownedTableNames: ownedVectorTableNames(slot, strategy),
    }))
    .toSorted((left, right) =>
      left.tableName < right.tableName ? -1
      : left.tableName > right.tableName ? 1
      : 0,
    );
}

function assertVectorManifestMatches(
  graph: GraphDef,
  physicalPrefix: string,
  persisted: readonly VectorSlotManifest[],
): void {
  const slots = resolveGraphVectorSlots(graph);
  const strategy = createPgvectorStrategyForAllocation(physicalPrefix);
  const expected = vectorSlotManifest(slots, strategy);
  const toKey = (entry: VectorSlotManifest): string =>
    [
      entry.graphId,
      entry.nodeKind,
      entry.fieldPath,
      entry.dimensions,
      entry.metric,
      entry.indexType,
      entry.tableName,
      ...entry.ownedTableNames,
    ].join("\u0000");
  if (
    expected.map((entry) => toKey(entry)).join("\n") !==
    persisted.map((entry) => toKey(entry)).join("\n")
  ) {
    throw new BranchError(
      "Working-copy vector slots do not match the sealed allocation schema.",
    );
  }
}

function parseVectorManifest(value: unknown): readonly VectorSlotManifest[] {
  if (!Array.isArray(value)) {
    throw new BranchError("Working-copy vector slot manifest is invalid.");
  }
  const manifest = value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new BranchError("Working-copy vector slot manifest is invalid.");
    }
    const row = entry as Record<string, unknown>;
    const metric = row["metric"];
    const indexType = row["indexType"];
    const indexParams = row["indexParams"];
    if (
      indexParams !== undefined &&
      (typeof indexParams !== "object" ||
        indexParams === null ||
        Array.isArray(indexParams))
    ) {
      throw new BranchError("Working-copy vector slot manifest is invalid.");
    }
    const validIndexParams =
      indexParams === undefined ? true : (
        Object.values(indexParams).every(
          (value) => typeof value === "number" && Number.isSafeInteger(value),
        )
      );
    if (
      typeof row["graphId"] !== "string" ||
      typeof row["nodeKind"] !== "string" ||
      typeof row["fieldPath"] !== "string" ||
      typeof row["dimensions"] !== "number" ||
      !Number.isSafeInteger(row["dimensions"]) ||
      !(metric === "cosine" || metric === "l2" || metric === "inner_product") ||
      !(
        indexType === "hnsw" ||
        indexType === "ivfflat" ||
        indexType === "none"
      ) ||
      !validIndexParams ||
      typeof row["tableName"] !== "string" ||
      (row["ownedTableNames"] !== undefined &&
        (!Array.isArray(row["ownedTableNames"]) ||
          row["ownedTableNames"].some((name) => typeof name !== "string")))
    ) {
      throw new BranchError("Working-copy vector slot manifest is invalid.");
    }
    return {
      graphId: row["graphId"],
      nodeKind: row["nodeKind"],
      fieldPath: row["fieldPath"],
      dimensions: row["dimensions"],
      metric,
      indexType,
      ...(indexParams === undefined ? {} : { indexParams }),
      tableName: row["tableName"],
      // Rows written before the owned-table inventory used one table per
      // slot; preserve their cleanup and reopen behavior.
      ownedTableNames: row["ownedTableNames"] ?? [row["tableName"]],
    } satisfies VectorSlotManifest;
  });
  return manifest;
}

/** Refuses a manifest whose slots do not name this allocation's own vector tables. */
function assertVectorManifestOwned(
  slots: readonly VectorSlotManifest[],
  strategy: VectorStrategy,
): void {
  for (const slot of slots) {
    const slotDescriptor: VectorSlot = {
      graphId: slot.graphId,
      nodeKind: slot.nodeKind,
      fieldPath: slot.fieldPath,
      dimensions: slot.dimensions,
      metric: slot.metric,
      indexType: slot.indexType,
      ...(slot.indexParams === undefined ?
        {}
      : { indexParams: slot.indexParams }),
    };
    if (
      strategy.tableName(slot.graphId, slot.nodeKind, slot.fieldPath) !==
        slot.tableName ||
      ownedVectorTableNames(slotDescriptor, strategy).join("\0") !==
        slot.ownedTableNames.join("\0")
    ) {
      throw new BranchError(
        "Working-copy vector slot manifest does not match its allocation.",
      );
    }
  }
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

function allocationPhysicalPrefix(names: PostgresTableNames): string {
  return names.nodes.slice(0, -"nodes".length);
}

function assertAllocationPrefix(
  row: AllocationRow,
  names: PostgresTableNames,
): string {
  const expected = allocationPhysicalPrefix(names);
  if (row.physical_prefix !== expected) {
    throw new BranchError(
      "Working-copy allocation prefix does not match its ledger owner.",
    );
  }
  return expected;
}

/** The one owner of allocation-scoped graph-index naming and its collision rules. */
async function resolveAllocationIndexNames(
  declarations: readonly IndexDeclaration[],
  names: PostgresTableNames,
): Promise<ReadonlyMap<string, string>> {
  const prefix = names.nodes.slice(0, -"nodes".length);
  const reserved = resolveSystemIndexNames(names);
  const entries = await Promise.all(
    declarations
      .filter((declaration) => declaration.entity !== "vector")
      .map(async (declaration) => {
        const identity = relationalIndexIdentity(declaration);
        const digest = await sha256Hex(identity, 12);
        return [identity, `${prefix}gix_${digest}`] as const;
      }),
  );
  const result = new Map<string, string>();
  const physicalNames = new Set<string>();
  for (const [identity, physicalName] of entries) {
    if (
      result.has(identity) ||
      physicalNames.has(physicalName) ||
      reserved.has(physicalName) ||
      physicalName.length > 63
    ) {
      throw indexNameCollisionError(
        "Working-copy graph index names collide in the allocated PostgreSQL namespace.",
      );
    }
    result.set(identity, physicalName);
    physicalNames.add(physicalName);
  }
  return result;
}

function allocationIndexNames(
  graph: GraphDef,
  names: PostgresTableNames,
): Promise<ReadonlyMap<string, string>> {
  return resolveAllocationIndexNames(graph.indexes ?? [], names);
}

function assertPostgresBackend(backend: GraphBackend): void {
  if (backend.dialect !== "postgres") {
    throw new BranchError(
      "PostgreSQL working copies require a PostgreSQL backend.",
    );
  }
}

function assertBundledFulltextStrategy(
  backend: GraphBackend,
  role: "source" | "target",
): void {
  if (backend.fulltextStrategy !== tsvectorStrategy) {
    throw new BranchError(
      `Table-backed PostgreSQL working-copy ${role} requires the bundled tsvector fulltext strategy; custom fulltext storage needs a native database fork.`,
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

/**
 * A connection must be built over the exact names it was handed, which is what
 * carries the allocation schema into its DDL. A copy of the names carries
 * nothing, and its lazy DDL would follow the pooled connection's `search_path`.
 * A legacy allocation records no schema and has nothing to carry.
 */
function assertAllocationSchemaBound(
  backend: GraphBackend,
  schema: string | undefined,
): void {
  if (schema === undefined || allocationSchemaOfBackend(backend) === schema) {
    return;
  }
  throw new BranchError(
    `Working-copy connection is not bound to the allocation schema "${schema}"; build its tables with createPostgresTables from the names object connect receives, not a copy of it.`,
  );
}

function assertTargetBindings(
  backend: GraphBackend,
  names: PostgresTableNames,
  schema: string | undefined,
): void {
  assertBackendBindings(backend, names, "Working-copy");
  assertBundledFulltextStrategy(backend, "target");
  assertAllocationSchemaBound(backend, schema);
}

function fixedSchemaError(operation: string): BranchError {
  return new BranchError(
    `Managed PostgreSQL table-backed working copies have a fixed schema; ${operation} is unsupported.`,
  );
}

function fixedSchemaBackend(
  backend: GraphBackend,
  indexNames: ReadonlyMap<string, string>,
): GraphBackend {
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
  bindRelationalIndexNames(guarded, indexNames);
  return guarded;
}

function withoutBootstrapDdl(backend: GraphBackend): GraphBackend {
  // Allocation already installed the complete table inventory. A connect
  // callback may carry Drizzle graph-index extras with global logical names;
  // never replay its bootstrap DDL onto these private tables.
  return deriveBackend(backend, { bootstrapTables: () => Promise.resolve() });
}

function provisionedBackend(
  backend: GraphBackend,
  indexNames: ReadonlyMap<string, string>,
): GraphBackend {
  const provisioned = withoutBootstrapDdl(backend);
  bindRelationalIndexNames(provisioned, indexNames);
  return provisioned;
}

function cloneOptions<G extends GraphDef>(source: Store<G>): StoreOptions {
  const {
    schema: _schema,
    recordedRead,
    ...options
  } = source.workingCopyOptions;
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

async function applyCloneAction(
  transaction: TransactionBackend,
  action: PostgresCloneAction,
  graphId: string,
  targetSchema: string,
): Promise<void> {
  const { source, target, policy } = action;
  const names = await columns(transaction, source.tableName);
  const scopeColumn =
    policy.kind === "graphRows" ? policy.graphIdColumn : policy.documentColumn;
  if (!names.includes(scopeColumn)) {
    throw new BranchError(
      `Working-copy relation ${source.tableName} lacks declared clone scope column ${scopeColumn}.`,
    );
  }
  const selected = sql.join(
    names.map((name) => sqlName(name)),
    sql`, `,
  );
  const selection =
    policy.kind === "graphRows" ?
      sql`${sqlName(policy.graphIdColumn)} = ${graphId}`
    : sql`${sqlName(policy.documentColumn)}->>${policy.graphIdKey} = ${graphId}`;
  await rows(
    transaction,
    sql`INSERT INTO ${sqlName(targetSchema)}.${sqlName(target.tableName)} (${selected}) SELECT ${selected} FROM ${sqlName(source.tableName)} WHERE ${selection}`,
  );
}

async function cloneRelations(
  transaction: TransactionBackend,
  sourceTables: PostgresTables,
  targetTables: PostgresTables,
  targetSchema: string,
  graphId: string,
  vectorSlots: readonly VectorSlot[],
  sourceVectorStrategy: VectorStrategy | undefined,
  targetVectorStrategy: VectorStrategy | undefined,
  assertSourceVersion: (transaction: TransactionBackend) => Promise<void>,
): Promise<void> {
  const source = postgresContributions(sourceTables);
  const target = postgresContributions(targetTables);
  const actions = resolvePostgresCloneActions(source, target);
  const sourceNames = source.map((contribution) => contribution.tableName);
  // A table lock on the pinned source transaction prevents writes between the
  // source token check and every INSERT ... SELECT. SHARE blocks ROW EXCLUSIVE.
  const sourceVectorNames = vectorSlots.flatMap((slot) => {
    if (sourceVectorStrategy === undefined) {
      throw new BranchError(
        "A vector working copy requires the source vector storage strategy.",
      );
    }
    return ownedVectorTableNames(slot, sourceVectorStrategy);
  });
  await rows(
    transaction,
    postgresTableLockSql(
      [...sourceNames, ...sourceVectorNames.toSorted()],
      "share",
    ),
  );
  await assertSourceVersion(transaction);
  const sourceMarker = getTableName(sourceTables.baseSchemaVersions);
  const marker = await rows<Readonly<{ version: number }>>(
    transaction,
    sql`SELECT version FROM ${sqlName(sourceMarker)} WHERE installation = 1`,
  );
  if (marker[0]?.version !== CURRENT_BASE_SCHEMA_VERSION) {
    throw new BranchError("Source base schema marker is not current.");
  }
  for (const action of actions) {
    await applyCloneAction(transaction, action, graphId, targetSchema);
  }
  for (const slot of vectorSlots) {
    if (
      sourceVectorStrategy === undefined ||
      targetVectorStrategy === undefined
    ) {
      throw new BranchError(
        "A vector working copy requires source and allocation vector strategies.",
      );
    }
    for (const action of resolvePostgresCloneActions(
      sourceVectorStrategy.ownedTables(slot),
      targetVectorStrategy.ownedTables(slot),
    )) {
      await applyCloneAction(transaction, action, graphId, targetSchema);
    }
  }
}

function readAllocation(
  control: GraphBackend,
  allocationId: string,
): Promise<ObservedAllocationRow | undefined> {
  return rows<ObservedAllocationRow>(
    control,
    sql`SELECT allocation_id, physical_prefix, ownership_token, state, origin, history, revision_tracking, vector_slots, schema_name, created_at::text, current_user::text AS control_role FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId}`,
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

/**
 * The one decision that `control` and `connect` are the same database role. A
 * connected Store creates objects (lazy vector tables, indexes, journals) that
 * only their owner, or a member of the owning role, can drop; `control` removes
 * every allocation, so a different role would leak them on close and abort.
 */
function assertSharedRole(controlRole: string, connectedRole: string): void {
  if (controlRole === connectedRole) return;
  throw new ConfigurationError(
    `Working-copy connection runs as role "${connectedRole}" but the control backend runs as "${controlRole}"; both must be the same database role.`,
    { code: WORKING_COPY_ROLE_MISMATCH, controlRole, connectedRole },
    {
      suggestion:
        "Connect the working-copy backend with the control backend's database role.",
    },
  );
}

async function observeSessionFacts(
  session: QuerySession,
): Promise<SessionFacts> {
  const observed = await rows<
    Readonly<{ role: string; schema: string | null }>
  >(
    session,
    sql`SELECT current_user::text AS role, current_schema() AS schema`,
  );
  return { role: observed[0]?.role ?? "", schema: observed[0]?.schema ?? "" };
}

/**
 * A connection's role is observed by its own statement, ahead of the ledger
 * token read: a role that differs from `control` usually lacks the privileges
 * that read needs, and it must be refused with the typed role error rather
 * than a permission failure. `controlRole` arrives folded into a ledger
 * statement `control` already issued.
 */
async function assertConnectionRole(
  controlRole: string,
  connected: QuerySession,
): Promise<void> {
  const connectedFacts = await observeSessionFacts(connected);
  assertSharedRole(controlRole, connectedFacts.role);
}

/**
 * The schema a new allocation is created in, chosen once from `control`'s own
 * session. From here on it is explicit: provisioning fixes its DDL to it, the
 * connected backend's DDL and the allocation's vector storage are bound to it,
 * the ledger records it, and removal resolves relations through it. No later
 * step consults a session's `search_path` to find or create an allocation
 * relation.
 */
async function observeAllocationSession(
  control: QuerySession,
): Promise<SessionFacts> {
  const facts = await observeSessionFacts(control);
  if (facts.schema === "") {
    throw new BranchError(
      "The control backend has no schema to create a working copy in: its search_path names no existing schema.",
    );
  }
  return facts;
}

/**
 * Every table an allocation owns in `schema`: its bundled tables and the vector
 * tables a schema-mutable allocation created after its manifest was written.
 * The ledger cannot list the latter and the materialization markers cannot
 * either: a marker is written after its table's DDL as a separate statement, so
 * a crash between the two leaves a table no marker names. Discover them by the
 * allocation's reserved prefixes instead, in the recorded schema and through
 * the catalog, so no session's `search_path` decides what is found.
 *
 * `starts_with` compares literally, so the `_` in a prefix is not a wildcard.
 * `allocationVectorTablePrefix` documents why one allocation's header cannot
 * match another's tables. The residual is a table created outside any
 * allocation whose name begins with this allocation's full 24-digit hash, which
 * requires a graph id equal to a ledger-reserved `tgw_` prefix; that namespace
 * is reserved to this ledger.
 */
async function discoverAllocationRelations(
  session: QuerySession,
  schema: string,
  physicalPrefix: string,
): Promise<readonly string[]> {
  const found = await rows<Readonly<{ name: string }>>(
    session,
    sql`SELECT c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND (starts_with(c.relname::text, ${physicalPrefix}) OR starts_with(c.relname::text, ${allocationVectorTablePrefix(physicalPrefix)})) ORDER BY c.relname`,
  );
  return found.map((table) => table.name);
}

/** The one decision that a connection stores vectors under the allocation's strategy. */
function bindsAllocationVectorStrategy(
  backend: GraphBackend,
  allocationStrategy: VectorStrategy,
): boolean {
  return (
    backend.vectorStrategy === allocationStrategy &&
    backend.upsertEmbedding !== undefined &&
    backend.capabilities.vector?.supported === true
  );
}

function assertMakeBackendVectorStrategy(
  backend: GraphBackend,
  allocationStrategy: VectorStrategy,
): void {
  const vectorSupportDisabled = backend.vectorStrategy === undefined;
  if (
    !vectorSupportDisabled &&
    !bindsAllocationVectorStrategy(backend, allocationStrategy)
  ) {
    throw new BranchError(
      "Working-copy connection must bind its allocation-scoped vector strategy or disable vector support; any other strategy could create tables the allocation does not own.",
    );
  }
}

/** Close a connection whose setup failed; the caller's error wins. */
async function closeQuietly(backend: GraphBackend | undefined): Promise<void> {
  try {
    await backend?.close();
  } catch {
    /* Preserve allocation error. */
  }
}

/** Build both ephemeral and durable strategies over one TypeGraph ledger. */
export function createPostgresWorkingCopyManager<G extends GraphDef>(
  options: PostgresWorkingCopyOptions<G>,
): PostgresWorkingCopyManager<G> {
  const { control, connect } = options;
  assertPostgresBackend(control);
  const cleanupLockTimeoutMs =
    options.cleanupLockTimeoutMs ?? DEFAULT_CLEANUP_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(cleanupLockTimeoutMs) || cleanupLockTimeoutMs < 1) {
    throw new BranchError("cleanupLockTimeoutMs must be a positive integer.");
  }

  async function ensureLedger(): Promise<void> {
    await control.transaction(async (transaction) => {
      await rows(
        transaction,
        sql`SELECT set_config('lock_timeout', ${`${cleanupLockTimeoutMs}ms`}, true)`,
      );
      await rows(
        transaction,
        sql.raw(`CREATE TABLE IF NOT EXISTS ${quoteDdlIdentifier(LEDGER)} (
      allocation_id text PRIMARY KEY,
      physical_prefix text NOT NULL UNIQUE,
      ownership_token text NOT NULL,
      state text NOT NULL CHECK (state IN ('allocating', 'sealed', 'ephemeral')),
      origin jsonb,
      history boolean NOT NULL,
      revision_tracking boolean NOT NULL,
      vector_slots jsonb NOT NULL DEFAULT '[]'::jsonb,
      schema_name text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`),
      );
      const present = await rows<Readonly<{ name: string }>>(
        transaction,
        sql`SELECT attname::text AS name FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass(${LEDGER}) AND attname = ANY(${ADDITIVE_LEDGER_COLUMNS.map((column) => column.name)}::text[]) AND attnum > 0 AND NOT attisdropped`,
      );
      const presentNames = new Set(present.map((column) => column.name));
      for (const column of ADDITIVE_LEDGER_COLUMNS) {
        if (presentNames.has(column.name)) continue;
        // Concurrent migrations may pass the catalog probe together. The
        // guarded ALTER lets the later holder observe the first holder's DDL.
        await rows(
          transaction,
          sql.raw(
            `ALTER TABLE ${quoteDdlIdentifier(LEDGER)} ADD COLUMN IF NOT EXISTS ${quoteDdlIdentifier(column.name)} ${column.definition}`,
          ),
        );
      }
    });
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
      const found = await rows<
        AllocationRow & Readonly<{ session_schema: string | null }>
      >(
        transaction,
        sql`SELECT allocation_id, physical_prefix, ownership_token, state, origin, history, revision_tracking, vector_slots, schema_name, created_at::text, current_schema() AS session_schema FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId} FOR UPDATE`,
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
      const physicalPrefix = assertAllocationPrefix(row, names);
      assertVectorManifestOwned(
        parseVectorManifest(row.vector_slots),
        createPgvectorStrategyForAllocation(physicalPrefix),
      );
      // A row written before its schema was recorded is resolved through this
      // session, as removal always resolved it.
      const schema = row.schema_name ?? row.session_schema;
      if (schema === null) {
        throw new BranchError(
          `Working-copy allocation ${allocationId} records no schema and this session has none to resolve it in.`,
        );
      }
      const owned = await discoverAllocationRelations(
        transaction,
        schema,
        physicalPrefix,
      );
      // Provisioning creates the bundled set in the transaction that claims the
      // row, so a recorded schema that no longer holds the nodes table means
      // the tables moved or the schema was renamed. Deleting the row would
      // discard the only pointer to them.
      if (row.schema_name !== null && !owned.includes(names.nodes)) {
        throw new BranchError(
          `Working-copy allocation ${allocationId} records schema "${row.schema_name}" but its tables are not there; the allocation is kept for recovery.`,
          { details: { allocationId, schema: row.schema_name } },
        );
      }
      // One statement, so the tables that reference each other go together. A
      // failure aborts the transaction and keeps the ledger row: the
      // allocation stays listed and recoverable.
      if (owned.length > 0) {
        await rows(
          transaction,
          sql.raw(
            `DROP TABLE ${owned
              .map(
                (name) =>
                  `${quoteDdlIdentifier(schema)}.${quoteDdlIdentifier(name)}`,
              )
              .join(", ")}`,
          ),
        );
      }
      await rows(
        transaction,
        sql`DELETE FROM ${sqlName(LEDGER)} WHERE allocation_id = ${allocationId}`,
      );
    });
  }

  type AllocationProvision = Readonly<{
    allocationId: string;
    /** The schema `observeAllocationSession` chose; provisioning fixes its DDL to it. */
    schema: string;
    state: "allocating" | "ephemeral";
    history: boolean;
    revisionTracking: boolean;
    names: PostgresTableNames;
    indexNames: ReadonlyMap<string, string>;
    vectorSlots: readonly VectorSlot[];
    vectorStrategy: VectorStrategy | undefined;
  }>;

  /**
   * The one owner of allocation provisioning: claim the ledger row, then
   * create the complete empty table set, vector sidecars, and base-schema
   * marker in the same transaction. The transaction fixes its search path to
   * the allocation schema first, so its unqualified DDL lands there whichever
   * pooled connection runs it, and the claim records the schema the statement
   * itself observed. Returns the private ownership token that every connection
   * to the allocation must attest, and the role `control` provisioned it as.
   */
  async function provisionAllocation(
    provision: AllocationProvision,
  ): Promise<Readonly<{ ownershipToken: string; controlRole: string }>> {
    const { allocationId, schema, state, names, indexNames, vectorStrategy } =
      provision;
    const physicalPrefix = allocationPhysicalPrefix(names);
    const targetTables = createPostgresTables(names);
    const vectorManifest =
      vectorStrategy === undefined ?
        []
      : vectorSlotManifest(provision.vectorSlots, vectorStrategy);
    await ensureLedger();
    const ownershipToken = globalThis.crypto.randomUUID();
    const controlRole = await control.transaction(async (transaction) => {
      await rows(transaction, allocationSchemaPin(schema));
      // The unique ledger prefix is the ownership claim for both bundled
      // tables and vector sidecars. Hold it through all provisioning DDL.
      const claimed = await rows<
        Readonly<{
          allocation_id: string;
          role: string;
          schema_name: string | null;
        }>
      >(
        transaction,
        sql`INSERT INTO ${sqlName(LEDGER)} (allocation_id, physical_prefix, ownership_token, state, history, revision_tracking, vector_slots, schema_name) VALUES (${allocationId}, ${physicalPrefix}, ${ownershipToken}, ${state}, ${provision.history}, ${provision.revisionTracking}, ${JSON.stringify(vectorManifest)}::jsonb, current_schema()) ON CONFLICT DO NOTHING RETURNING allocation_id, current_user::text AS role, schema_name`,
      );
      const claim = claimed[0];
      if (claimed.length !== 1 || claim === undefined) {
        throw new BranchError(
          "Working-copy allocation id or physical prefix is already owned.",
        );
      }
      if (claim.schema_name !== schema) {
        throw new BranchError(
          `Working-copy allocation could not be fixed to schema "${schema}"; the provisioning session resolved "${claim.schema_name ?? ""}".`,
        );
      }
      const existing = await rows<Readonly<{ name: string }>>(
        transaction,
        sql`SELECT c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = ANY(${[...new Set([...relationNamesForTables(targetTables), ...indexNames.values(), ...vectorManifest.flatMap((slot) => slot.ownedTableNames)])]}::text[])`,
      );
      if (existing.length > 0) {
        throw new BranchError(
          "Working-copy allocation names already exist; recover their owner before retrying.",
        );
      }
      for (const contribution of postgresContributions(targetTables)) {
        for (const ddl of contribution.createDdl) {
          await rows(transaction, sql.raw(strictCreateDdl(ddl)));
        }
      }
      if (vectorStrategy !== undefined) {
        for (const slot of provision.vectorSlots) {
          for (const contribution of vectorStrategy.ownedTables(slot)) {
            for (const ddl of contribution.createDdl) {
              await rows(transaction, sql.raw(strictCreateDdl(ddl)));
            }
          }
        }
      }
      await rows(
        transaction,
        sql.raw(generatePostgresBaseSchemaMarkerSQL(targetTables)),
      );
      return claim.role;
    });
    return { ownershipToken, controlRole };
  }

  /** Release a provisioned allocation whose setup failed; the caller's error wins. */
  async function discardAllocation(
    backend: GraphBackend | undefined,
    allocationId: string,
  ): Promise<void> {
    await closeQuietly(backend);
    try {
      await dropAllocation(allocationId);
    } catch {
      /* Orphan remains discoverable. */
    }
  }

  async function allocate(
    source: Store<G>,
    base: BaseVersion,
    allocationId: string,
    state: "allocating" | "ephemeral",
  ): Promise<
    Readonly<{
      // The fixed-schema owned backend, before any store decorates it with
      // recorded capture. Each strategy builds its own store from this.
      backend: GraphBackend;
      descriptor: PostgresWorkingCopyLocator;
    }>
  > {
    const sourceBackend = storeBackend(source);
    assertPostgresBackend(sourceBackend);
    // External recorded reads can name relations outside the bundled inventory.
    // Refuse before writing the ledger or provisioning any target table.
    const inheritedOptions = cloneOptions(source);
    if (
      resolveGraphVectorSlots(source.graph).length > 0 &&
      (sourceBackend.vectorStrategy === undefined ||
        !isPgvectorStrategy(sourceBackend.vectorStrategy))
    ) {
      throw new BranchError(
        "Table-backed PostgreSQL working copies require the bundled pgvector strategy for graph-scoped vector tables.",
      );
    }
    assertBundledFulltextStrategy(sourceBackend, "source");
    const sourceTables = createPostgresTables({
      ...source.revisionSchema.tables,
      ...options.sourceTableNames,
    });
    assertSourceBindings(source, sourceTables);
    const vectorSlots = resolveGraphVectorSlots(source.graph);
    const sourceVectorStrategy = sourceBackend.vectorStrategy;
    const names = await allocationNames(allocationId);
    const physicalPrefix = allocationPhysicalPrefix(names);
    const { schema } = await observeAllocationSession(control);
    bindNamesToAllocationSchema(names, schema);
    const targetVectorStrategy =
      vectorSlots.length === 0 ?
        undefined
      : createPgvectorStrategyForAllocation(physicalPrefix, schema);
    const targetTables = createPostgresTables(names);
    const indexNames = await allocationIndexNames(source.graph, names);
    const { ownershipToken, controlRole } = await provisionAllocation({
      allocationId,
      schema,
      state,
      history: source.historyEnabled,
      revisionTracking: source.revisionTrackingEnabled,
      names,
      indexNames,
      vectorSlots,
      vectorStrategy: targetVectorStrategy,
    });
    let backend: GraphBackend | undefined;
    try {
      // Refuse partial custom bindings before clone or Store writes can use
      // shared default tables; the catch path removes this allocation.
      const connectedBackend =
        targetVectorStrategy === undefined ?
          await connect(names)
        : await connect(names, { vectorStrategy: targetVectorStrategy });
      backend = connectedBackend;
      assertTargetBindings(backend, names, schema);
      await assertConnectionRole(controlRole, backend);
      if (
        targetVectorStrategy !== undefined &&
        !bindsAllocationVectorStrategy(backend, targetVectorStrategy)
      ) {
        throw new BranchError(
          "Working-copy connection does not expose PostgreSQL vector operations.",
        );
      }
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
          schema,
          source.graphId,
          vectorSlots,
          sourceVectorStrategy,
          targetVectorStrategy,
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
      const ownedBackend = provisionedBackend(backend, indexNames);
      const [store] = await createStoreWithSchema(
        source.graph,
        ownedBackend,
        inheritedOptions,
      );
      if ((source.graph.indexes?.length ?? 0) > 0) {
        const materialized = await store.materializeIndexes({
          stopOnError: true,
          refreshStatistics: false,
        });
        const failed = materialized.results.find(
          (result) =>
            result.status === "failed" ||
            (result.status === "skipped" &&
              !source.graph.indexes?.some(
                (declaration) =>
                  declaration.entity === "vector" &&
                  declaration.indexType === "none" &&
                  declaration.name === result.indexName &&
                  declaration.kind === result.kind,
              )),
        );
        if (failed !== undefined) {
          throw new BranchError(
            `Working-copy graph index "${failed.indexName}" was ${failed.status}; allocation was aborted.`,
            { cause: failed.error },
          );
        }
      }
      if (options.refreshStatistics === true) await store.refreshStatistics();
      return {
        backend: fixedSchemaBackend(ownedBackend, indexNames),
        descriptor: { allocationId },
      };
    } catch (error) {
      await discardAllocation(backend, allocationId);
      throw error;
    }
  }

  const durable: DurableWorkingCopyStrategy<G, PostgresWorkingCopyLocator> = {
    type: STRATEGY_TYPE,
    version: FORMAT_VERSION,
    create: async (source, base, _branchId, allocationId) => {
      const { backend, descriptor } = await allocate(
        source,
        base,
        allocationId,
        "allocating",
      );
      try {
        const [store] = await createStoreWithSchema(
          source.graph,
          backend,
          cloneOptions(source),
        );
        return { store, descriptor, access: { kind: "engine-fenced" } };
      } catch (error) {
        try {
          await backend.close();
        } catch {
          /* Preserve store-creation error. */
        }
        try {
          await dropAllocation(allocationId);
        } catch {
          /* Orphan remains discoverable. */
        }
        throw error;
      }
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
      const physicalPrefix = assertAllocationPrefix(row, names);
      const indexNames = await allocationIndexNames(graph, names);
      const vectorSlots = parseVectorManifest(row.vector_slots);
      assertVectorManifestMatches(graph, physicalPrefix, vectorSlots);
      // A row written before its schema was recorded reopens unbound, as it
      // always has.
      const schema = row.schema_name ?? undefined;
      if (schema !== undefined) bindNamesToAllocationSchema(names, schema);
      const vectorStrategy =
        vectorSlots.length === 0 ?
          undefined
        : createPgvectorStrategyForAllocation(physicalPrefix, schema);
      const backend =
        vectorStrategy === undefined ?
          await connect(names)
        : await connect(names, { vectorStrategy });
      try {
        assertTargetBindings(backend, names, schema);
        await assertConnectionRole(row.control_role, backend);
        if (
          vectorStrategy !== undefined &&
          !bindsAllocationVectorStrategy(backend, vectorStrategy)
        ) {
          throw new BranchError(
            "Working-copy connection did not bind its allocation-scoped vector strategy.",
          );
        }
        await assertAllocationSession(
          backend,
          descriptor.allocationId,
          row.ownership_token,
        );
        const store = createStore(
          graph,
          fixedSchemaBackend(
            provisionedBackend(backend, indexNames),
            indexNames,
          ),
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
      const disposableBackend = wrapWithManagedClose(created.backend, () =>
        dropAllocation(allocationId),
      );
      bindRelationalIndexNames(
        disposableBackend,
        await allocationIndexNames(
          source.graph,
          await allocationNames(allocationId),
        ),
      );
      markFixedSchemaWorkingCopyBackend(disposableBackend);
      return createStore(source.graph, disposableBackend, cloneOptions(source));
    },
  };

  const makeBackend: MakeBackend = async () => {
    const allocationId = globalThis.crypto.randomUUID();
    const names = await allocationNames(allocationId);
    const physicalPrefix = allocationPhysicalPrefix(names);
    const controlFacts = await observeAllocationSession(control);
    bindNamesToAllocationSchema(names, controlFacts.schema);
    // The graph, and so its vector slots, is unknown until a Store opens. Vector
    // tables are created later under this allocation's strategy, in its schema;
    // the manifest stays empty and `dropAllocation` discovers them by prefix.
    const vectorStrategy = createPgvectorStrategyForAllocation(
      physicalPrefix,
      controlFacts.schema,
    );
    // Connect first: every refusal below must precede the ledger claim and DDL.
    const connected = await connect(names, { vectorStrategy });
    let provisioned = false;
    try {
      assertTargetBindings(connected, names, controlFacts.schema);
      assertMakeBackendVectorStrategy(connected, vectorStrategy);
      await assertConnectionRole(controlFacts.role, connected);
      const { ownershipToken } = await provisionAllocation({
        allocationId,
        schema: controlFacts.schema,
        state: "ephemeral",
        // Only a sealed allocation is ever reopened from these ledger columns.
        history: false,
        revisionTracking: false,
        names,
        indexNames: new Map(),
        vectorSlots: [],
        vectorStrategy: undefined,
      });
      provisioned = true;
      await assertAllocationSession(connected, allocationId, ownershipToken);
      // Schema-mutable on purpose: no fixed-schema guard or marker.
      const disposableBackend = wrapWithManagedClose(
        withoutBootstrapDdl(connected),
        () => dropAllocation(allocationId),
      );
      // Graph-declared index names are database-global. The graph arrives with
      // the Store, so scope each declaration to this allocation when first seen.
      bindRelationalIndexNameResolver(disposableBackend, (declarations) =>
        resolveAllocationIndexNames(declarations, names),
      );
      return disposableBackend;
    } catch (error) {
      if (provisioned) await discardAllocation(connected, allocationId);
      else await closeQuietly(connected);
      throw error;
    }
  };

  return {
    ephemeral,
    makeBackend,
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
        sql`SELECT allocation_id, physical_prefix, ownership_token, state, origin, history, revision_tracking, vector_slots, created_at::text FROM ${sqlName(LEDGER)} WHERE state IN ('allocating', 'ephemeral') AND allocation_id > ${after} ORDER BY allocation_id LIMIT ${limit}`,
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
