/**
 * The shape every SQL engine profile fills in, and the context
 * {@link createSqlBackend} (`./create-sql-backend`) hands to the parts of a
 * profile that need the assembled pipeline rather than raw configuration.
 *
 * A profile is a HEAD of plain data and dialect closures that exist before
 * any backend object does, plus a `lateMembers` factory for the handful of
 * members that are self-referential (a transaction's own body calls back
 * into the backend that opened it) or that otherwise need the assembled
 * pipeline. Nothing here ever closes over a `backend` binding directly —
 * `EngineAssemblyContext.self()` is the one sanctioned way a late member
 * reaches the backend `createSqlBackend` is building, and it resolves only
 * once that backend object exists.
 */
import type { ResolvedSqlTableNames } from "../../../query/compiler/schema";
import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import type { SqlDialect } from "../../../query/dialect/types";
import type { VectorStrategy } from "../../../query/dialect/vector-strategy";
import type { WriteFencePlan } from "../../capabilities/write-fence";
import type { BackendResourceAudit } from "../../transaction-resource";
import type {
  AdapterBackend,
  BackendCapabilities,
  DatabaseExtensionName,
  SchemaWriteTransactionBackend,
  TransactionBackend,
} from "../../types";
import type { ContributionMaterializer } from "../contribution-materializations";
import type { SqlExecutionAdapter } from "../execution/types";
import type {
  InternalOperationBackend,
  OperationBackendBatchConfig,
  OperationBackendRowMappers,
} from "../operation-backend-core";
import type { CommonOperationStrategy } from "../operations/strategy";

/** Resolved physical table names, uniform across dialects. */
export type EngineTableNames = ResolvedSqlTableNames;

/**
 * The DDL primitives a profile owns. Every DDL statement any member group
 * emits goes through one of these rather than a bare `db.execute` /
 * `db.run`, so each dialect's wrinkle stays in one place: SQLite's DDL
 * bypasses its serialized queue on purpose, and PostgreSQL's `ensureTable`
 * carries a concurrent-create retry because two replicas can boot against
 * the same database at once.
 */
export type EngineProvisioning = Readonly<{
  /**
   * Runs ONE DDL statement with no concurrency handling — the semantics of
   * the adapter's own `executeDdl` member. Never use it for a create that
   * two booting processes can race; that is what `ensureTable` is for.
   */
  executeDdl: (ddl: string) => Promise<void>;
  /**
   * Runs one already-rendered `CREATE ...` statement idempotently, carrying
   * the dialect's concurrent-create retry where the engine needs one
   * (PostgreSQL). Every bootstrap and `ensure*` path that creates a relation
   * must use this arm, not `executeDdl`.
   */
  ensureTable: (ddl: string) => Promise<void>;
  /** The full set of base-schema DDL statements for a fresh bootstrap. */
  generateDdl: () => readonly string[];
  /**
   * PostgreSQL's additive-column migration for an index-materializations
   * table created before the build-claim columns existed. Absent on
   * dialects with no such migration to run.
   */
  ensureIndexMaterializationColumns?: (tableName: string) => Promise<void>;
  /** Installs a named database extension. PostgreSQL-only. */
  ensureExtension?: (name: DatabaseExtensionName) => Promise<void>;
  /** Installs the trigram extension specifically. PostgreSQL-only. */
  ensureTrigramExtension?: () => Promise<void>;
}>;

/**
 * The PostgreSQL-only operation-layer knobs the shared
 * `createCommonOperationBackend` assembly (`operations/`) still needs a
 * per-profile answer for, plus the one fact both dialects report:
 * whether the atomic SQL program executor is threaded into a
 * transaction-scoped operation backend at all (PostgreSQL always does;
 * SQLite's transaction-scoped backend excludes it — a real capability gap,
 * not drift). Unused until the shared operation-layer assembly is built;
 * kept minimal until then rather than speculatively naming every
 * PostgreSQL-only key up front.
 */
export type OperationFusionHooks = Readonly<{
  atomicProgramsAtTransactionScope: boolean;
}>;

/**
 * What a profile's late-bound members receive instead of the whole profile
 * or a partially built backend: the facts and collaborators
 * {@link createSqlBackend} has already assembled by the time it calls
 * `lateMembers` / `inlineMembers`, plus `self()` — a thunk resolving to the
 * exact backend object being built, safe to call only once that object has
 * been returned to a caller who could invoke it (i.e., never during the
 * profile's own construction).
 */
export type EngineAssemblyContext<TTx> = Readonly<{
  /** The backend's capabilities after the dialect's capability tail runs. */
  capabilities: BackendCapabilities;
  /** The write-fence decision, resolved once from the capabilities above. */
  fencePlan: WriteFencePlan;
  /** The operation-backend layer this profile's dialect assembled. */
  operations: InternalOperationBackend;
  /** The contribution materializer this profile's dialect assembled. */
  contributionMaterializer: ContributionMaterializer;
  /** Resolves to the backend `createSqlBackend` is building. */
  self: () => AdapterBackend<TTx>;
}>;

/**
 * The late-bound member groups a profile supplies, assembled by
 * {@link createSqlBackend} from `EngineAssemblyContext`. These stay
 * dialect-owned forever — none is a mirror waiting to be extracted into a
 * shared `members/*.ts` file, because each genuinely differs in body
 * between engines (self-referential transaction framing, the raw-SQL escape
 * hatch's driver-level binding and decoding, a lock clause resolved from the
 * fence plan).
 */
export type EngineLateMembers<TTx> = Readonly<{
  /**
   * The backend's transaction-opening surface. Self-referential — a
   * transaction's own body calls back into the backend that opened it —
   * which is why these are late members reached through
   * `EngineAssemblyContext.self()` rather than head data.
   */
  transactions: Pick<
    AdapterBackend<TTx>,
    | "transaction"
    | "transactionWithNative"
    | "adoptTransaction"
    | "schemaWriteTransaction"
  >;
  fence: Readonly<{
    lockSchemaVersionForWrite: NonNullable<
      AdapterBackend<TTx>["lockSchemaVersionForWrite"]
    >;
    /**
     * The internal, write-fence-holding transaction runner every
     * schema-commit method delegates to. Not itself an `AdapterBackend`
     * member — SQLite's schema lock is per-connection, so its
     * implementation ignores `graphId`, exactly like the uniform-signature
     * wrapper it already exposes to its contribution materializer.
     */
    runSchemaWriteTransaction: <T>(
      graphId: string,
      fn: (target: SchemaWriteTransactionBackend) => Promise<T>,
    ) => Promise<T>;
  }>;
  /**
   * The backend's raw-SQL escape hatch. Dialect-owned because parameter
   * binding and result decoding both go through the driver directly here,
   * bypassing the operation-backend layer's own row mapping.
   */
  rawSql: Pick<TransactionBackend, "execute" | "executeRaw">;
  /**
   * Statistics/maintenance operations the query planner benefits from
   * (e.g. an `ANALYZE`-shaped refresh); dialect-specific SQL hidden behind
   * one uniform member.
   */
  maintenance: Pick<AdapterBackend<TTx>, "refreshStatistics">;
  trustedImport?: AdapterBackend<TTx>["trustedImport"];
  /**
   * Optional install/claim members — database extensions, index-
   * materialization claims, edge-match identity storage — that only some
   * dialects or configurations expose.
   */
  extensions?: Partial<
    Pick<
      AdapterBackend<TTx>,
      | "ensureExtension"
      | "ensureTrigramExtension"
      | "claimIndexMaterialization"
      | "releaseIndexMaterializationClaim"
      | "ensureEdgeMatchIdentityStorage"
    >
  >;
}>;

/**
 * Everything one SQL engine contributes to `createSqlBackend`: a HEAD of
 * data and dialect closures that exist before any backend object does, and
 * a `lateMembers` factory for the members that need the assembled
 * pipeline (see the module doc comment for why the split exists).
 *
 * Four fields are scaffolding, not part of this type's steady-state shape:
 * `operations` / `contributionMaterializer` are already-built values rather
 * than something `createSqlBackend` assembles itself (the operation-backend
 * layer is still fully dialect-owned), `finalizeCapabilities` is the
 * dialect's own capability-tail derivation, and `inlineMembers` is
 * everything else this profile's dialect still builds inline — the
 * mirrored adapter members later extractions move into `members/*.ts`
 * files one group at a time. All four are drained as each extraction
 * lands; none survives past the operation-layer and member extractions.
 */
export type SqlEngineProfile<TTx> = Readonly<{
  // ---- head: data and dialect closures with no dependency on the backend ----
  /**
   * The dialect this profile is for. `createSqlBackend` threads it through
   * unexamined — into the write-fence declaration line, the fence-target
   * marker, and the profile-refusal error — never branches on it itself.
   */
  dialect: SqlDialect;
  tableNames: EngineTableNames;
  /**
   * Every statement any shared member group issues goes through this
   * adapter's `execAll`/`execGet`/`execRun`, which is where a dialect
   * serializes its own SQL over its own driver.
   */
  execution: SqlExecutionAdapter;
  /**
   * The dialect's SQL-fragment strategy (table/column resolution, JSON and
   * locking-clause construction) the operation-backend layer assembles
   * its writes and reads against.
   */
  strategy: CommonOperationStrategy;
  /** The dialect's full-text search strategy; feeds capability derivation and search compilation. */
  fulltext: FulltextStrategy;
  /** The dialect's vector-search strategy, or `undefined` when this connection has no vector extension loaded. */
  vector: VectorStrategy | undefined;
  /** The dialect's declared capabilities, before its capability tail runs. */
  declaredCapabilities: BackendCapabilities;
  /** Bind-parameter and batch-sizing limits the operation-backend layer partitions its writes against. */
  limits: Readonly<{
    maxBindParameters: number;
    batchConfig: OperationBackendBatchConfig;
  }>;
  /** Decodes a raw driver row into each operation-backend result shape — the one place a dialect's column typing is normalized. */
  rowMappers: OperationBackendRowMappers;
  /**
   * The serialized-resource verdict {@link createSqlBackend} records once,
   * before the backend object escapes (see `../../transaction-resource.ts`).
   */
  resourceAudit: BackendResourceAudit;
  /**
   * Declares whether a single statement outside an explicit transaction has
   * this engine's full durability and atomicity. `createSqlBackend` marks
   * the backend's bundled root autocommit-eligible on this word alone — a
   * profile that gets it wrong makes callers trust a write that is not yet
   * durable.
   */
  autocommit: Readonly<{ singleStatementDurable: boolean }>;
  /** Returns the current instant as an ISO string, for row mappers that stamp a value the driver does not supply. */
  nowIso?: () => string;
  provisioning: EngineProvisioning;
  fusion?: OperationFusionHooks;
  // ---- late: everything that needs the assembled pipeline ----
  /**
   * Builds the member groups that need the assembled pipeline — the
   * resolved capabilities, the fence plan, the operation-backend layer, and
   * `self()` — rather than raw head data. See {@link EngineAssemblyContext}
   * and {@link EngineLateMembers}.
   */
  lateMembers: (ctx: EngineAssemblyContext<TTx>) => EngineLateMembers<TTx>;

  // ---- temporary: fields a later extraction removes (see the type doc comment) ----
  operations: InternalOperationBackend;
  contributionMaterializer: ContributionMaterializer;
  finalizeCapabilities: (declared: BackendCapabilities) => BackendCapabilities;
  inlineMembers: (
    ctx: EngineAssemblyContext<TTx>,
  ) => Partial<AdapterBackend<TTx>>;
}>;
