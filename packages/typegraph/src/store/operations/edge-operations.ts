/**
 * Edge Operations for Store
 *
 * Handles edge CRUD operations: create, update, delete.
 *
 * ## Invariants this module owns
 *
 * **An edge write lands only on a row satisfying every identity component it
 * ASSERTED.** Each write issued on behalf of a kind-scoped collection —
 * `update`, soft `delete`, `hardDelete`, the batch soft delete — carries the
 * identity it asserted INSIDE the write statement's own `WHERE` (see
 * {@link UpdateEdgeParams}'s `kind` / `fromKind` / `fromId` / `toKind` /
 * `toId`). The identity the operation checked and the row the statement mutates
 * are therefore resolved by one predicate in one statement, on every backend
 * and at every isolation level: nothing another session does between the check
 * and the write can re-point that id at a row failing an assertion this write
 * made. An assertion that does not match affects zero rows, and the caller
 * hears the same `EDGE_IDENTITY_MISMATCH` / not-found refusal it would have
 * heard from the check.
 *
 * The scope of the claim is exactly "what it asserted", and no wider. An upsert
 * that resolved an edge BY its endpoints asserts them and predicates on them,
 * so a same-kind `hardDelete` + recreate pointing somewhere else is refused.
 * A plain `update` on a kind-scoped collection asserts only kind — it resolved
 * the edge by id and never looked at where it points — so a same-kind recreate
 * with different endpoints is a row it is content to write, and predicating on
 * endpoints it never checked would refuse legitimate writes instead. The node
 * delete cascade asserts nothing at all: it removes every connected edge
 * whatever its kind, and is deliberately left identity-blind.
 *
 * **A declared constraint's probe and the write it guards commit under one
 * per-graph mutual exclusion, on every backend.** Cardinality (`one` /
 * `unique` / `oneActive`) is enforced by an application probe that no database
 * key backs — the edges table's only uniqueness is its `(graph_id, id)` primary
 * key — and `getOrCreateByEndpoints` converges on a match key no key backs
 * either. Those writes therefore take the per-graph write fence for the whole
 * probe-and-write transaction (see
 * {@link file://./write-transaction.ts runInWriteTransaction}'s
 * `fencesConstraintProbe`), which SQLite already supplies through
 * `BEGIN IMMEDIATE` and PostgreSQL supplies through the per-graph advisory
 * lock — previously taken only when history or revision tracking was on, and so
 * absent from a default PostgreSQL store. An UNCONSTRAINED edge write
 * (cardinality `many`, no convergence probe) states that it needs no fence and
 * pays for none.
 *
 * **A write asserts every component its verdict READ.** The identity claim
 * above is one instance of a wider rule, and the rule is what keeps this module
 * honest: `performEdgeUpdate` probes the row, decides from what it finds, and
 * then writes, so anything the decision consumed and the statement does not
 * restate is a decision that can land on a row it was never computed for.
 * Enumerated, with where each is asserted:
 *
 *  - `kind` and the four endpoint components — asserted, per the paragraph
 *    above, exactly to the extent the caller claimed them.
 *  - `deleted_at` (live vs tombstoned, which selects the leg) — asserted as
 *    `deleted_at IS NULL` on the in-place leg. Deliberately NOT asserted on the
 *    resurrecting leg: `buildUpdateEdge`'s `clearDeleted` branch carries no
 *    tombstone predicate, so an upsert whose peer revived the row first still
 *    applies its window instead of failing. That is a convergence choice, not
 *    an oversight — the losing writer owns the properties either way.
 *  - `valid_from` — asserted via `expectedValidFrom` WHEN the window verdict
 *    read it ({@link ValidityWindowVerdict}), which is when the caller stated a
 *    `validFrom` to compare or a lone `validTo` to invert against the row's
 *    bound. A caller that states no window reads no bound and is fenced by
 *    nothing extra, on the same "only what it asserted" principle as endpoints.
 *  - `props` — read as the merge base for the caller's partial update, and NOT
 *    assertable: an edge props blob is TEXT on SQLite and `jsonb` on
 *    PostgreSQL, and neither comparison is stable under key reordering. Bounded
 *    instead by {@link performEdgeUpdateConverging}, which re-reads and
 *    re-merges whenever the bound assertion catches a replaced row.
 *  - `valid_to` when deciding whether an ended/deleted edge re-enters the active
 *    `oneActive` population — asserted only for that decision; other
 *    cardinalities do not turn an unconditional clear into a stale-value CAS.
 */
import { isBundledRootAutocommitEligible } from "../../backend/capabilities/autocommit-single-statement";
import { bindExtraIfReachable } from "../../backend/capabilities/bind";
import {
  BATCH_POINT_READ,
  type UNIQUE_SIDECAR_BATCH,
} from "../../backend/capabilities/bundle-registry";
import {
  type BundleVerdictOf,
  type ClaimsVerdictThunk,
} from "../../backend/capabilities/resolve";
import { isSchemaFencedInsertEligible } from "../../backend/capabilities/schema-fenced-insert";
import {
  assertGraphCommandConvergenceIsolation,
  executeAuthoritativeGraphCommand,
} from "../../backend/command-contract";
import { assertEdgeMatchIdentityBackendSupport } from "../../backend/edge-match-identity";
import {
  type ClaimEdgeCardinalityParams,
  type EdgeConvergeCreateCommand,
  type EdgeCreateCommand,
  type EdgeRow as BackendEdgeRow,
  type GraphBackend,
  type GraphReadBackend,
  type InsertEdgeParams,
  rowPropsToObject,
  runOptionallyInTransaction,
  type TransactionBackend,
} from "../../backend/types";
import { validateEdgeEndpoints } from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import {
  type Cardinality,
  type KindEntity,
  type TemporalMode,
} from "../../core/types";
import {
  CardinalityError,
  CompilerInvariantError,
  ConfigurationError,
  DatabaseOperationError,
  EdgeMatchIdentityConflictError,
  EdgeNotFoundError,
  EndpointNotFoundError,
  KindNotFoundError,
  ValidationError,
} from "../../errors";
import { validateEdgeProps } from "../../errors/validation";
import { type SqlSchema } from "../../query/compiler/schema";
import { type KindRegistry } from "../../registry/kind-registry";
import { canonicalEqual } from "../../schema/canonical";
import {
  assertOrderedValidityWindow,
  assertWritableValidityWindow,
  preservesImmutableLowerBound,
  validateOptionalCanonicalIsoDate,
} from "../../utils/date";
import { generateId } from "../../utils/id";
import { hasOwnKey, readOwnProperty } from "../../utils/object";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import {
  claimEdgeCardinality,
  edgeCardinalityClaim,
  edgeCardinalityClaimMode,
} from "../claims/edge-claims";
import {
  shouldCoalesceUpsert,
  type UpsertDirtyCheck,
} from "../collections/coalesce";
import { type UpsertUpdateEdgeInput } from "../collections/edge-collection";
import {
  checkCardinalityConstraint,
  type ConstraintContext,
  type ConstraintFenceReason,
  edgeWriteNeedsConstraintFence,
} from "../constraints";
import { classifyDurableEdgeBatchOutcomes } from "../durable-edge-batch";
import {
  buildEdgeMatchKey,
  canonicalPersistedJsonValue,
  edgeMatchIdentityUpdateRefusal,
  normalizePersistedEdgeMatchProps,
  resolveEdgeMatchIdentityStorage,
} from "../edge-match-key";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { type EdgeRow, rowToEdge } from "../row-mappers";
import {
  type CreateEdgeInput,
  type Edge,
  type GetOrCreateAction,
  type IfExistsMode,
  type OperationHookContext,
} from "../types";
import {
  assertClearValidToSupported,
  assertValidityEndMutation,
  validityEndAfterMutation,
} from "../validity-end";
import { withAlreadyExistsTranslation } from "./already-exists";
import {
  AutocommitWriteRequiresTransaction,
  canFuseSchemaFenceInFirstWrite,
  isAutocommitSingleStatementWrite,
} from "./autocommit-single-statement";
import { createEdgeBatchValidationBackend } from "./edge-batch-validation";
import {
  assertEdgeIdentityMatches,
  type EdgeIdentityExpectation,
  edgeIdentityFromRow,
} from "./edge-identity";
import {
  EdgeUpdateTargetMoved,
  withUnmatchedEdgeUpdateRefusal,
} from "./edge-write-fences";
import { type EdgeUpdateWork } from "./edge-write-pipeline";
import {
  type OverlaidSessionMint,
  runAutocommitSingleStatementWritePlan,
  runHookedWritePlan,
  runWritePlan,
  writeResultAlwaysChanges,
} from "./write-executor";
import {
  assertsStoredWindowState,
  type EdgeUpdateFences,
} from "./write-fences";
import { edgeWritePlan } from "./write-plan";
import {
  type EdgeInsertWork,
  type EdgeWriteSession,
  nestedManagedWriteTarget,
  unfencedTarget,
  type WriteTarget,
} from "./write-session";
import {
  diagnoseFusedSchemaFenceNoRow,
  hasLeasedSchemaFence,
  lockSchemaVersionForStoreWrite,
  memoizeLeasedSchemaFence,
  type WriteTransactionMode,
} from "./write-transaction";

// ============================================================
// Types
// ============================================================

/**
 * Context for edge operations.
 */
export type EdgeOperationContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  schemaVersion: number | undefined;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  coalesceUnchangedUpsertsEnabled: boolean;
  revisionSchema: SqlSchema;
  registry: KindRegistry;
  /**
   * The `claims` bundle's memoized, at-most-once verdict thunk (ruling B7
   * refinement 2) — threaded through to `createEdgeWriteContext` by
   * `runWritePlan`'s session mint, and called at the write-session sites that
   * issue or release an edge-cardinality claim.
   */
  claimsVerdict: ClaimsVerdictThunk;
  /** Threaded from `store.ts`'s `#batchPointRead` — never re-resolved here. */
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
  /**
   * Threaded from `store.ts`'s `#uniqueSidecarBatch` — the edge side never
   * consults it (uniqueness sidecars are a node-only concern), but the field
   * is structurally required: `runWritePlan` mints ONE shared write session
   * from this context for both node and edge write contexts, and the
   * session's `WriteSessionContext` parameter carries the field.
   */
  uniqueSidecarBatch: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>;
  createOperationContext: (
    operation: "create" | "update" | "delete",
    entity: KindEntity,
    kind: string,
    id: string,
  ) => OperationHookContext;
  withOperationHooks: <T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
    didWrite?: (result: T) => boolean,
  ) => Promise<T>;
}>;

// ============================================================
// Helper Functions
// ============================================================

// Own-key membership, matching `store.getEdgePropsSchema` and the collections
// proxy: kind names are arbitrary identifiers, so a `toString`-named kind that
// is NOT registered would otherwise read the inherited function as its
// registration and fail with a `TypeError` off `registration.type` instead of
// the `KindNotFoundError` this guard exists to raise.
function getEdgeRegistration<G extends GraphDef>(graph: G, kind: string) {
  if (!hasOwnKey(graph.edges, kind)) throw new KindNotFoundError(kind, "edge");
  const registration = graph.edges[kind];
  if (registration === undefined) throw new KindNotFoundError(kind, "edge");
  return registration;
}

type EdgeCreatePrepared = Readonly<{
  insertParams: InsertEdgeParams;
  cardinality: Cardinality;
}>;

/**
 * One prepared create as the session's insert unit: the row params and the
 * cardinality claim the row owes.
 *
 * ONE owner, shared by the single create and both batch shapes. The claim is a
 * pure function of the cardinality this preparation resolved, so deciding it
 * here keeps the decision beside the verdict it follows from; the session issues
 * it, because a claim write is a backend member only the seam may spell.
 */
function edgeInsertWork(prepared: EdgeCreatePrepared): EdgeInsertWork {
  const claim = edgeCardinalityClaim(
    prepared.cardinality,
    prepared.insertParams,
  );
  return {
    params: prepared.insertParams,
    claim,
  };
}

function buildInsertEdgeParams(
  graphId: string,
  id: string,
  kind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  props: Record<string, unknown>,
  validFrom: string | undefined,
  validTo: string | undefined,
  matchIdentity?: Readonly<{ name: string; key: string }>,
): InsertEdgeParams {
  const insertParams: {
    graphId: string;
    id: string;
    kind: string;
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    props: Record<string, unknown>;
    validFrom?: string;
    validTo?: string;
    matchIdentity?: Readonly<{ name: string; key: string }>;
  } = {
    graphId,
    id,
    kind,
    fromKind,
    fromId,
    toKind,
    toId,
    props,
  };
  if (validFrom !== undefined) insertParams.validFrom = validFrom;
  if (validTo !== undefined) insertParams.validTo = validTo;
  if (matchIdentity !== undefined) insertParams.matchIdentity = matchIdentity;
  return insertParams;
}

async function validateAndPrepareEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  id: string,
  backend: WriteTarget,
  options?: Readonly<{
    validateEndpoints?: boolean;
    validateCardinality?: boolean;
  }>,
): Promise<EdgeCreatePrepared> {
  const kind = input.kind;
  const fromKind = input.fromKind;
  const toKind = input.toKind;

  // Validate kind exists and get registration
  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;
  assertEdgeMatchIdentityBackendSupport(
    registration.matchIdentity,
    backend.capabilities,
    kind,
  );

  // Validate endpoint types
  const endpointError = validateEdgeEndpoints(
    kind,
    fromKind,
    toKind,
    registration,
    ctx.registry,
  );
  if (endpointError) throw endpointError;

  if (options?.validateEndpoints ?? true) {
    await assertLiveEdgeEndpoints(
      ctx,
      kind,
      fromKind,
      input.fromId,
      toKind,
      input.toId,
      backend,
    );
  }

  // Validate props with full context
  const validatedProps = validateEdgeProps(edgeKind.schema, input.props, {
    kind,
    operation: "create",
  });
  const matchIdentity = resolveEdgeMatchIdentityStorage(
    registration.matchIdentity,
    {
      fromKind,
      fromId: input.fromId,
      toKind,
      toId: input.toId,
      props: validatedProps,
    },
    { graphId: ctx.graphId, edgeKind: kind },
  );

  // Validate temporal fields
  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  // A stated pair must be ordered, and on an insert that is the COMPLETE rule.
  // A lone historical validTo is NOT an error — it means "born already ended"
  // (see assertWritableValidityWindow), and the insert stores no lower bound for
  // it rather than one past the stated end, so there is no effective bound left
  // for this layer to judge. Both create paths (single and batch) prepare
  // through here, so this is the only insert-side check needed.
  assertOrderedValidityWindow(`edge "${id}"`, validFrom, validTo);

  // Check cardinality constraints
  const cardinality = registration.cardinality ?? "many";
  const constraintContext: ConstraintContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
  if (options?.validateCardinality ?? true) {
    await checkCardinalityConstraint(
      constraintContext,
      kind,
      cardinality,
      fromKind,
      input.fromId,
      toKind,
      input.toId,
      validTo,
    );
  }

  return {
    cardinality,
    insertParams: buildInsertEdgeParams(
      ctx.graphId,
      id,
      kind,
      fromKind,
      input.fromId,
      toKind,
      input.toId,
      validatedProps,
      validFrom,
      validTo,
      matchIdentity,
    ),
  };
}

/**
 * Gives endpoint refusals their public ordering: source wins when both inputs
 * are unavailable. The fused INSERT uses this only after its predicate
 * produced no row, so it never spends the reads on a successful create.
 */
async function assertLiveEdgeEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  edgeKindName: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  backend: WriteTarget,
): Promise<void> {
  const fromNode = await backend.getNode(ctx.graphId, fromKind, fromId);
  if (!fromNode || fromNode.deleted_at) {
    throw new EndpointNotFoundError({
      edgeKind: edgeKindName,
      endpoint: "from",
      nodeKind: fromKind,
      nodeId: fromId,
    });
  }

  const toNode = await backend.getNode(ctx.graphId, toKind, toId);
  if (!toNode || toNode.deleted_at) {
    throw new EndpointNotFoundError({
      edgeKind: edgeKindName,
      endpoint: "to",
      nodeKind: toKind,
      nodeId: toId,
    });
  }
}

// ============================================================
// Edge Operations
// ============================================================

/**
 * The cardinality an edge create must honor, resolved from the graph def.
 * Also the input to {@link edgeWriteNeedsConstraintFence}, so "does this create
 * probe anything" and "what does it probe" are read from one place.
 *
 * A kind this graph does not define answers `many`. Choosing the fence must not
 * become the thing that REPORTS an unknown kind: the write path raises
 * `KindNotFoundError` from inside the hooked transaction, where a caller's
 * `onError` hook observes it, and this runs before that transaction opens.
 */
function edgeCardinality<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
): Cardinality {
  if (!hasOwnKey(ctx.graph.edges, kind)) return "many";
  return getEdgeRegistration(ctx.graph, kind).cardinality ?? "many";
}

/**
 * The convergence key a `getOrCreateByEndpoints` create leg must find ABSENT
 * inside its own fenced transaction before it inserts.
 *
 * `getOrCreateByEndpoints` promises at most one edge per match key, and no
 * database key backs that promise — the edges table is unique on
 * `(graph_id, id)` only, and the match key can include `matchOn` prop values.
 * The only way the promise survives two concurrent callers is for the lookup
 * that decides "create" and the INSERT it authorizes to happen under one
 * per-graph mutual exclusion, so the create leg re-runs the lookup here, inside
 * the fence, and returns the incumbent rather than inserting a duplicate.
 */
type EdgeConvergenceGuard = Readonly<{
  matchOn: readonly string[];
  props: Record<string, unknown>;
}>;

type EdgeCreateInternalResult =
  | Readonly<{ outcome: "created"; edge: Edge | undefined }>
  | Readonly<{ outcome: "found"; edge: Edge; row: BackendEdgeRow }>;

function createdEdgeResult(edge: Edge | undefined): EdgeCreateInternalResult {
  return { outcome: "created", edge };
}

function foundEdgeResult(row: BackendEdgeRow): EdgeCreateInternalResult {
  return { outcome: "found", edge: rowToEdge(row), row };
}

function edgeCreateDidWrite(result: EdgeCreateInternalResult): boolean {
  return result.outcome === "created";
}

/** A dispatcher-selected edge no longer carries the requested match key. */
class EdgeMatchKeyMoved extends Error {
  constructor(kind: string, id: string) {
    super(
      `The ${kind} edge "${id}" no longer has the requested match key; ` +
        "re-resolving it. This is internal and is never returned to a caller.",
    );
    this.name = "EdgeMatchKeyMoved";
  }
}

/**
 * Reads the transaction target's candidate rows. Both portable convergence
 * paths use this one lookup so they keep identical live-over-tombstone
 * selection.
 */
async function findConvergenceMatch(
  target: Pick<GraphReadBackend, "findEdgesByKind">,
  graphId: string,
  kind: string,
  input: Pick<CreateEdgeInput, "fromKind" | "fromId" | "toKind" | "toId">,
  convergeOn: EdgeConvergenceGuard,
): Promise<BackendEdgeRow | undefined> {
  const candidateRows = await target.findEdgesByKind({
    graphId,
    kind,
    fromKind: input.fromKind,
    fromId: input.fromId,
    toKind: input.toKind,
    toId: input.toId,
    excludeDeleted: false,
    temporalMode: "includeTombstones",
  });
  const { liveRow, deletedRow } = findMatchingEdge(
    candidateRows,
    convergeOn.matchOn,
    convergeOn.props,
  );
  const matchedRow = liveRow ?? deletedRow;
  return matchedRow;
}

/**
 * A durable direct create with the incumbent's explicit id is intentionally
 * omitted by the identity upsert's `DO UPDATE ... WHERE` clause. That keeps a
 * same-id incumbent distinguishable from a newly inserted row, but the
 * resulting empty RETURNING set is otherwise indistinguishable from a failed
 * endpoint predicate. Re-read the id only in that refusal case and preserve
 * the public durable-identity conflict contract (including tombstones).
 */
async function durableIdentityIdConflict(
  target: Pick<GraphReadBackend, "getEdge">,
  graphId: string,
  id: string,
  identity: Readonly<{ name: string; key: string }>,
  kind: string,
): Promise<EdgeMatchIdentityConflictError | undefined> {
  const row = await target.getEdge(graphId, id);
  if (
    row?.kind === kind &&
    row.match_identity_name === identity.name &&
    row.match_identity_key === identity.key
  ) {
    return new EdgeMatchIdentityConflictError({
      attempted: [{ id, identityName: identity.name, kind }],
    });
  }
  return undefined;
}

/**
 * Executes an edge create operation.
 */
async function executeEdgeCreateInternal<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    returnRow?: boolean;
    convergeOn?: EdgeConvergenceGuard;
    /** Batch callers deliberately skip per-item operation hooks. */
    skipHooks?: boolean;
  }>,
): Promise<EdgeCreateInternalResult> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const registration = getEdgeRegistration(ctx.graph, kind);
  // Refuse on the caller-visible backend before a write plan can replace it
  // with a transaction target whose capability declaration came from the
  // underlying adapter. A derived backend is allowed to narrow capabilities;
  // opening its delegated transaction must not silently widen them again.
  assertEdgeMatchIdentityBackendSupport(
    registration.matchIdentity,
    backend.capabilities,
    kind,
  );
  const opContext = ctx.createOperationContext("create", "edge", kind, id);
  const shouldReturnRow = options?.returnRow ?? true;
  const convergeOn = options?.convergeOn;
  const durableConvergence =
    convergeOn !== undefined && registration.matchIdentity !== undefined;
  const autocommitBackend =
    isBundledRootAutocommitEligible(backend) ? backend : undefined;
  const candidate =
    hasOwnKey(ctx.graph.edges, kind) ?
      ({
        backend,
        schemaVersion: ctx.schemaVersion,
        historyEnabled: ctx.historyEnabled,
        revisionTrackingEnabled: ctx.revisionTrackingEnabled,
        kindRegistered: true,
        convergesDynamically: convergeOn !== undefined && !durableConvergence,
        cardinality: edgeCardinality(ctx, kind),
      } as const)
    : undefined;
  const schemaFenceInFirstWrite =
    candidate !== undefined &&
    canFuseSchemaFenceInFirstWrite({ kind: "edge", candidate });
  const autocommitSingleStatement =
    autocommitBackend !== undefined &&
    candidate !== undefined &&
    isAutocommitSingleStatementWrite({ kind: "edge", candidate });
  const plan = edgeWritePlan(
    convergeOn === undefined || durableConvergence ?
      edgeWriteNeedsConstraintFence(edgeCardinality(ctx, kind))
    : "edgeMatchKeyConvergence",
  );

  const rowWork = async (
    session: EdgeWriteSession,
    target: WriteTarget,
    _overlaidSession: OverlaidSessionMint<"edge">,
    lock: GraphWriteLock,
    transactionMode: WriteTransactionMode,
  ): Promise<EdgeCreateInternalResult> => {
    // See node create's matching receiver check: a custom transaction
    // wrapper may replace the marked outer backend with an unmarked target.
    // Fall back to the ordinary fence before any row work in that case.
    const targetBackend = unfencedTarget(target);
    const fuseSchemaFenceInFirstWrite =
      schemaFenceInFirstWrite &&
      isSchemaFencedInsertEligible(targetBackend) &&
      !hasLeasedSchemaFence(ctx, targetBackend);
    if (schemaFenceInFirstWrite && !fuseSchemaFenceInFirstWrite) {
      await lockSchemaVersionForStoreWrite(ctx, targetBackend);
    }
    const diagnoseFusedCreateNoRow = async (
      validateCardinality: boolean,
    ): Promise<EdgeCreatePrepared> => {
      if (fuseSchemaFenceInFirstWrite) {
        await diagnoseFusedSchemaFenceNoRow(ctx, targetBackend);
        const directInteractiveAutocommit =
          autocommitSingleStatement &&
          transactionMode === "none" &&
          targetBackend.capabilities.transactions;
        if (directInteractiveAutocommit) {
          throw new AutocommitWriteRequiresTransaction();
        }
        if (transactionMode !== "none") {
          // Transaction-backed fallback probes need the portable schema fence;
          // the transaction already supplies atomicity.
          await lockSchemaVersionForStoreWrite(ctx, targetBackend);
        }
        const prepared = await validateAndPrepareEdgeCreate(
          ctx,
          input,
          id,
          target,
          { validateEndpoints: true, validateCardinality },
        );
        if (transactionMode === "none") {
          // A noninteractive root has no safe plain-write fallback. Probe
          // endpoints first for the typed missing-endpoint error, then fail
          // closed at the schema fence before any unfenced INSERT.
          await lockSchemaVersionForStoreWrite(ctx, targetBackend);
        }
        return prepared;
      }
      return validateAndPrepareEdgeCreate(ctx, input, id, target, {
        validateEndpoints: true,
        validateCardinality,
      });
    };

    const declaredCardinality = edgeCardinality(ctx, kind);
    const usesGuardedCardinalityClaim =
      declaredCardinality !== "many" &&
      edgeCardinalityClaimMode(target, ctx.claimsVerdict()).kind === "guarded";
    const usesFusedCardinalityInsert = usesGuardedCardinalityClaim;
    // A constrained convergence has to see an incumbent match before it
    // derives a cardinality refusal. Otherwise a stale root dispatcher turns a
    // matching winner into an avoidable failed create attempt, rather than the
    // promised `found` result. Guarded claims own their own refusal at the row
    // write; every other constrained create validates after the convergence
    // lookup has ruled out an incumbent match.
    const delaysCardinalityProbe =
      convergeOn !== undefined && !usesGuardedCardinalityClaim;
    // The convergence command (or its fallback) runs under this transaction's
    // graph fence. Once it reports no match, endpoint existence is the only
    // remaining pre-insert read, so let the existing endpoint-predicate INSERT
    // remove those two RTTs even though this create leg carries a convergence
    // guard.
    const canFuseEndpointCheck =
      declaredCardinality === "many" || usesGuardedCardinalityClaim;
    const durableIdentityArbitratedCreate =
      registration.matchIdentity !== undefined;
    let prepared = await validateAndPrepareEdgeCreate(ctx, input, id, target, {
      validateEndpoints: convergeOn === undefined && !canFuseEndpointCheck,
      validateCardinality:
        !durableIdentityArbitratedCreate &&
        !usesGuardedCardinalityClaim &&
        !delaysCardinalityProbe,
    });

    // A converging create owns both the match-key read and the endpoint
    // predicate in one semantic backend command. A matched row becomes the
    // explicit `found` result consumed by the hook/revision decision and the
    // outer convergence loop. No caller re-derives that decision, and no
    // expected found result travels through error hooks or a cache-backed root
    // re-read.
    //
    // Keep the old fenced lookup as an explicit fallback for dynamic matching
    // on a backend that does not implement this command yet. Durable identity
    // cannot take that fallback: its write plan delegates arbitration to the
    // database key and therefore owns no graph lock. A port that declares the
    // durable capability but refuses its command must fail closed instead of
    // racing a lookup with an uncoordinated insert.
    // A durable identity is the database's arbiter for every create shape,
    // including constrained kinds. Cardinality claims are a separate
    // application-owned axis; the graph fence already held by this plan
    // makes the probe and the durable command one serialized decision. Do not
    // skip the identity command merely because this row also owes a claim:
    // doing so lets a missing identity index turn a constrained create into a
    // successful duplicate.
    if (convergeOn !== undefined || durableIdentityArbitratedCreate) {
      if (
        durableIdentityArbitratedCreate &&
        convergeOn !== undefined &&
        declaredCardinality !== "many"
      ) {
        // A get-or-create that already has its endpoint/match winner must
        // resolve that winner before the cardinality probe: cardinality is a
        // create-only decision, and rejecting the found leg would regress
        // resurrection/found semantics. The graph fence makes this lookup and
        // the following durable command one serialized decision.
        const matchedRow = await findConvergenceMatch(
          target,
          ctx.graphId,
          kind,
          input,
          convergeOn,
        );
        if (matchedRow !== undefined) {
          return foundEdgeResult(matchedRow);
        }
        prepared = await validateAndPrepareEdgeCreate(ctx, input, id, target, {
          validateEndpoints: !canFuseEndpointCheck,
          validateCardinality: true,
        });
      }
      const work = edgeInsertWork(prepared);
      const durableMatchIdentity = work.params.matchIdentity;
      if (work.claim === undefined || durableMatchIdentity !== undefined) {
        const command: EdgeConvergeCreateCommand = {
          kind: "edge.converge-create",
          plan: {
            entity: "edge",
            params: work.params,
            ...(fuseSchemaFenceInFirstWrite ?
              {
                schemaFence: {
                  graphId: ctx.graphId,
                  expectedVersion: requireDefined(ctx.schemaVersion),
                },
              }
            : {}),
          },
          match:
            durableMatchIdentity === undefined ?
              { kind: "dynamic", ...requireDefined(convergeOn) }
            : { kind: "durable", identity: durableMatchIdentity },
        };
        const result =
          lock.coordination === undefined && command.match.kind === "dynamic" ?
            {
              outcome: "unsupported" as const,
              entity: "edge" as const,
              dimensions: ["convergence"] as const,
            }
          : await withAlreadyExistsTranslation("edge", () =>
              executeAuthoritativeGraphCommand(
                target.commands,
                command,
                lock.coordination ?? "none",
              ),
            );
        if (result.outcome === "created") {
          // Durable identity and cardinality are separate authorities. The
          // converge command owns the former; retain the latter's claim row
          // in the same transaction after the edge exists. If claiming
          // refuses, the surrounding write frame rolls the command back.
          if (durableMatchIdentity !== undefined && work.claim !== undefined) {
            await claimEdgeCardinality(target, ctx.claimsVerdict(), work.claim);
          }
          return createdEdgeResult(rowToEdge(result.row));
        }
        if (result.outcome === "found") {
          if (command.match.kind === "dynamic") {
            assertEdgeMatchKey(
              result.row,
              command.match.matchOn,
              command.match.props,
            );
          }
          if (convergeOn === undefined) {
            if (command.match.kind !== "durable") {
              throw new CompilerInvariantError(
                "A direct durable edge create constructed a dynamic convergence command.",
                { kind, id },
              );
            }
            throw new EdgeMatchIdentityConflictError({
              attempted: [
                {
                  id,
                  identityName: command.match.identity.name,
                  kind,
                },
              ],
            });
          }
          return foundEdgeResult(result.row);
        }
        if (result.outcome === "unsupported") {
          if (command.match.kind === "durable") {
            throw new ConfigurationError(
              "Backend declares durable edge match identity support but refuses the convergence command.",
              {
                code: "DURABLE_EDGE_MATCH_IDENTITY_COMMAND_UNSUPPORTED",
                capability: "durableEdgeMatchIdentity",
                graphId: ctx.graphId,
                edgeKind: kind,
              },
              {
                suggestion:
                  "Implement edge.converge-create atomically or declare durableEdgeMatchIdentity as unsupported.",
              },
            );
          }
          const matchedRow = await findConvergenceMatch(
            target,
            ctx.graphId,
            kind,
            input,
            requireDefined(convergeOn),
          );
          if (matchedRow !== undefined) {
            return foundEdgeResult(matchedRow);
          }
        }
        if (
          result.outcome === "rejected" &&
          command.match.kind === "durable" &&
          convergeOn === undefined
        ) {
          const identityConflict = await durableIdentityIdConflict(
            target,
            ctx.graphId,
            id,
            command.match.identity,
            kind,
          );
          if (identityConflict !== undefined) {
            // The same-id incumbent probe has already established the
            // durable-arbiter refusal. Preserve the established endpoint
            // validation ordering, but do not enter the fallback path: once
            // endpoints pass, the typed conflict is already authoritative.
            await diagnoseFusedSchemaFenceNoRow(ctx, targetBackend);
            await validateAndPrepareEdgeCreate(ctx, input, id, target, {
              validateEndpoints: true,
              validateCardinality: false,
            });
            throw identityConflict;
          }
        }
        // A rejected fused statement returned no row because an endpoint
        // predicate or schema fence did not hold. This is deliberately not a
        // create refusal by itself: the ordinary fused write/diagnostic path
        // below owns the typed errors and permits a concurrently revived
        // endpoint.
      } else if (convergeOn !== undefined) {
        // The current one-statement convergence builder does not own a
        // cardinality claim. Do the portable lookup before its cardinality
        // verdict instead of issuing a command known to return unsupported.
        const matchedRow = await findConvergenceMatch(
          target,
          ctx.graphId,
          kind,
          input,
          convergeOn,
        );
        if (matchedRow !== undefined) {
          return foundEdgeResult(matchedRow);
        }
      }

      if (delaysCardinalityProbe) {
        // Re-establish endpoint liveness on the portable path. When the next
        // row write can fuse that predicate, it remains in the INSERT instead.
        prepared = await validateAndPrepareEdgeCreate(ctx, input, id, target, {
          validateEndpoints: !canFuseEndpointCheck,
          validateCardinality: true,
        });
      }
    }

    // A plain, generated-id `many` edge owes no cardinality claim and no
    // sidecar. Its only pre-insert database reads were endpoint existence
    // probes, so first-party backends can make their live-node predicates
    // part of the INSERT ... SELECT itself. Do not infer an endpoint error
    // from an empty RETURNING result: retry the ordinary ordered validation
    // below, which preserves source-before-target typed refusals and handles
    // a concurrent endpoint revival before we report anything.
    if (canFuseEndpointCheck) {
      const fusedWork = edgeInsertWork(prepared);
      const fusedCommand: EdgeCreateCommand = {
        kind: "edge.create",
        plan: {
          entity: "edge",
          params: fusedWork.params,
          ...(fuseSchemaFenceInFirstWrite ?
            {
              schemaFence: {
                graphId: ctx.graphId,
                expectedVersion: requireDefined(ctx.schemaVersion),
              },
            }
          : {}),
          ...(usesFusedCardinalityInsert && fusedWork.claim !== undefined ?
            { cardinalityClaim: fusedWork.claim }
          : {}),
        },
      };
      const fusedResult = await withAlreadyExistsTranslation("edge", () =>
        session.createEdgeWithPlan(fusedCommand),
      );
      if (fusedResult.outcome === "created") {
        if (fuseSchemaFenceInFirstWrite) {
          memoizeLeasedSchemaFence(ctx, targetBackend);
        }
        return createdEdgeResult(rowToEdge(fusedResult.row));
      }

      // A fused refusal has no row, so the ordered fallback owns the full
      // portable cardinality diagnostic regardless of claim mode.
      prepared = await diagnoseFusedCreateNoRow(true);
    }

    // An edge create has no existence probe at all — its id is either
    // caller-supplied or freshly generated — so the engine's refusal is the ONLY
    // report that the id is taken. Translated here, that report is the same
    // already-exists error a node create raises. The translation spans the fused
    // unit — the claim and the row — which is inert for the claim half: a
    // contended claim raises a `CardinalityError`, never a duplicate-key insert
    // report.
    //
    // The claim is DECIDED here (a pure function of the cardinality this
    // preparation resolved) and ISSUED by the session, before the row it gates:
    // the probe above read a population no key fences, so the claim row is what
    // stops a concurrent writer that read the same population from also
    // committing, and a refusal there has written no edge row.
    const work = edgeInsertWork(prepared);
    const row = await withAlreadyExistsTranslation("edge", async () => {
      if (shouldReturnRow) return session.createEdge(work);
      await session.createEdgeNoReturn(work);
      return;
    });

    return createdEdgeResult(row === undefined ? undefined : rowToEdge(row));
  };

  if (autocommitSingleStatement) {
    return runAutocommitSingleStatementWritePlan(
      ctx,
      opContext,
      plan,
      autocommitBackend,
      rowWork,
      {
        schemaFenceInFirstWrite,
        didWrite: edgeCreateDidWrite,
      },
    );
  }
  if (options?.skipHooks === true) {
    return runWritePlan(ctx, plan, backend, rowWork, {
      schemaFenceInFirstWrite,
      didWrite: edgeCreateDidWrite,
    });
  }
  return runHookedWritePlan(ctx, opContext, plan, backend, rowWork, {
    schemaFenceInFirstWrite,
    didWrite: edgeCreateDidWrite,
  });
}

/**
 * Executes an edge create operation and returns the created edge.
 */
export async function executeEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const result = await executeEdgeCreateInternal(ctx, input, backend, {
    returnRow: true,
  });
  if (result.outcome !== "created") {
    throw new CompilerInvariantError(
      "A direct edge create unexpectedly returned a convergence incumbent.",
      { kind: input.kind, id: input.id },
    );
  }
  if (result.edge === undefined) {
    throw new DatabaseOperationError(
      "Edge create failed: expected created edge row",
      { operation: "insert", entity: "edge" },
    );
  }
  return result.edge;
}

/**
 * Executes an edge create operation without returning the created edge payload.
 */
export async function executeEdgeCreateNoReturn<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  await executeEdgeCreateInternal(ctx, input, backend, { returnRow: false });
}

/**
 * Batch-primes an edge batch's endpoint validation cache with one
 * `getNodes` round trip per distinct (kind) referenced across every
 * from/to endpoint in the batch, instead of a `getNode` probe per edge.
 * Mirrors `primeBatchValidationCaches`'s node-existence priming.
 */
async function primeEdgeBatchValidationCache<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: WriteTarget,
  seedEndpointRow: (
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ) => void,
): Promise<void> {
  const bound = bindExtraIfReachable(
    backend,
    ctx.batchPointRead.extras.getNodes,
    BATCH_POINT_READ.id,
  );
  if (bound === undefined) return;

  const idsByKind = new Map<string, Set<string>>();
  const addEndpoint = (kind: string, id: string): void => {
    const ids = idsByKind.get(kind) ?? new Set<string>();
    ids.add(id);
    idsByKind.set(kind, ids);
  };
  for (const input of inputs) {
    addEndpoint(input.fromKind, input.fromId);
    addEndpoint(input.toKind, input.toId);
  }

  for (const [kind, ids] of idsByKind) {
    const orderedIds = [...ids];
    const rows = await bound.getNodes(ctx.graphId, kind, orderedIds);
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (const id of orderedIds) {
      seedEndpointRow(ctx.graphId, kind, id, rowsById.get(id));
    }
  }
}

/**
 * Shared batch preparation for edge creates: primes the endpoint
 * validation cache with one `getNodes` call per referenced kind, then
 * validates every input against the primed cache in order (so later
 * inputs see earlier ones' pending cardinality/uniqueness registrations).
 * Shared between the non-returning and RETURNING batch paths so both get
 * the same batched-prefetch treatment.
 */
async function prepareEdgeBatchCreates<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: WriteTarget,
): Promise<{
  preparedCreates: EdgeCreatePrepared[];
  batchInsertWork: EdgeInsertWork[];
}> {
  const {
    backend: validationBackend,
    registerPendingEdgeForCardinality,
    seedEndpointRow,
  } = createEdgeBatchValidationBackend(backend);

  await primeEdgeBatchValidationCache(ctx, inputs, backend, seedEndpointRow);

  const preparedCreates: EdgeCreatePrepared[] = [];
  for (const input of inputs) {
    const id = input.id ?? generateId();
    const prepared = await validateAndPrepareEdgeCreate(
      ctx,
      input,
      id,
      validationBackend,
    );
    preparedCreates.push(prepared);
    registerPendingEdgeForCardinality(
      prepared.insertParams,
      prepared.cardinality,
    );
  }

  // The batch's insert UNITS: each row's params paired with the claim it owes.
  // The session issues ONE sorted claim statement for the group — after this
  // preparation loop, never inside it, so no claim is taken for a row the loop
  // may still refuse, and every batch takes its claim row locks in
  // `compareClaimTargets` order rather than input order.
  const batchInsertWork = preparedCreates.map((prepared) =>
    edgeInsertWork(prepared),
  );

  return { preparedCreates, batchInsertWork };
}

/** Identity-conflicted rows are omitted by the authoritative batch RETURNING. */
function assertDurableBatchRows(
  work: readonly EdgeInsertWork[],
  rows: readonly BackendEdgeRow[],
): void {
  const outcomes = classifyDurableEdgeBatchOutcomes(
    work.map((item) => item.params),
    rows,
  );
  const attempted = work.flatMap((item, index) => {
    if (requireDefined(outcomes[index]) === "conflict") {
      return [
        {
          id: item.params.id,
          identityName: requireDefined(item.params.matchIdentity).name,
          kind: item.params.kind,
        },
      ];
    }
    return [];
  });
  if (attempted.length > 0) {
    throw new EdgeMatchIdentityConflictError({ attempted });
  }
}

/**
 * Executes batched edge creates without returning inserted edge payloads.
 *
 * Note: `withOperationHooks` is intentionally skipped for batch throughput.
 * Per-item hooks would negate the performance benefit of batching.
 */
export async function executeEdgeCreateNoReturnBatch<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  await runWritePlan(
    ctx,
    edgeWritePlan(batchFencesConstraintProbe(ctx, inputs)),
    backend,
    async (session, target) => {
      const { batchInsertWork } = await prepareEdgeBatchCreates(
        ctx,
        inputs,
        target,
      );
      const durableWork = batchInsertWork.filter(
        (item) => item.params.matchIdentity !== undefined,
      );
      if (durableWork.length > 0) {
        if (
          durableWork.length !== batchInsertWork.length ||
          target.insertEdgesDurableBatchReturning === undefined
        ) {
          for (const input of inputs) {
            await executeEdgeCreateInternal(
              ctx,
              input,
              nestedManagedWriteTarget(target),
              {
                returnRow: false,
                skipHooks: true,
              },
            );
          }
          return;
        }
        const rows = await withAlreadyExistsTranslation("edge", () =>
          requireDefined(session.createEdgesDurable)(batchInsertWork),
        );
        assertDurableBatchRows(batchInsertWork, rows);
        return;
      }
      await withAlreadyExistsTranslation("edge", () =>
        session.createEdgesNoReturn(batchInsertWork),
      );
    },
  );
}

/**
 * Executes batched edge creates and returns the inserted edge payloads.
 *
 * Uses batch validation caching and a single multi-row INSERT with RETURNING
 * when the backend supports it. Falls back to sequential inserts otherwise.
 *
 * Note: `withOperationHooks` is intentionally skipped for batch throughput.
 * Per-item hooks would negate the performance benefit of batching.
 */
export async function executeEdgeCreateBatch<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
  backend: GraphBackend | TransactionBackend,
): Promise<readonly Edge[]> {
  if (inputs.length === 0) {
    return [];
  }
  return runWritePlan(
    ctx,
    edgeWritePlan(batchFencesConstraintProbe(ctx, inputs)),
    backend,
    async (session, target) => {
      const { batchInsertWork } = await prepareEdgeBatchCreates(
        ctx,
        inputs,
        target,
      );

      const durableWork = batchInsertWork.filter(
        (item) => item.params.matchIdentity !== undefined,
      );
      if (durableWork.length > 0) {
        if (
          durableWork.length !== batchInsertWork.length ||
          target.insertEdgesDurableBatchReturning === undefined
        ) {
          const fallbackRows: Edge[] = [];
          for (const input of inputs) {
            const result = await executeEdgeCreateInternal(
              ctx,
              input,
              nestedManagedWriteTarget(target),
              { returnRow: true, skipHooks: true },
            );
            if (result.outcome !== "created") {
              throw new CompilerInvariantError(
                "A bulk direct edge create unexpectedly returned a convergence incumbent.",
                { kind: input.kind, id: input.id },
              );
            }
            if (result.edge === undefined) {
              throw new DatabaseOperationError(
                "Edge create failed: expected created edge row",
                { operation: "insert", entity: "edge" },
              );
            }
            fallbackRows.push(result.edge);
          }
          return fallbackRows;
        }
        const rows = await withAlreadyExistsTranslation("edge", () =>
          requireDefined(session.createEdgesDurable)(batchInsertWork),
        );
        assertDurableBatchRows(batchInsertWork, rows);
        return rows.map((row) => rowToEdge(row));
      }

      const rows = await withAlreadyExistsTranslation("edge", () =>
        session.createEdges(batchInsertWork),
      );

      return rows.map((row) => rowToEdge(row));
    },
  );
}

/**
 * A batch fences when ANY item in it does: the batch shares one transaction, so
 * one constrained item makes the whole transaction a constrained write. A batch
 * of purely `many` edges still takes no lock.
 */
function batchFencesConstraintProbe<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  inputs: readonly CreateEdgeInput[],
): ConstraintFenceReason | undefined {
  for (const input of inputs) {
    const reason = edgeWriteNeedsConstraintFence(
      edgeCardinality(ctx, input.kind),
    );
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * The exact props an edge update would persist: the caller's partial input
 * merged over the current props and run through the edge kind's Zod schema.
 * Operates on PARSED props so the write path and the coalesce dirty-check
 * (which may compare against a batch-local running value, never a row) share
 * one validation. Endpoints are the edge's identity and are not part of an
 * upsert-by-id update, so only props are involved.
 */
function computeEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const registration = getEdgeRegistration(ctx.graph, kind);
  const validatedProps = validateEdgeProps(
    registration.type.schema,
    { ...existingProps, ...inputProps },
    { kind, operation: "update", id },
  );
  const identityRefusal = edgeMatchIdentityUpdateRefusal({
    identity: registration.matchIdentity,
    kind,
    id,
    beforeProps: existingProps,
    afterProps: validatedProps,
  });
  if (identityRefusal !== undefined) throw identityRefusal;
  return validatedProps;
}

/**
 * Row-based wrapper over {@link computeEdgeUpdate} for the write path.
 */
function resolveEdgeUpdateProps<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  existing: Pick<EdgeRow, "kind" | "id" | "props">,
  inputProps: Partial<Record<string, unknown>>,
): Readonly<{
  existingProps: Record<string, unknown>;
  validatedProps: Record<string, unknown>;
}> {
  const existingProps = rowPropsToObject(existing.props);
  const validatedProps = computeEdgeUpdate(
    ctx,
    existing.kind,
    existing.id,
    existingProps,
    inputProps,
  );
  return { existingProps, validatedProps };
}

/**
 * The edge coalesce dirty-check: returns the props an upsert would persist and
 * whether they equal `existingProps`. `existingProps` is the PARSED current
 * props — the edge's, or the batch-local running value for a repeated id.
 */
export function edgeUpsertDirtyCheck<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  id: string,
  existingProps: Record<string, unknown>,
  inputProps: Record<string, unknown>,
): UpsertDirtyCheck {
  const validatedProps = computeEdgeUpdate(
    ctx,
    kind,
    id,
    existingProps,
    inputProps,
  );
  return {
    validatedProps,
    unchanged: canonicalEqual(validatedProps, existingProps),
  };
}

/**
 * Shared edge-update body: re-reads the edge inside the transaction, merges
 * and validates props, and writes. A plain update requires a live edge; a
 * resurrecting upsert (`clearDeleted`) may target a tombstoned one.
 */
async function performEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: UpsertUpdateEdgeInput,
  session: EdgeWriteSession,
  target: WriteTarget,
  options?: Readonly<{
    clearDeleted?: boolean;
    matchOn?: readonly string[];
    matchProps?: Record<string, unknown>;
  }>,
): Promise<Edge> {
  const id = input.id;

  assertValidityEndMutation(input, {
    entityType: "edge",
    kind: input.identity.kind,
    id,
  });

  const existing = await target.getEdge(ctx.graphId, id);
  if (!existing || (!options?.clearDeleted && existing.deleted_at)) {
    throw new EdgeNotFoundError(input.identity.kind, id);
  }
  assertEdgeIdentityMatches(
    id,
    input.identity,
    edgeIdentityFromRow(existing),
    "update",
  );
  if (options?.matchOn !== undefined && options.matchProps !== undefined) {
    assertEdgeMatchKey(existing, options.matchOn, options.matchProps);
  }

  const { validatedProps } = resolveEdgeUpdateProps(ctx, existing, input.props);

  const statedValidFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const preservesLiveLowerBound =
    options?.clearDeleted !== true &&
    preservesImmutableLowerBound(input.onImmutableLowerBound);
  const appliedValidFrom =
    preservesLiveLowerBound ? undefined : statedValidFrom;
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  const effectiveValidTo =
    options?.clearDeleted === true && appliedValidFrom !== undefined ?
      validTo
    : validityEndAfterMutation(
        input.clearValidTo === true ? { clearValidTo: true }
        : validTo === undefined ? {}
        : { validTo },
        existing.valid_to,
      );
  const cardinality = edgeCardinality(ctx, input.identity.kind);
  const reentersLivePopulation =
    options?.clearDeleted === true && existing.deleted_at !== undefined;
  // `let` earns its place: the claim is decided inside the re-entry branch and
  // consumed by the work record built after it, and there is no expression form
  // that keeps the branch's two other statements (probe, then decide) together.
  let reentryClaim: ClaimEdgeCardinalityParams | undefined;
  const reentersActivePopulation =
    cardinality === "oneActive" &&
    effectiveValidTo === undefined &&
    (existing.deleted_at !== undefined || existing.valid_to !== undefined);
  if (reentersLivePopulation || reentersActivePopulation) {
    await checkCardinalityConstraint(
      {
        graphId: ctx.graphId,
        registry: ctx.registry,
        backend: target,
      },
      input.identity.kind,
      cardinality,
      existing.from_kind,
      existing.from_id,
      existing.to_kind,
      existing.to_id,
      effectiveValidTo,
    );
    // Re-entry re-admits this edge to the population its cardinality
    // constrains, so it claims the axis exactly as a create does — BEFORE the
    // update that re-admits it, because the probe above read a population no key
    // fences. Both legs claim: a resurrect (`clearDeleted`) and a reopened
    // `oneActive` window (#469) put the same row back into the same counted
    // population, and a fence that covered only the first would leave the second
    // unfenced. Decided here, ISSUED by the step that owns the row write, so the
    // pair cannot be separated.
    reentryClaim = edgeCardinalityClaim(cardinality, {
      graphId: ctx.graphId,
      id,
      kind: input.identity.kind,
      fromKind: existing.from_kind,
      fromId: existing.from_id,
      toKind: existing.to_kind,
      toId: existing.to_id,
      ...(effectiveValidTo === undefined ? {} : { validTo: effectiveValidTo }),
    });
  }
  // The row's stored lower bound is the effective one on EVERY edge update,
  // in-place or resurrecting: an edge RETAINS `valid_from` unless the
  // resurrection names a new one (see UpdateEdgeParams), so a lone `validTo`
  // is always measured against the bound the row already carries. This is the
  // ordering hole the edge write path used to have; nodes have always been
  // checked here, and the two now agree.
  //
  // Resurrecting an edge straight into the ENDED state stays available — that is
  // what `getOrCreateByEndpoints` does to an ended employment, counting it
  // against cardinality as inactive — but the end it names must not precede the
  // window it is ending. Reviving a row into a window that closed before the row
  // began means restating the start, so pass `validFrom` alongside `validTo`.
  //
  // A stated `validFrom` is STORED only on the resurrecting leg, which
  // `buildUpdateEdge` selects on `clearDeleted` ALONE — its UPDATE carries no
  // `deleted_at` predicate, so the leg is taken (and the bound applied) even
  // where a concurrent writer revived the row between the caller's probe and
  // this re-read. A plain in-place update stores no lower bound at all, so one
  // that differs from the bound the row holds is refused rather than accepted
  // and dropped.
  const windowVerdict = assertWritableValidityWindow(
    `edge "${id}"`,
    appliedValidFrom,
    {
      effectiveValidFrom: existing.valid_from,
      appliesStatedValidFrom: options?.clearDeleted === true,
      // Unlike the node side, an edge RETAINS `valid_from` through a
      // resurrection that does not name a new one, so the effective bound is the
      // row's stored one on BOTH legs and there is no carve-out to make.
      effectiveBoundIsStored: true,
    },
    validTo,
  );

  // The write's FENCES: everything the statement asserts because a verdict
  // above READ it, separated from the props this update intends to change.
  //
  // `kind` makes the UPDATE self-verifying: the re-read above computed the
  // merged props and the effective window, and the same predicate that
  // validated its identity is carried into the statement, so the row this
  // writes is provably the row that was judged.
  //
  // Every component `input.identity` ASSERTS is carried, not just kind: an
  // upsert that resolved this edge by its endpoints asserted them, and a
  // same-kind recreate with different endpoints would satisfy a kind-only
  // predicate. The expectation object is the single source for both the
  // pre-write check and the statement, so the two cannot assert different
  // things.
  //
  // The lower bound is carried on exactly the same terms: present only when
  // the verdict consulted it, because a component the caller made no claim
  // about must not become a predicate that refuses legitimate writes. The
  // window END follows the same rule: only a reopen that judged the row's
  // stored `valid_to` asserts it.
  const fences: EdgeUpdateFences = {
    validityLowerBound: windowVerdict.storedLowerBoundFence,
    validityUpperBound:
      reentersActivePopulation && existing.valid_to !== undefined ?
        { expectedValidTo: existing.valid_to }
      : {},
    edgeIdentity: input.identity,
  };

  // `appliedValidFrom` reaches the backend only through a resurrecting write
  // (see UpdateEdgeParams): a live edge's lower bound is history and stays put.
  const work: EdgeUpdateWork = {
    id,
    props: validatedProps,
    ...(appliedValidFrom !== undefined && { validFrom: appliedValidFrom }),
    // `validTo` and `clearValidTo` are mutually exclusive in the params, so the
    // work states exactly one of them.
    ...(input.clearValidTo === true ? { clearValidTo: true as const }
    : validTo === undefined ? {}
    : { validTo }),
    ...(options?.clearDeleted === true && { clearDeleted: true }),
    ...(reentryClaim === undefined ? {} : { claim: reentryClaim }),
  };

  const row = await withUnmatchedEdgeUpdateRefusal(
    ctx.graphId,
    target,
    id,
    input.identity,
    // "Did this write assert any window state?" is one predicate with one
    // owner, consulted here and by the fence appliers that carry it, rather
    // than re-derived from the params the diagnosis never sees.
    assertsStoredWindowState(fences),
    () => session.reviseEdge(work, fences),
  );

  return rowToEdge(row);
}

/**
 * How many probe-and-write rounds an edge update gets before it stops trying to
 * converge. See {@link NODE_UPDATE_ATTEMPTS}' counterpart reasoning: one retry
 * absorbs a single concurrent recreate, and the bound stops a peer that keeps
 * replacing the row from livelocking this writer.
 */
const EDGE_UPDATE_ATTEMPTS = 2;

/**
 * Runs {@link performEdgeUpdate} and CONVERGES on the row that is actually
 * there when the asserted validity bound stopped matching.
 *
 * The retry re-reads, re-merges the caller's partial props over the CURRENT
 * props, and re-judges the window against the CURRENT bound — so a stated
 * window that no longer fits is refused with the same typed `ValidationError`
 * the first attempt would have raised, and one that still fits is applied to
 * the row that really exists. Refusing instead would make the fence a behavior
 * regression for every writer that loses a benign race.
 *
 * Only the bound-mismatch case retries. A vanished row, a tombstoned row, and
 * an id that now resolves to a different edge are all terminal verdicts that
 * {@link withUnmatchedEdgeUpdateRefusal} has already turned into the typed
 * errors this operation has always thrown.
 */
async function performEdgeUpdateConverging<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: UpsertUpdateEdgeInput,
  session: EdgeWriteSession,
  target: WriteTarget,
  options?: Readonly<{
    clearDeleted?: boolean;
    matchOn?: readonly string[];
    matchProps?: Record<string, unknown>;
  }>,
): Promise<Edge> {
  for (let attempt = 1; attempt <= EDGE_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      return await performEdgeUpdate(ctx, input, session, target, options);
    } catch (error) {
      if (!(error instanceof EdgeUpdateTargetMoved)) throw error;
      if (attempt === EDGE_UPDATE_ATTEMPTS) {
        throw new DatabaseOperationError(
          `Edge update for "${input.id}" could not be applied to a stable row after ${EDGE_UPDATE_ATTEMPTS} attempts: the row was replaced between each read and its write. A concurrent writer is replacing this edge faster than it can be read; serialize the writers, or retry.`,
          { operation: "update", entity: "edge" },
          { cause: error },
        );
      }
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new EdgeNotFoundError(input.identity.kind, input.id);
}

/**
 * Executes an edge update operation.
 */
export async function executeEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: {
    id: string;
    identity: EdgeIdentityExpectation;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
    clearValidTo?: true;
  },
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const id = input.id;

  // Read outside the transaction: the hook context needs the edge kind, and
  // hooks must WRAP the transaction (matching node operations and edge
  // create) so onOperationEnd reports success only after COMMIT — a hook
  // that fires inside the transaction would report success for a write that
  // a failed commit then rolls back. An absent edge also never opens an empty
  // transaction. The body re-reads inside the transaction, so a concurrent
  // delete between this gate and the write lock is still handled correctly.
  const gate = await backend.getEdge(ctx.graphId, id);
  if (!gate || gate.deleted_at) {
    throw new EdgeNotFoundError(input.identity.kind, id);
  }
  assertEdgeIdentityMatches(
    id,
    input.identity,
    edgeIdentityFromRow(gate),
    "update",
  );

  const opContext = ctx.createOperationContext("update", "edge", gate.kind, id);

  if (input.clearValidTo === true) {
    assertClearValidToSupported(backend, "edge");
  }
  return runHookedWritePlan(
    ctx,
    opContext,
    // An in-place props update on a live edge re-derives no constraint verdict.
    // Clearing an `oneActive` edge's end DOES: it re-admits the row to the
    // counted active population.
    edgeWritePlan(
      (
        input.clearValidTo === true &&
          edgeCardinality(ctx, gate.kind) === "oneActive"
      ) ?
        edgeWriteNeedsConstraintFence("oneActive")
      : undefined,
    ),
    backend,
    (session, target) =>
      performEdgeUpdateConverging(ctx, input, session, target),
    { didWrite: writeResultAlwaysChanges },
  );
}

type EdgeUpsertUpdateOutcome = Readonly<{
  edge: Edge;
  wrote: boolean;
}>;

/**
 * Executes the endpoint-aware edge upsert update and reports whether it wrote.
 *
 * The ordinary id-upsert callers need only the edge, while endpoint
 * get-or-create also owes callers an honest action (`found` when an identical
 * replay was coalesced, `updated` only when an UPDATE ran). Keeping the verdict
 * here makes the dirty-check read and the write it may elide share the same
 * transaction and graph-write fence.
 */
async function executeEdgeUpsertUpdateWithOutcome<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: UpsertUpdateEdgeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    clearDeleted?: boolean;
    coalesceUnchanged?: boolean;
    coalesceCandidate?: BackendEdgeRow;
    matchOn?: readonly string[];
    matchProps?: Record<string, unknown>;
  }>,
): Promise<EdgeUpsertUpdateOutcome> {
  if (input.clearValidTo === true) {
    assertClearValidToSupported(backend, "edge");
  }
  return runWritePlan(
    ctx,
    // An in-place props update re-derives no constraint verdict: endpoints
    // are immutable, so cardinality cannot change under it. A coalescing upsert
    // converges on a match key no database key backs; a resurrect or a cleared
    // end re-admits the row to the counted population its cardinality
    // constrains.
    edgeWritePlan(
      options?.coalesceUnchanged === true ? "edgeMatchKeyConvergence"
      : input.clearValidTo === true || options?.clearDeleted === true ?
        edgeWriteNeedsConstraintFence(edgeCardinality(ctx, input.identity.kind))
      : undefined,
    ),
    backend,
    async (session, target) => {
      if (options?.coalesceUnchanged === true && !options.clearDeleted) {
        const existing =
          options.matchOn !== undefined && options.matchProps !== undefined ?
            await target.getEdge(ctx.graphId, input.id)
          : (options.coalesceCandidate ??
            (await target.getEdge(ctx.graphId, input.id)));
        if (existing !== undefined && existing.deleted_at === undefined) {
          assertEdgeIdentityMatches(
            input.id,
            input.identity,
            edgeIdentityFromRow(existing),
            "update",
          );
          if (
            options.matchOn !== undefined &&
            options.matchProps !== undefined
          ) {
            assertEdgeMatchKey(existing, options.matchOn, options.matchProps);
          }
          const runDirtyCheck = () =>
            edgeUpsertDirtyCheck(
              ctx,
              existing.kind,
              existing.id,
              rowPropsToObject(existing.props),
              input.props,
            );
          if (shouldCoalesceUpsert(existing, input, runDirtyCheck)) {
            return { edge: rowToEdge(existing), wrote: false };
          }
        }
      }

      const edge = await performEdgeUpdateConverging(
        ctx,
        input,
        session,
        target,
        options,
      );
      return { edge, wrote: true };
    },
    {
      didWrite: (outcome) => outcome.wrote,
    },
  );
}

/**
 * Executes an edge update for upsert — bypasses the soft-delete check
 * and optionally clears `deleted_at`.
 */
export async function executeEdgeUpsertUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: UpsertUpdateEdgeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    clearDeleted?: boolean;
    matchOn?: readonly string[];
    matchProps?: Record<string, unknown>;
  }>,
): Promise<Edge> {
  const outcome = await executeEdgeUpsertUpdateWithOutcome(
    ctx,
    input,
    backend,
    options,
  );
  return outcome.edge;
}

/**
 * Executes an edge delete operation.
 */
export async function executeEdgeDelete<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  expectedKind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  // Gate outside the transaction so an absent/tombstoned edge never opens an
  // empty one; the gate row also supplies the kind for the hook context,
  // because hooks must WRAP the transaction (matching node operations and
  // edge create) so onOperationEnd reports success only after COMMIT.
  const gate = await backend.getEdge(ctx.graphId, id);
  if (!gate) return;
  assertEdgeIdentityMatches(
    id,
    { kind: expectedKind },
    edgeIdentityFromRow(gate),
    "delete",
  );
  if (gate.deleted_at) return;

  const opContext = ctx.createOperationContext("delete", "edge", gate.kind, id);

  return runHookedWritePlan(
    ctx,
    opContext,
    // A soft delete decides nothing a concurrent write could invalidate.
    edgeWritePlan(undefined),
    backend,
    async (session) => {
      // No in-transaction re-read: the statement carries the expected kind and
      // `deleted_at IS NULL`, so it is its own recheck. A concurrent writer that
      // tombstones this edge, or hard-deletes it and recreates the id under
      // another kind, leaves the DELETE matching zero rows — the same no-op the
      // re-read produced, one round trip cheaper and without the window between
      // a lock-free `getEdge` and a `(graph_id, id)`-keyed write that PostgreSQL
      // READ COMMITTED left open.
      await session.retireEdge({ id, kind: expectedKind });
    },
  );
}

/**
 * Soft-deletes a batch without per-item operation hooks.
 *
 * The edge kind is checked from the authoritative row inside the transaction;
 * accepting an ID owned by another collection would violate collection
 * isolation even though edge IDs are graph-global.
 */
export async function executeEdgeDeleteBatch<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  expectedKind: string,
  ids: readonly string[],
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  await runWritePlan(
    ctx,
    edgeWritePlan(undefined),
    backend,
    async (session, target) => {
      let affectedCount = 0;
      for (const id of ids) {
        const current = await target.getEdge(ctx.graphId, id);
        if (!current) continue;
        assertEdgeIdentityMatches(
          id,
          { kind: expectedKind },
          edgeIdentityFromRow(current),
          "delete",
        );
        if (current.deleted_at) continue;
        // The read above is this path's identity GATE (a batch has none
        // outside the transaction), so it stays; the statement still carries
        // the expected kind so the row it tombstones is the row that was
        // judged.
        await session.retireEdge({ id, kind: expectedKind });
        affectedCount += 1;
      }
      return affectedCount;
    },
    { didWrite: (affectedCount) => affectedCount > 0 },
  );
}

/**
 * Executes an edge hard delete operation (permanent removal).
 *
 * Unlike soft delete, this permanently removes the edge from the database.
 */
export async function executeEdgeHardDelete<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  expectedKind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  // Gate outside the transaction so an absent edge never opens an empty one;
  // hooks wrap the transaction (see executeEdgeDelete).
  const gate = await backend.getEdge(ctx.graphId, id);
  if (!gate) return;
  assertEdgeIdentityMatches(
    id,
    { kind: expectedKind },
    edgeIdentityFromRow(gate),
    "hardDelete",
  );

  const opContext = ctx.createOperationContext("delete", "edge", gate.kind, id);

  return runHookedWritePlan(
    ctx,
    opContext,
    edgeWritePlan(undefined),
    backend,
    async (session) => {
      // No in-transaction re-read: see executeEdgeDelete. The DELETE carries the
      // expected kind, so an id concurrently re-pointed at another kind's edge
      // matches zero rows instead of destroying that other edge.
      await session.purgeEdge({
        id,
        kind: expectedKind,
        // Housekeeping, not a fence: this edge's claim is already takeable — its
        // liveness predicate reads a row that no longer exists — so dropping the
        // row only keeps the relation from growing by one row per hard-deleted
        // constrained edge. An unconstrained kind holds no claim and pays no
        // statement for one, the same rule its create follows.
        holdsCardinalityClaim: edgeCardinality(ctx, expectedKind) !== "many",
      });
    },
  );
}

// ============================================================
// Get-Or-Create Operations
// ============================================================

/**
 * Validates that all `matchOn` fields exist in the edge schema shape.
 * Throws a ValidationError for invalid fields.
 */
function validateMatchOnFields(
  schema: { shape?: Record<string, unknown> },
  matchOn: readonly string[],
  edgeKind: string,
): void {
  if (matchOn.length === 0) return;
  const shape = schema.shape;
  if (shape === undefined) {
    throw new ValidationError(
      `Edge kind "${edgeKind}" has no schema shape to validate matchOn fields against`,
      {
        kind: edgeKind,
        operation: "create",
        issues: matchOn.map((field) => ({
          path: field,
          message: `Field "${field}" does not exist in edge schema`,
        })),
      },
    );
  }

  const invalidFields = matchOn.filter((field) => !hasOwnKey(shape, field));
  if (invalidFields.length > 0) {
    throw new ValidationError(
      `Invalid matchOn fields for edge kind "${edgeKind}": ${invalidFields.join(", ")}`,
      {
        kind: edgeKind,
        operation: "create",
        issues: invalidFields.map((field) => ({
          path: field,
          message: `Field "${field}" does not exist in edge schema`,
        })),
      },
    );
  }
}

/** Resolves the one match-field set an edge kind is allowed to converge on. */
function resolveEdgeMatchFields(
  edgeKind: string,
  declared: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (declared === undefined) return requested ?? [];
  if (requested === undefined) return declared;
  const canonicalRequested = [...requested].toSorted();
  if (
    canonicalRequested.length === declared.length &&
    canonicalRequested.every((field, index) => field === declared[index])
  ) {
    return declared;
  }
  throw new ConfigurationError(
    `Edge kind "${edgeKind}" declares match identity fields [${declared.join(", ")}], but getOrCreateByEndpoints requested [${canonicalRequested.join(", ")}].`,
    { edgeKind, declared, requested: canonicalRequested },
  );
}

/**
 * Endpoint-only key for grouping findEdgesByKind queries.
 */
function buildEndpointPairKey(
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
): string {
  return encodeTupleKey([fromKind, fromId, toKind, toId]);
}

type EdgeMatch = Readonly<{
  liveRow: BackendEdgeRow | undefined;
  deletedRow: BackendEdgeRow | undefined;
}>;

/**
 * Finds the best matching edge from candidate rows.
 * Partitions into live vs deleted; prefers live.
 */
function findMatchingEdge(
  rows: readonly BackendEdgeRow[],
  matchOn: readonly string[],
  inputProps: Record<string, unknown>,
): EdgeMatch {
  let liveRow: BackendEdgeRow | undefined;
  let deletedRow: BackendEdgeRow | undefined;

  for (const row of rows) {
    if (matchOn.length > 0) {
      const rowProps = rowPropsToObject(row.props);
      const matches = matchOn.every(
        (field) =>
          canonicalPersistedJsonValue(readOwnProperty(rowProps, field)) ===
          canonicalPersistedJsonValue(readOwnProperty(inputProps, field)),
      );
      if (!matches) continue;
    }

    if (row.deleted_at === undefined) {
      liveRow ??= row;
    } else {
      deletedRow ??= row;
    }

    if (liveRow !== undefined) break;
  }

  return { liveRow, deletedRow };
}

/** Rechecks a dispatcher-selected row against the authoritative match key. */
function assertEdgeMatchKey(
  row: BackendEdgeRow,
  matchOn: readonly string[],
  matchProps: Record<string, unknown>,
): void {
  const match = findMatchingEdge([row], matchOn, matchProps);
  if (match.liveRow === undefined && match.deletedRow === undefined) {
    throw new EdgeMatchKeyMoved(row.kind, row.id);
  }
}

/**
 * Executes a single findByEndpoints operation.
 *
 * Looks up an edge by endpoints and optional matchOn fields, honoring the
 * temporal coordinate in `options` (mode / asOf / excludeDeleted) the same way
 * `findFrom` / `findTo` do. Returns the matching edge, or undefined. By default
 * soft-deleted and out-of-window edges are excluded; under `includeTombstones`
 * (excludeDeleted = false) a soft-deleted edge can be returned.
 */
export async function executeEdgeFindByEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  backend: GraphReadBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    props?: Record<string, unknown>;
    excludeDeleted?: boolean;
    temporalMode?: TemporalMode;
    asOf?: string;
  }>,
): Promise<Edge | undefined> {
  const matchOn = options?.matchOn ?? [];
  const matchProps = normalizePersistedEdgeMatchProps(options?.props ?? {});

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  if (matchOn.length > 0) {
    validateMatchOnFields(edgeKind.schema, matchOn, kind);
  }

  const candidateRows = await backend.findEdgesByKind({
    graphId: ctx.graphId,
    kind,
    fromKind,
    fromId,
    toKind,
    toId,
    excludeDeleted: options?.excludeDeleted ?? true,
    ...(options?.temporalMode !== undefined && {
      temporalMode: options.temporalMode,
    }),
    ...(options?.asOf !== undefined && { asOf: options.asOf }),
  });

  if (candidateRows.length === 0) return undefined;

  if (matchOn.length === 0) return rowToEdge(requireDefined(candidateRows[0]));

  const { liveRow } = findMatchingEdge(candidateRows, matchOn, matchProps);
  return liveRow === undefined ? undefined : rowToEdge(liveRow);
}

function defersEndpointWindowOrdering(
  ifExists: IfExistsMode,
  onImmutableLowerBound: "preserve" | "refuse" | undefined,
): boolean {
  return (
    ifExists === "update" && preservesImmutableLowerBound(onImmutableLowerBound)
  );
}

/** Refuses a clear request on the endpoint mode whose matched-row contract is read-only. */
function assertEndpointClearCanApply(
  ifExists: IfExistsMode,
  clearValidTo: true | undefined,
  kind: string,
): void {
  if (ifExists !== "return" || clearValidTo !== true) return;
  throw new ConfigurationError(
    `clearValidTo requires ifExists: "update" for getOrCreateByEndpoints on edge kind "${kind}"; ifExists: "return" never mutates a matching edge.`,
    {
      code: "CLEAR_VALID_TO_REQUIRES_UPDATE",
      kind,
      ifExists,
    },
  );
}

/**
 * Executes a single getOrCreateByEndpoints operation.
 */
export async function executeEdgeGetOrCreateByEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  props: Record<string, unknown>,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    ifExists?: IfExistsMode;
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "preserve" | "refuse";
  }>,
): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>> {
  const ifExists = options?.ifExists ?? "return";

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;
  const matchOn = resolveEdgeMatchFields(
    kind,
    registration.matchIdentity?.fields,
    options?.matchOn,
  );

  assertValidityEndMutation(options ?? {}, { entityType: "edge", kind });
  if (options?.clearValidTo === true) {
    assertClearValidToSupported(backend, "edge");
  }

  // Validate props
  const validatedProps = validateEdgeProps(edgeKind.schema, props, {
    kind,
    operation: "create",
  });
  const matchProps = normalizePersistedEdgeMatchProps(validatedProps);

  // Validate matchOn fields
  validateMatchOnFields(edgeKind.schema, matchOn, kind);

  // Canonical form is validated before the read probe so malformed input is
  // always refused. Strict writes and return-mode calls also judge the stated
  // pair here. A preserve-mode update defers ordering until its write leg has
  // resolved whether it will create/resurrect (and apply the stated start) or
  // update a live row (and retain the stored start).
  const validFrom = validateOptionalCanonicalIsoDate(
    options?.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(options?.validTo, "validTo");
  if (!defersEndpointWindowOrdering(ifExists, options?.onImmutableLowerBound)) {
    assertOrderedValidityWindow(
      `${kind} edge between ${fromKind} "${fromId}" and ${toKind} "${toId}"`,
      validFrom,
      validTo,
    );
  }

  const findCandidates = async (
    target: GraphBackend | TransactionBackend,
  ): Promise<readonly BackendEdgeRow[]> =>
    target.findEdgesByKind({
      graphId: ctx.graphId,
      kind,
      fromKind,
      fromId,
      toKind,
      toId,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
    });

  async function findCandidatesInTransaction(): Promise<
    readonly BackendEdgeRow[]
  > {
    return runOptionallyInTransaction(
      backend,
      (target) => findCandidates(target),
      { transaction: { accessMode: "read_only" } },
    );
  }

  // The return-mode probe is also the dispatcher read for a create. Retain its
  // result, including whether it came from a transaction, so a stale positive
  // disproved by the authoritative read does not repeat either lookup before
  // the create transaction performs its own convergence check.
  let initialCandidateRead:
    | Readonly<{
        rows: readonly BackendEdgeRow[];
        authoritative: boolean;
      }>
    | undefined;

  // A root read is only a dispatcher hint. Confirm a positive result through
  // the transaction target before returning it; a cache may replay a stale
  // positive just as it may replay a stale empty result.
  if (ifExists === "return" && registration.matchIdentity === undefined) {
    const probeRows = await findCandidates(backend);
    const { liveRow: probedLiveRow, deletedRow: probedDeletedRow } =
      findMatchingEdge(probeRows, matchOn, matchProps);
    if (probedLiveRow !== undefined) {
      const currentRows = await findCandidatesInTransaction();
      const { liveRow: currentLiveRow } = findMatchingEdge(
        currentRows,
        matchOn,
        matchProps,
      );
      if (currentLiveRow !== undefined) {
        assertEndpointClearCanApply(ifExists, options?.clearValidTo, kind);
        return { edge: rowToEdge(currentLiveRow), action: "found" };
      }
      initialCandidateRead = {
        rows: currentRows,
        authoritative: true,
      };
    } else if (probedDeletedRow === undefined) {
      initialCandidateRead = {
        rows: probeRows,
        authoritative: false,
      };
    }
  }

  // No enclosing transaction: each write leg opens its own (hooked, for the
  // create leg) transaction. An outer transaction here would make the nested
  // operation run directly inside it and fire its success hooks before THIS
  // wrapper's COMMIT — the durability contract hooks promise would be false.
  //
  // The lookup below is therefore only a DISPATCHER: it chooses a leg, and the
  // two legs that DERIVE a verdict re-derive it under the per-graph fence their
  // transaction holds. The create leg runs the convergence command inside
  // that transaction (`convergeOn`) and aborts rather than inserting a second
  // edge for a match key a competitor just claimed; the resurrect leg re-checks
  // cardinality in-transaction. The `found` leg writes nothing and derives
  // nothing, and the `updated` leg writes to an id it resolved here — its
  // in-transaction re-read and its endpoint-predicated UPDATE are what make
  // that write land on the row this lookup meant, not a re-derivation of the
  // dispatcher's choice.
  async function resolveMatchedRow(
    matchedRow: BackendEdgeRow,
    isDeleted: boolean,
  ): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>> {
    if (!isDeleted) {
      if (ifExists === "return") {
        assertEndpointClearCanApply(ifExists, options?.clearValidTo, kind);
        return { edge: rowToEdge(matchedRow), action: "found" };
      }
      const outcome = await executeEdgeUpsertUpdateWithOutcome(
        ctx,
        {
          id: matchedRow.id,
          identity: { kind, fromKind, fromId, toKind, toId },
          props: validatedProps,
          ...(validFrom !== undefined && { validFrom }),
          ...(validTo !== undefined && { validTo }),
          ...(options?.clearValidTo === true && {
            clearValidTo: true as const,
          }),
          ...(options?.onImmutableLowerBound !== undefined && {
            onImmutableLowerBound: options.onImmutableLowerBound,
          }),
        },
        backend,
        {
          coalesceUnchanged:
            ctx.coalesceUnchangedUpsertsEnabled &&
            shouldCoalesceUpsert(matchedRow, options, () =>
              edgeUpsertDirtyCheck(
                ctx,
                matchedRow.kind,
                matchedRow.id,
                rowPropsToObject(matchedRow.props),
                validatedProps,
              ),
            ),
          matchOn,
          matchProps,
        },
      );
      return {
        edge: outcome.edge,
        action: outcome.wrote ? "updated" : "found",
      };
    }

    const edge = await executeEdgeUpsertUpdate(
      ctx,
      {
        id: matchedRow.id,
        identity: { kind, fromKind, toKind, fromId, toId },
        props: validatedProps,
        ...(validFrom !== undefined && { validFrom }),
        ...(validTo !== undefined && { validTo }),
        ...(options?.clearValidTo === true && { clearValidTo: true as const }),
        ...(options?.onImmutableLowerBound !== undefined && {
          onImmutableLowerBound: options.onImmutableLowerBound,
        }),
      },
      backend,
      { clearDeleted: true, matchOn, matchProps },
    );
    return { edge, action: "resurrected" };
  }

  async function attempt(
    forceTransactionRead: boolean,
  ): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>> {
    if (registration.matchIdentity !== undefined && !forceTransactionRead) {
      const createResult = await executeEdgeCreateInternal(
        ctx,
        {
          kind,
          fromKind,
          fromId,
          toKind,
          toId,
          props: validatedProps,
          ...(validFrom !== undefined && { validFrom }),
          ...(validTo !== undefined && { validTo }),
        },
        backend,
        {
          returnRow: true,
          convergeOn: { matchOn, props: matchProps },
        },
      );
      if (createResult.outcome === "found") {
        return resolveMatchedRow(
          createResult.row,
          createResult.row.deleted_at !== undefined,
        );
      }
      if (createResult.edge === undefined) {
        throw new DatabaseOperationError(
          "Durable edge convergence returned no row.",
          { operation: "insert", entity: "edge" },
        );
      }
      return { edge: createResult.edge, action: "created" };
    }

    const retainedRead = initialCandidateRead;
    initialCandidateRead = undefined;
    const candidateRead =
      retainedRead ??
      (forceTransactionRead ?
        {
          rows: await findCandidatesInTransaction(),
          authoritative: true,
        }
      : {
          rows: await findCandidates(backend),
          authoritative: false,
        });

    let { liveRow, deletedRow } = findMatchingEdge(
      candidateRead.rows,
      matchOn,
      matchProps,
    );

    // A root match is a dispatcher hint only. Use the transaction-scoped row
    // before selecting an update/resurrection id, since cached root reads may
    // be stale in either direction.
    if (
      !candidateRead.authoritative &&
      (liveRow !== undefined || deletedRow !== undefined)
    ) {
      const currentRows = await findCandidatesInTransaction();
      ({ liveRow, deletedRow } = findMatchingEdge(
        currentRows,
        matchOn,
        matchProps,
      ));
    }

    // No match → create new edge
    if (liveRow === undefined && deletedRow === undefined) {
      const input: CreateEdgeInput = {
        kind,
        fromKind,
        fromId,
        toKind,
        toId,
        props: validatedProps,
        ...(validFrom !== undefined && { validFrom }),
        ...(validTo !== undefined && { validTo }),
      };
      const createResult = await executeEdgeCreateInternal(
        ctx,
        input,
        backend,
        {
          returnRow: true,
          convergeOn: { matchOn, props: matchProps },
        },
      );
      if (createResult.outcome === "found") {
        return resolveMatchedRow(
          createResult.row,
          createResult.row.deleted_at !== undefined,
        );
      }
      if (createResult.edge === undefined) {
        throw new DatabaseOperationError(
          "Edge create failed: expected created edge row",
          { operation: "insert", entity: "edge" },
        );
      }
      return { edge: createResult.edge, action: "created" };
    }

    if (liveRow !== undefined) return resolveMatchedRow(liveRow, false);
    if (deletedRow === undefined) {
      throw new Error("Expected deletedRow to be defined");
    }
    return resolveMatchedRow(deletedRow, true);
  }

  // Convergence loop. Under the fence a losing writer learns about the winner
  // from its own in-transaction convergence command rather than from a
  // constraint violation, so the ordinary path uses the row the transaction
  // just observed. The `CardinalityError` arm remains the
  // backstop for the paths the fence cannot cover — a competitor whose write is
  // not a `getOrCreateByEndpoints` at all.
  //
  // ATTEMPT_LIMIT bounds a pathological ping-pong (a competitor that creates
  // and hard-deletes the same match key repeatedly) rather than spinning.
  const ATTEMPT_LIMIT = 3;
  let forceTransactionRead = false;
  for (let remaining = ATTEMPT_LIMIT; remaining > 0; remaining -= 1) {
    try {
      return await attempt(forceTransactionRead);
    } catch (error) {
      if (
        error instanceof EdgeMatchKeyMoved ||
        error instanceof EdgeNotFoundError
      ) {
        if (remaining === 1) {
          throw new DatabaseOperationError(
            `getOrCreateByEndpoints for ${kind} between ${fromKind} "${fromId}" ` +
              `and ${toKind} "${toId}" could not resolve a stable matching edge ` +
              `after ${String(ATTEMPT_LIMIT)} attempts; a concurrent writer ` +
              "keeps changing or deleting it. Retry the operation.",
            { operation: "insert", entity: "edge" },
            { cause: error },
          );
        }
        forceTransactionRead = true;
        continue;
      }
      if (error instanceof EdgeMatchIdentityConflictError) {
        if (remaining === 1) {
          throw new DatabaseOperationError(
            `getOrCreateByEndpoints for ${kind} between ${fromKind} "${fromId}" ` +
              `and ${toKind} "${toId}" could not resolve the durable identity ` +
              `owner after ${String(ATTEMPT_LIMIT)} attempts. Retry the operation.`,
            { operation: "insert", entity: "edge" },
            { cause: error },
          );
        }
        forceTransactionRead = true;
        continue;
      }
      if (error instanceof CardinalityError && remaining > 1) continue;
      throw error;
    }
  }
  // Unreachable: the loop either returns or throws on its final iteration.
  throw new DatabaseOperationError(
    "getOrCreateByEndpoints convergence loop exited without a verdict",
    { operation: "insert", entity: "edge" },
  );
}

/**
 * Executes a bulk getOrCreateByEndpoints operation.
 */
export async function executeEdgeBulkGetOrCreateByEndpoints<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  kind: string,
  items: readonly Readonly<{
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    props: Record<string, unknown>;
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "preserve" | "refuse";
  }>[],
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    ifExists?: IfExistsMode;
  }>,
): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>[]> {
  if (items.length === 0) return [];

  const ifExists = options?.ifExists ?? "return";

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;
  const matchOn = resolveEdgeMatchFields(
    kind,
    registration.matchIdentity?.fields,
    options?.matchOn,
  );

  // Validate matchOn fields once
  validateMatchOnFields(edgeKind.schema, matchOn, kind);

  // Step 1: Validate all props and compute composite keys
  const validated: {
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    validatedProps: Record<string, unknown>;
    matchProps: Record<string, unknown>;
    compositeKey: string;
    endpointKey: string;
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "preserve" | "refuse";
  }[] = [];

  for (const item of items) {
    assertValidityEndMutation(item, { entityType: "edge", kind });
    if (item.clearValidTo === true) {
      assertClearValidToSupported(backend, "edge");
    }
    const validatedProps = validateEdgeProps(edgeKind.schema, item.props, {
      kind,
      operation: "create",
    });
    const matchProps = normalizePersistedEdgeMatchProps(validatedProps);
    const validFrom = validateOptionalCanonicalIsoDate(
      item.validFrom,
      "validFrom",
    );
    const validTo = validateOptionalCanonicalIsoDate(item.validTo, "validTo");
    // As in the single-item path, canonical form is always judged up front.
    // Preserve-mode updates defer ordering until the target row is resolved.
    if (!defersEndpointWindowOrdering(ifExists, item.onImmutableLowerBound)) {
      assertOrderedValidityWindow(
        `${kind} edge between ${item.fromKind} "${item.fromId}" and ${item.toKind} "${item.toId}"`,
        validFrom,
        validTo,
      );
    }

    const compositeKey = buildEdgeMatchKey({
      fromKind: item.fromKind,
      fromId: item.fromId,
      toKind: item.toKind,
      toId: item.toId,
      props: matchProps,
      matchOn,
    });
    const endpointKey = buildEndpointPairKey(
      item.fromKind,
      item.fromId,
      item.toKind,
      item.toId,
    );

    validated.push({
      fromKind: item.fromKind,
      fromId: item.fromId,
      toKind: item.toKind,
      toId: item.toId,
      validatedProps,
      matchProps,
      compositeKey,
      endpointKey,
      ...(validFrom !== undefined && { validFrom }),
      ...(validTo !== undefined && { validTo }),
      ...(item.clearValidTo === true && { clearValidTo: true as const }),
      ...(item.onImmutableLowerBound !== undefined && {
        onImmutableLowerBound: item.onImmutableLowerBound,
      }),
    });
  }

  // Step 2: Group by unique endpoint pair
  const uniqueEndpoints = new Map<
    string,
    { fromKind: string; fromId: string; toKind: string; toId: string }
  >();
  for (const entry of validated) {
    if (!uniqueEndpoints.has(entry.endpointKey)) {
      uniqueEndpoints.set(entry.endpointKey, {
        fromKind: entry.fromKind,
        fromId: entry.fromId,
        toKind: entry.toKind,
        toId: entry.toId,
      });
    }
  }

  // Fetch all candidate rows, grouped by endpoint pair. Shared by the
  // outside-transaction probe (reading the root backend) and the
  // transactional body (re-reading through the transaction target).
  async function fetchRowsByEndpoint(
    reader: GraphReadBackend,
  ): Promise<ReadonlyMap<string, readonly BackendEdgeRow[]>> {
    const rowsByEndpoint = new Map<string, readonly BackendEdgeRow[]>();
    const setRead = reader.findEdgesByHeterogeneousEndpointSet;
    if (setRead !== undefined) {
      for (const endpointKey of uniqueEndpoints.keys()) {
        rowsByEndpoint.set(endpointKey, []);
      }
      const sourceEndpoints = new Map<
        string,
        Readonly<{
          kind: string;
          id: string;
          opposite: Readonly<{ kind: string; id: string }>;
        }>
      >();
      for (const endpoint of uniqueEndpoints.values()) {
        sourceEndpoints.set(
          buildEndpointPairKey(
            endpoint.fromKind,
            endpoint.fromId,
            endpoint.toKind,
            endpoint.toId,
          ),
          {
            kind: endpoint.fromKind,
            id: endpoint.fromId,
            opposite: { kind: endpoint.toKind, id: endpoint.toId },
          },
        );
      }
      const rows = await setRead({
        graphId: ctx.graphId,
        side: "from",
        endpoints: [...sourceEndpoints.values()],
        edgeKinds: [kind],
        excludeDeleted: false,
        temporalMode: "includeTombstones",
      });
      const mutableRows = new Map<string, BackendEdgeRow[]>();
      for (const row of rows) {
        const endpointKey = buildEndpointPairKey(
          row.from_kind,
          row.from_id,
          row.to_kind,
          row.to_id,
        );
        if (!uniqueEndpoints.has(endpointKey)) continue;
        const bucket = mutableRows.get(endpointKey) ?? [];
        bucket.push(row);
        mutableRows.set(endpointKey, bucket);
      }
      for (const [endpointKey, endpointRows] of mutableRows) {
        rowsByEndpoint.set(endpointKey, endpointRows);
      }
      return rowsByEndpoint;
    }
    for (const [endpointKey, endpoint] of uniqueEndpoints) {
      const rows = await reader.findEdgesByKind({
        graphId: ctx.graphId,
        kind,
        fromKind: endpoint.fromKind,
        fromId: endpoint.fromId,
        toKind: endpoint.toKind,
        toId: endpoint.toId,
        excludeDeleted: false,
        temporalMode: "includeTombstones",
      });
      rowsByEndpoint.set(endpointKey, rows);
    }
    return rowsByEndpoint;
  }

  interface CreateEntry {
    index: number;
    input: CreateEdgeInput;
  }
  interface FetchEntry {
    index: number;
    row: BackendEdgeRow;
    isDeleted: boolean;
    validatedProps: Record<string, unknown>;
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    /**
     * STORED only on a RESURRECTION, which rewrites both endpoints. It is
     * forwarded on the live-update leg too, where the write guard refuses a
     * bound that differs from the one the row already holds.
     */
    validFrom?: string;
    validTo?: string;
    clearValidTo?: true;
    onImmutableLowerBound?: "preserve" | "refuse";
  }
  interface DuplicateEntry {
    index: number;
    sourceIndex: number;
  }
  interface Result {
    readonly edge: Edge;
    readonly action: GetOrCreateAction;
  }

  // Step 3: Partition into toCreate, toFetch, and duplicates
  function partitionEntries(
    rowsByEndpoint: ReadonlyMap<string, readonly BackendEdgeRow[]>,
  ): Readonly<{
    toCreate: CreateEntry[];
    toFetch: FetchEntry[];
    duplicateOf: DuplicateEntry[];
  }> {
    const toCreate: CreateEntry[] = [];
    const toFetch: FetchEntry[] = [];
    const duplicateOf: DuplicateEntry[] = [];
    const seenKeys = new Map<string, number>();

    for (const [index, entry] of validated.entries()) {
      // Check within-batch duplicate
      const previousIndex = seenKeys.get(entry.compositeKey);
      if (previousIndex !== undefined) {
        // A duplicate is a found/no-write result, so there is no stored target
        // window against which preserve mode can defer this decision. Keep the
        // existing return-mode contract: its stated pair must be ordered.
        if (preservesImmutableLowerBound(entry.onImmutableLowerBound)) {
          assertOrderedValidityWindow(
            `${kind} edge between ${entry.fromKind} "${entry.fromId}" and ${entry.toKind} "${entry.toId}"`,
            entry.validFrom,
            entry.validTo,
          );
        }
        duplicateOf.push({ index, sourceIndex: previousIndex });
        continue;
      }
      seenKeys.set(entry.compositeKey, index);

      const candidateRows = rowsByEndpoint.get(entry.endpointKey) ?? [];
      const { liveRow, deletedRow } = findMatchingEdge(
        candidateRows,
        matchOn,
        entry.matchProps,
      );

      if (liveRow === undefined && deletedRow === undefined) {
        toCreate.push({
          index,
          input: {
            kind,
            fromKind: entry.fromKind,
            fromId: entry.fromId,
            toKind: entry.toKind,
            toId: entry.toId,
            props: entry.validatedProps,
            ...(entry.validFrom !== undefined && {
              validFrom: entry.validFrom,
            }),
            ...(entry.validTo !== undefined && { validTo: entry.validTo }),
          },
        });
      } else {
        // At least one of liveRow/deletedRow is defined (both-undefined handled above)
        const bestRow = liveRow ?? deletedRow;
        if (bestRow === undefined) {
          throw new Error("Expected at least one of liveRow or deletedRow");
        }
        toFetch.push({
          index,
          row: bestRow,
          isDeleted: liveRow === undefined,
          validatedProps: entry.validatedProps,
          fromKind: entry.fromKind,
          fromId: entry.fromId,
          toKind: entry.toKind,
          toId: entry.toId,
          ...(entry.validFrom !== undefined && {
            validFrom: entry.validFrom,
          }),
          ...(entry.validTo !== undefined && { validTo: entry.validTo }),
          ...(entry.clearValidTo === true && {
            clearValidTo: true as const,
          }),
          ...(entry.onImmutableLowerBound !== undefined && {
            onImmutableLowerBound: entry.onImmutableLowerBound,
          }),
        });
      }
    }

    return { toCreate, toFetch, duplicateOf };
  }

  // Probe outside the transaction: with ifExists "return" and every entry
  // matching a live edge, the whole call performs no write, so it must not
  // pay for a write transaction (BEGIN IMMEDIATE on SQLite, the per-graph
  // advisory lock under history). The transactional body re-queries, so a
  // concurrent write between this probe and the write lock is still handled
  // correctly.
  if (ifExists === "return") {
    const probe = partitionEntries(await fetchRowsByEndpoint(backend));
    const allFoundLive =
      probe.toCreate.length === 0 &&
      probe.toFetch.every((entry) => !entry.isDeleted);
    if (allFoundLive) {
      const found: Result[] = Array.from({ length: items.length });
      for (const entry of probe.toFetch) {
        assertEndpointClearCanApply(ifExists, entry.clearValidTo, kind);
        found[entry.index] = { edge: rowToEdge(entry.row), action: "found" };
      }
      for (const { index, sourceIndex } of probe.duplicateOf) {
        found[index] = {
          edge: requireDefined(found[sourceIndex]).edge,
          action: "found",
        };
      }
      return found;
    }
  }

  // The partition that decides create-vs-fetch is re-derived from `target`
  // INSIDE the fenced transaction, so the batch's lookup and its writes commit
  // under one per-graph mutual exclusion — the bulk analogue of the single-item
  // path's `convergeOn` guard, and the reason the bulk path needs no in-loop
  // race handling of its own.
  function runBatch(): Promise<
    Readonly<{ results: Result[]; writes: number }>
  > {
    return runWritePlan(
      ctx,
      // A bulk getOrCreate always converges on a match key no database key
      // backs, whatever its cardinality — the same reason the single-item path
      // fences unconditionally.
      edgeWritePlan("edgeMatchKeyConvergence"),
      backend,
      async (session, target, _overlaidSession, lock) => {
        // ## The one widening the migration cannot remove
        //
        // The nested legs are whole managed writes of their own: each opens its
        // OWN plan against THIS transaction target, which is why they take the
        // raw union rather than the session this frame minted. Re-entering the
        // executor is not decoration — the nested frame re-takes the schema
        // fence and, on a revision-tracking store, advances the revision clock —
        // so inlining their row work here to avoid the widening would change
        // emitted statements and revision numbers, which the no-behavior-change
        // invariant forbids. Every other escape is gone; this one is the
        // ratchet's stated floor, not migration debt.
        const rawTarget = nestedManagedWriteTarget(target);
        const { toCreate, toFetch, duplicateOf } = partitionEntries(
          await fetchRowsByEndpoint(target),
        );
        const results: Result[] = Array.from({ length: items.length });
        let writes = 0;

        // Step 4: Execute creates in batch
        if (toCreate.length > 0) {
          // The batch insertion path deliberately remains one multi-row write,
          // rather than expanding into one convergence command per item. It
          // still derives create-vs-found from the fenced snapshot, so enforce
          // the same freshness contract as the single-item command before the
          // first create. Existing-only batches never reach this gate.
          if (lock.coordination !== undefined) {
            assertGraphCommandConvergenceIsolation(
              target.commands,
              lock.coordination,
            );
          }
          const createInputs = toCreate.map((entry) => entry.input);
          const createdEdges = await executeEdgeCreateBatch(
            ctx,
            createInputs,
            rawTarget,
          );
          for (const [batchIndex, entry] of toCreate.entries()) {
            results[entry.index] = {
              edge: requireDefined(createdEdges[batchIndex]),
              action: "created",
            };
          }
          writes += toCreate.length;
        }

        // Step 5: Handle existing edges (update/skip/resurrect)
        for (const entry of toFetch) {
          if (entry.isDeleted) {
            // As in the single-item path: a resurrection forwards `validFrom`
            // so a stated lower bound restates the revived row's whole window,
            // and its cardinality re-check runs inside the resurrecting write.
            const edge = await executeEdgeUpsertUpdate(
              ctx,
              {
                id: entry.row.id,
                identity: {
                  kind,
                  fromKind: entry.fromKind,
                  fromId: entry.fromId,
                  toKind: entry.toKind,
                  toId: entry.toId,
                },
                props: entry.validatedProps,
                ...(entry.validFrom !== undefined && {
                  validFrom: entry.validFrom,
                }),
                ...(entry.validTo !== undefined && { validTo: entry.validTo }),
                ...(entry.clearValidTo === true && {
                  clearValidTo: true as const,
                }),
                ...(entry.onImmutableLowerBound !== undefined && {
                  onImmutableLowerBound: entry.onImmutableLowerBound,
                }),
              },
              rawTarget,
              { clearDeleted: true },
            );
            results[entry.index] = { edge, action: "resurrected" };
            writes += 1;
          } else if (ifExists === "update") {
            // As in the single-item path: `validFrom` is forwarded so the
            // shared write guard refuses a bound the in-place update cannot
            // store, rather than dropping it silently here.
            const outcome = await executeEdgeUpsertUpdateWithOutcome(
              ctx,
              {
                id: entry.row.id,
                identity: {
                  kind,
                  fromKind: entry.fromKind,
                  fromId: entry.fromId,
                  toKind: entry.toKind,
                  toId: entry.toId,
                },
                props: entry.validatedProps,
                ...(entry.validFrom !== undefined && {
                  validFrom: entry.validFrom,
                }),
                ...(entry.validTo !== undefined && { validTo: entry.validTo }),
                ...(entry.clearValidTo === true && {
                  clearValidTo: true as const,
                }),
                ...(entry.onImmutableLowerBound !== undefined && {
                  onImmutableLowerBound: entry.onImmutableLowerBound,
                }),
              },
              rawTarget,
              {
                coalesceUnchanged: ctx.coalesceUnchangedUpsertsEnabled,
                coalesceCandidate: entry.row,
              },
            );
            results[entry.index] = {
              edge: outcome.edge,
              action: outcome.wrote ? "updated" : "found",
            };
            if (outcome.wrote) writes += 1;
          } else {
            assertEndpointClearCanApply(ifExists, entry.clearValidTo, kind);
            results[entry.index] = {
              edge: rowToEdge(entry.row),
              action: "found",
            };
          }
        }

        // Step 6: Resolve within-batch duplicates
        for (const { index, sourceIndex } of duplicateOf) {
          const sourceResult = requireDefined(results[sourceIndex]);
          if (sourceResult.action === "found") {
            assertEndpointClearCanApply(
              ifExists,
              items[index]?.clearValidTo,
              kind,
            );
          }
          results[index] = { edge: sourceResult.edge, action: "found" };
        }

        return { results, writes };
      },
      { didWrite: (outcome) => outcome.writes > 0 },
    );
  }

  async function runBatchResults(): Promise<Result[]> {
    const outcome = await runBatch();
    return outcome.results;
  }

  // The single-item path's `CardinalityError` retry, which this path lacked: a
  // competing winner failed the WHOLE batch instead of converging. With the
  // fence the batch's own lookup sees the winner, so this is the backstop for
  // the paths the fence cannot cover (a non-transactional backend, or a
  // competitor that is not a `getOrCreateByEndpoints`) — one retry, matching
  // the single-item path rather than inventing a second policy.
  try {
    return await runBatchResults();
  } catch (error) {
    if (!(error instanceof CardinalityError)) throw error;
    return runBatchResults();
  }
}
