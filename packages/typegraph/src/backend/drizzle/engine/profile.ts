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
import type { WriteFencePlan, WriteFenceTarget } from "../../capabilities/write-fence";
import type { BackendResourceAudit } from "../../transaction-resource";
import type {
  AdapterBackend,
  BackendCapabilities,
  DatabaseExtensionName,
  InsertNodeParams,
  ManagedNodeCreatePlan,
  TransactionBackend,
} from "../../types";
import type { ContributionMaterializer } from "../contribution-materializations";
import type { SqlExecutionAdapter } from "../execution/types";
import type {
  InternalOperationBackend,
  OperationBackendBatchConfig,
  OperationBackendRowMappers,
} from "../operation-backend-core";
import type {
  CommonOperationStrategy,
  TableExistenceCacheOptions,
} from "../operations/strategy";
import type { CreateBaseSchemaMembersDeps } from "./members/base-schema-members";
import type { CreateContributionMembersDeps } from "./members/contribution-members";
import type { CreateGraphTemplateMembersDeps } from "./members/graph-template-members";
import type { CreateIdentityMembersDeps } from "./members/identity-members";
import type { CreateIndexMaterializationMembersDeps } from "./members/index-materialization-members";
import type { CreateKindRemovalMembersDeps } from "./members/kind-removal-members";

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
 * The operation-layer fusion knobs `buildCommonOperationOptions`
 * (`./operation-layer`) reads to assemble one `createCommonOperationBackend`
 * options object for either dialect. `atomicProgramsAtTransactionScope` is
 * the one fact both dialects report: whether the atomic SQL program executor
 * is threaded into a transaction-scoped operation backend at all (PostgreSQL
 * always does; SQLite's transaction-scoped backend excludes it — a real
 * capability gap, not drift). Every other member is PostgreSQL-only and
 * optional for that reason: SQLite's dialect factory builds a value with
 * only `atomicProgramsAtTransactionScope` set, and PostgreSQL's builds one
 * with every member present except the three transaction-scope-only keys
 * (`schemaGraphWriteLockNamespace`, `edgeCardinalityInsertFusion`,
 * `nodeClaimInsertFusion`), which its dialect factory itself omits outside a
 * transaction-scoped operation backend. `buildCommonOperationOptions` spreads
 * each optional member into the assembled options only when the dialect
 * supplied it, so the presence-or-absence decision stays where the
 * asymmetry actually lives — in what each dialect factory constructs — and
 * the shared assembly never branches on which dialect it was called for.
 */
export type OperationFusionHooks = Readonly<{
  atomicProgramsAtTransactionScope: boolean;
  /** Always `true` when present; a bundled projection-aware backend fuses managed-node projections into its INSERT. */
  nodeProjectionInsertFusion?: true;
  /** Read-only prerequisite gate run before a fused projection statement. */
  beforeNodeProjectionInsert?: (
    params: InsertNodeParams,
    plan: ManagedNodeCreatePlan,
  ) => Promise<void>;
  /** Error-path projection storage classifier; must rethrow or return never. */
  refuseNodeProjectionError?: (
    params: InsertNodeParams,
    plan: ManagedNodeCreatePlan,
    error: unknown,
  ) => Promise<never>;
  /** Present only for a transaction-scoped operation backend. */
  schemaGraphWriteLockNamespace?: string;
  /** Present only for a transaction-scoped operation backend. */
  edgeCardinalityInsertFusion?: true;
  /** Present only for a transaction-scoped operation backend; claim plans require a caller-owned transaction to roll back refusals. */
  nodeClaimInsertFusion?: true;
  tableExistenceCache?: TableExistenceCacheOptions;
}>;

/**
 * What a profile's late-bound members receive instead of the whole profile
 * or a partially built backend: the facts and collaborators
 * {@link createSqlBackend} has already assembled by the time it calls
 * `lateMembers`, plus `self()` — a thunk resolving to the exact backend
 * object being built, safe to call only once that object has been returned
 * to a caller who could invoke it (i.e., never during the profile's own
 * construction).
 */
export type EngineAssemblyContext<TTx> = Readonly<{
  /**
   * The backend's capabilities after `finalizeEngineCapabilities`
   * (`./capabilities`) runs the shared capability tail on
   * `declaredCapabilities`. Each dialect builder resolves this same value a
   * second time, for the local `capabilities` its still-inline
   * operation-backend construction needs — a deliberate, harmless-today
   * duplication (see that module's doc comment).
   */
  capabilities: BackendCapabilities;
  /** The write-fence decision, resolved once from the capabilities above. */
  fencePlan: WriteFencePlan;
  /** The operation-backend layer `createSqlBackend` built from `profile.buildOperations`. */
  operations: InternalOperationBackend;
  /** The contribution materializer `createSqlBackend` built from `profile.contributionRuntime`. */
  contributionMaterializer: ContributionMaterializer;
  /** Resolves to the backend `createSqlBackend` is building. */
  self: () => AdapterBackend<TTx>;
}>;

/**
 * The late-bound member groups a profile supplies, assembled by
 * {@link createSqlBackend} from `EngineAssemblyContext`. `transactions`,
 * `rawSql`, `maintenance`, `trustedImport`, and `extensions` stay
 * dialect-owned forever — none of them is a mirror waiting to be extracted
 * into a shared `members/*.ts` file, because each genuinely differs in body
 * between engines (self-referential transaction framing, the raw-SQL escape
 * hatch's driver-level binding and decoding, a lock clause resolved from the
 * fence plan).
 */
export type EngineLateMembers<TTx> = Readonly<{
  /**
   * The backend's transaction-opening surface. Self-referential — a
   * transaction's own body calls back into the backend that opened it —
   * which is why these are late members reached through
   * `EngineAssemblyContext.self()` rather than head data. Also where
   * `contributionMaterializer`-dependent construction (a transaction-scoped
   * operation backend) stays dialect-owned, reached through
   * `ctx.contributionMaterializer` rather than a closed-over local.
   */
  transactions: Pick<
    AdapterBackend<TTx>,
    | "transaction"
    | "transactionWithNative"
    | "adoptTransaction"
    | "schemaWriteTransaction"
  >;
  fence: Readonly<{
    /**
     * The internal, write-fence-holding transaction runner every
     * schema-commit method — and `createSqlBackend`'s own contribution-
     * rebuild wiring — delegates to. `fn` receives the full
     * `InternalOperationBackend` — including `commitSchemaVersion` and
     * `setActiveVersion`, which the narrower, publicly-reachable
     * `SchemaWriteTransactionBackend` deliberately omits — because this
     * runner is the trusted internal caller the lock exists to gate, not
     * the public `schemaWriteTransaction` surface a caller's preflight
     * runs against. Not itself an `AdapterBackend` member — SQLite's schema
     * lock is per-connection, so its implementation ignores `graphId`,
     * exactly like the uniform-signature wrapper it already exposes to its
     * contribution materializer.
     */
    runSchemaWriteTransaction: <T>(
      graphId: string,
      fn: (target: InternalOperationBackend) => Promise<T>,
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
 * What a profile supplies `createSqlBackend` to build the contribution
 * member group, beyond what the profile's own head already carries
 * (`dialect`, `fulltext`, `vector`, `fenceTarget`) and what `createSqlBackend`
 * derives itself (`ensureTable`/`execute`/`operationStrategy` from
 * `provisioning`/`execution`/`strategy`, and `schemaWriteTransaction` from
 * the fence's own late member, once it exists). See
 * `members/contribution-members.ts` for what each field does.
 */
export type ContributionRuntime = Omit<
  CreateContributionMembersDeps,
  | "dialect"
  | "fulltextStrategy"
  | "vectorStrategy"
  | "fenceTarget"
  | "ensureTable"
  | "execute"
  | "operationStrategy"
  | "schemaWriteTransaction"
>;

/**
 * What a profile supplies `createSqlBackend` to build the identity/
 * recorded-relation member group, beyond `ensureTable` (from `provisioning`)
 * and `contributionTableExists` (from the contribution member group
 * `createSqlBackend` builds first). See `members/identity-members.ts`.
 */
export type IdentityRuntime = Omit<
  CreateIdentityMembersDeps,
  "ensureTable" | "contributionTableExists"
>;

/**
 * What a profile supplies `createSqlBackend` to build the graph-template
 * member group, beyond `dialect` (the profile head), `ensureTable` (from
 * `provisioning`), and `execute` (the operation layer's own `execute`, once
 * `createSqlBackend` has built it). See `members/graph-template-members.ts`.
 */
export type GraphTemplateRuntime = Omit<
  CreateGraphTemplateMembersDeps,
  "dialect" | "ensureTable" | "execute"
>;

/**
 * What a profile supplies `createSqlBackend` to build the base-schema
 * lifecycle member group, beyond `ensureTable`/`executeDdl`/`generateDdl`
 * (from `provisioning`) and `ensureGraphTemplatesTable` (from the
 * graph-template member group `createSqlBackend` builds first). See
 * `members/base-schema-members.ts`.
 */
export type BaseSchemaRuntime = Omit<
  CreateBaseSchemaMembersDeps,
  "ensureTable" | "executeDdl" | "generateDdl" | "ensureGraphTemplatesTable"
>;

/**
 * What a profile supplies `createSqlBackend` to build the index-
 * materializations member group, beyond `ensureTable` /
 * `ensureIndexMaterializationColumns` (both from `provisioning`). See
 * `members/index-materialization-members.ts`.
 */
export type IndexMaterializationRuntime = Omit<
  CreateIndexMaterializationMembersDeps,
  "ensureTable" | "ensureIndexMaterializationColumns"
>;

/**
 * What a profile supplies `createSqlBackend` to build the kind-removals
 * member group, beyond `ensureTable` (from `provisioning`). See
 * `members/kind-removal-members.ts`.
 */
export type KindRemovalRuntime = Omit<CreateKindRemovalMembersDeps, "ensureTable">;

/**
 * Everything one SQL engine contributes to `createSqlBackend`: a HEAD of
 * data and dialect closures that exist before any backend object does, and
 * a `lateMembers` factory for the members that need the assembled
 * pipeline (see the module doc comment for why the split exists).
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
  /**
   * ONE fence target for the whole backend and every transaction-scoped one
   * it builds, marked first-party by the profile itself, so every lock
   * `createSqlBackend`'s contribution-member construction and this
   * profile's own dialect-owned fence sites can take resolves the SAME
   * `resolveWriteFencePlan` decision.
   */
  fenceTarget: WriteFenceTarget;
  /** Deps for the contribution-marker member group; see {@link ContributionRuntime}. */
  contributionRuntime: ContributionRuntime;
  /** Deps for the identity/recorded-relation member group; see {@link IdentityRuntime}. */
  identityRuntime: IdentityRuntime;
  /** Deps for the graph-template member group; see {@link GraphTemplateRuntime}. */
  graphTemplateRuntime: GraphTemplateRuntime;
  /** Deps for the base-schema lifecycle member group; see {@link BaseSchemaRuntime}. */
  baseSchemaRuntime: BaseSchemaRuntime;
  /** Deps for the index-materializations member group; see {@link IndexMaterializationRuntime}. */
  indexMaterializationRuntime: IndexMaterializationRuntime;
  /** Deps for the kind-removals member group; see {@link KindRemovalRuntime}. */
  kindRemovalRuntime: KindRemovalRuntime;
  /**
   * Builds this dialect's `InternalOperationBackend` once the contribution
   * materializer exists — deferred rather than head data because the
   * operation layer's own assembly (`buildCommonOperationOptions`) needs
   * the materializer to build its projection-evidence callbacks, and that
   * materializer is now built by `createSqlBackend` itself, from
   * `contributionRuntime`, rather than by the profile ahead of time.
   */
  buildOperations: (
    contributionMaterializer: ContributionMaterializer,
  ) => InternalOperationBackend;
  /** The `GraphBackend` member of the same name. */
  close: () => Promise<void>;
  // ---- late: everything that needs the assembled pipeline ----
  /**
   * Builds the member groups that need the assembled pipeline — the
   * resolved capabilities, the fence plan, the operation-backend layer, and
   * `self()` — rather than raw head data. See {@link EngineAssemblyContext}
   * and {@link EngineLateMembers}.
   */
  lateMembers: (ctx: EngineAssemblyContext<TTx>) => EngineLateMembers<TTx>;
}>;
