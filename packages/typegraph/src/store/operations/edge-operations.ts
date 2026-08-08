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
 *  - `valid_to` of a tombstone, read by the resurrect cardinality check
 *    (`EdgeResurrectCardinality.effectiveValidTo`) — NOT asserted, and bounded
 *    by the constraint fence instead: that probe and its write commit under the
 *    same per-graph mutual exclusion (paragraph above), so no peer can move the
 *    bound between them.
 */
import {
  createBackendOverlay,
  type EdgeRow as BackendEdgeRow,
  type GraphBackend,
  type GraphReadBackend,
  type InsertEdgeParams,
  rowPropsToObject,
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
  DatabaseOperationError,
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
  validateOptionalCanonicalIsoDate,
} from "../../utils/date";
import { generateId } from "../../utils/id";
import { hasOwnKey, readOwnProperty } from "../../utils/object";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import { type UpsertDirtyCheck } from "../collections/coalesce";
import { type UpsertUpdateEdgeInput } from "../collections/edge-collection";
import {
  checkCardinalityConstraint,
  type ConstraintContext,
  type ConstraintFenceReason,
  edgeWriteNeedsConstraintFence,
} from "../constraints";
import {
  edgeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../insert-dispatch";
import { type EdgeRow, rowToEdge } from "../row-mappers";
import {
  type CreateEdgeInput,
  type Edge,
  type GetOrCreateAction,
  type IfExistsMode,
  type OperationHookContext,
} from "../types";
import { withAlreadyExistsTranslation } from "./already-exists";
import {
  assertEdgeIdentityMatches,
  type EdgeIdentityExpectation,
  edgeIdentityFromRow,
} from "./edge-identity";
import {
  runHookedWriteOperation,
  runInWriteTransaction,
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
  revisionSchema: SqlSchema;
  registry: KindRegistry;
  createOperationContext: (
    operation: "create" | "update" | "delete",
    entity: KindEntity,
    kind: string,
    id: string,
  ) => OperationHookContext;
  withOperationHooks: <T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
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

function buildEdgeEndpointCacheKey(
  graphId: string,
  kind: string,
  id: string,
): string {
  return encodeTupleKey([graphId, kind, id]);
}

function buildEdgeFromCacheKey(
  graphId: string,
  edgeKind: string,
  fromKind: string,
  fromId: string,
): string {
  return encodeTupleKey([graphId, edgeKind, fromKind, fromId]);
}

function buildEdgeBetweenCacheKey(
  graphId: string,
  edgeKind: string,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
): string {
  return encodeTupleKey([graphId, edgeKind, fromKind, fromId, toKind, toId]);
}

function buildCountEdgesFromCacheKey(
  params: Parameters<GraphBackend["countEdgesFrom"]>[0],
): string {
  const activeOnly = params.activeOnly === true ? "1" : "0";
  return encodeTupleKey([
    params.graphId,
    params.edgeKind,
    params.fromKind,
    params.fromId,
    activeOnly,
  ]);
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
  return insertParams;
}

function incrementPendingCount(counts: Map<string, number>, key: string): void {
  const previous = counts.get(key) ?? 0;
  counts.set(key, previous + 1);
}

function createEdgeBatchValidationBackend(
  backend: GraphBackend | TransactionBackend,
): Readonly<{
  backend: GraphBackend | TransactionBackend;
  registerPendingEdgeForCardinality: (
    insertParams: InsertEdgeParams,
    cardinality: Cardinality,
  ) => void;
  seedEndpointRow: (
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ) => void;
}> {
  const endpointCache = new Map<
    string,
    Awaited<ReturnType<GraphBackend["getNode"]>>
  >();
  const countEdgesFromCache = new Map<string, number>();
  const edgeExistsCache = new Map<string, boolean>();
  const pendingOneCounts = new Map<string, number>();
  const pendingOneActiveCounts = new Map<string, number>();
  const pendingUniquePairs = new Set<string>();

  async function getNodeCached(
    graphId: string,
    kind: string,
    id: string,
  ): Promise<Awaited<ReturnType<GraphBackend["getNode"]>>> {
    const cacheKey = buildEdgeEndpointCacheKey(graphId, kind, id);
    if (endpointCache.has(cacheKey)) {
      return endpointCache.get(cacheKey);
    }
    const node = await backend.getNode(graphId, kind, id);
    endpointCache.set(cacheKey, node);
    return node;
  }

  // Lets batch preparation prime the endpoint cache from one getNodes
  // round trip per (kind) instead of a per-edge getNode probe for each
  // from/to endpoint — mirrors seedNodeRow in createNodeBatchValidationBackend.
  // Seeding an absent result (`undefined`) is meaningful — it marks the key
  // as known-missing so the per-edge check skips the backend read. An
  // earlier lookup or seed always wins; seeding never overwrites.
  function seedEndpointRow(
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ): void {
    const cacheKey = buildEdgeEndpointCacheKey(graphId, kind, id);
    if (endpointCache.has(cacheKey)) return;
    endpointCache.set(cacheKey, row);
  }

  async function countEdgesFromCached(
    params: Parameters<GraphBackend["countEdgesFrom"]>[0],
  ): Promise<number> {
    const cacheKey = buildCountEdgesFromCacheKey(params);
    let baseCount = countEdgesFromCache.get(cacheKey);
    if (baseCount === undefined) {
      baseCount = await backend.countEdgesFrom(params);
      countEdgesFromCache.set(cacheKey, baseCount);
    }
    const pendingKey = buildEdgeFromCacheKey(
      params.graphId,
      params.edgeKind,
      params.fromKind,
      params.fromId,
    );
    const pendingCount =
      params.activeOnly === true ?
        (pendingOneActiveCounts.get(pendingKey) ?? 0)
      : (pendingOneCounts.get(pendingKey) ?? 0);
    return baseCount + pendingCount;
  }

  async function edgeExistsBetweenCached(
    params: Parameters<GraphBackend["edgeExistsBetween"]>[0],
  ): Promise<boolean> {
    const cacheKey = buildEdgeBetweenCacheKey(
      params.graphId,
      params.edgeKind,
      params.fromKind,
      params.fromId,
      params.toKind,
      params.toId,
    );
    if (pendingUniquePairs.has(cacheKey)) {
      return true;
    }
    if (edgeExistsCache.has(cacheKey)) {
      return edgeExistsCache.get(cacheKey) ?? false;
    }
    const exists = await backend.edgeExistsBetween(params);
    edgeExistsCache.set(cacheKey, exists);
    return exists;
  }

  function registerPendingEdgeForCardinality(
    insertParams: InsertEdgeParams,
    cardinality: Cardinality,
  ): void {
    const fromCacheKey = buildEdgeFromCacheKey(
      insertParams.graphId,
      insertParams.kind,
      insertParams.fromKind,
      insertParams.fromId,
    );
    if (cardinality === "one") {
      incrementPendingCount(pendingOneCounts, fromCacheKey);
      return;
    }
    if (cardinality === "oneActive") {
      if (insertParams.validTo === undefined) {
        incrementPendingCount(pendingOneActiveCounts, fromCacheKey);
      }
      return;
    }
    if (cardinality === "unique") {
      const uniqueCacheKey = buildEdgeBetweenCacheKey(
        insertParams.graphId,
        insertParams.kind,
        insertParams.fromKind,
        insertParams.fromId,
        insertParams.toKind,
        insertParams.toId,
      );
      pendingUniquePairs.add(uniqueCacheKey);
    }
  }

  const validationBackend = createBackendOverlay(backend, {
    getNode: getNodeCached,
    countEdgesFrom: countEdgesFromCached,
    edgeExistsBetween: edgeExistsBetweenCached,
  } satisfies Partial<GraphBackend | TransactionBackend>);

  return {
    backend: validationBackend,
    registerPendingEdgeForCardinality,
    seedEndpointRow,
  };
}

async function validateAndPrepareEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<EdgeCreatePrepared> {
  const kind = input.kind;
  const fromKind = input.fromKind;
  const toKind = input.toKind;

  // Validate kind exists and get registration
  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  // Validate endpoint types
  const endpointError = validateEdgeEndpoints(
    kind,
    fromKind,
    toKind,
    registration,
    ctx.registry,
  );
  if (endpointError) throw endpointError;

  // Validate source node exists
  const fromNode = await backend.getNode(ctx.graphId, fromKind, input.fromId);
  if (!fromNode || fromNode.deleted_at) {
    throw new EndpointNotFoundError({
      edgeKind: kind,
      endpoint: "from",
      nodeKind: fromKind,
      nodeId: input.fromId,
    });
  }

  // Validate target node exists
  const toNode = await backend.getNode(ctx.graphId, toKind, input.toId);
  if (!toNode || toNode.deleted_at) {
    throw new EndpointNotFoundError({
      edgeKind: kind,
      endpoint: "to",
      nodeKind: toKind,
      nodeId: input.toId,
    });
  }

  // Validate props with full context
  const validatedProps = validateEdgeProps(edgeKind.schema, input.props, {
    kind,
    operation: "create",
  });

  // Validate temporal fields
  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
  // A stated pair must be ordered. A lone historical validTo is NOT an error on
  // an insert — it means "born already ended" (see
  // assertWritableValidityWindow). Both create paths (single and batch) prepare
  // through here, so this is the only insert-side check needed.
  assertOrderedValidityWindow(`edge "${id}"`, validFrom, validTo);

  // Check cardinality constraints
  const cardinality = registration.cardinality ?? "many";
  const constraintContext: ConstraintContext = {
    graphId: ctx.graphId,
    registry: ctx.registry,
    backend,
  };
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
    ),
  };
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
 * the fence, and reports a race rather than inserting a duplicate.
 */
type EdgeConvergenceGuard = Readonly<{
  matchOn: readonly string[];
  props: Record<string, unknown>;
}>;

/**
 * A guarded create leg that found a competitor's edge under the fence.
 *
 * THROWN rather than returned, and that choice is the whole point: the leg is
 * wrapped in operation hooks and a write transaction, and both of them read
 * "did this operation do what it said" from whether the body threw. Returning a
 * "nothing happened" value instead left `onOperationEnd` reporting a successful
 * create for an id no row carries, and left the revision clock advancing for a
 * write that never occurred. Throwing routes the abort through `onError` — the
 * same report the pre-existing `CardinalityError` retry has always produced for
 * a losing attempt — and skips the clock advance by construction rather than by
 * a `didWrite` predicate that a later edit could forget to pass.
 *
 * Never escapes {@link executeEdgeGetOrCreateByEndpoints}: the convergence loop
 * is the only caller that sets the guard, and it is the only code that catches
 * this.
 */
class EdgeConvergenceRaced extends Error {
  constructor(kind: string) {
    super(
      `A competing writer claimed the ${kind} match key; re-resolving it. ` +
        `This is internal to getOrCreateByEndpoints and is never returned to a caller.`,
    );
    this.name = "EdgeConvergenceRaced";
  }
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
  }>,
): Promise<Edge | undefined> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const opContext = ctx.createOperationContext("create", "edge", kind, id);
  const shouldReturnRow = options?.returnRow ?? true;
  const convergeOn = options?.convergeOn;

  return runHookedWriteOperation(
    ctx,
    opContext,
    backend,
    async (target): Promise<Edge | undefined> => {
      if (convergeOn !== undefined) {
        const candidateRows = await target.findEdgesByKind({
          graphId: ctx.graphId,
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
        if (liveRow !== undefined || deletedRow !== undefined) {
          throw new EdgeConvergenceRaced(kind);
        }
      }

      const prepared = await validateAndPrepareEdgeCreate(
        ctx,
        input,
        id,
        target,
      );

      // An edge create has no existence probe at all — its id is either
      // caller-supplied or freshly generated — so the engine's refusal is the ONLY
      // report that the id is taken. Translated here, that report is the same
      // already-exists error a node create raises.
      const row = await withAlreadyExistsTranslation("edge", async () => {
        if (shouldReturnRow) return target.insertEdge(prepared.insertParams);
        await runInsertNoReturn(
          edgeInsertDispatch(target),
          prepared.insertParams,
        );
        return;
      });

      return row === undefined ? undefined : rowToEdge(row);
    },
    {
      // A create that runs a cardinality probe, or one converging on a match
      // key, decides something the write must not have invalidated. A plain
      // `many` create decides nothing and takes no lock.
      fencesConstraintProbe:
        convergeOn === undefined ?
          edgeWriteNeedsConstraintFence(edgeCardinality(ctx, kind))
        : "edgeMatchKeyConvergence",
    },
  );
}

/**
 * Executes an edge create operation and returns the created edge.
 */
export async function executeEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const edge = await executeEdgeCreateInternal(ctx, input, backend, {
    returnRow: true,
  });
  if (!edge) {
    throw new DatabaseOperationError(
      "Edge create failed: expected created edge row",
      { operation: "insert", entity: "edge" },
    );
  }
  return edge;
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
  backend: GraphBackend | TransactionBackend,
  seedEndpointRow: (
    graphId: string,
    kind: string,
    id: string,
    row: Awaited<ReturnType<GraphBackend["getNode"]>>,
  ) => void,
): Promise<void> {
  if (backend.getNodes === undefined) return;

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
    const rows = await backend.getNodes(ctx.graphId, kind, orderedIds);
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
  backend: GraphBackend | TransactionBackend,
): Promise<{
  preparedCreates: EdgeCreatePrepared[];
  batchInsertParams: InsertEdgeParams[];
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

  const batchInsertParams = preparedCreates.map(
    (prepared) => prepared.insertParams,
  );

  return { preparedCreates, batchInsertParams };
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

  await runInWriteTransaction(
    ctx,
    backend,
    async (target) => {
      const { batchInsertParams } = await prepareEdgeBatchCreates(
        ctx,
        inputs,
        target,
      );
      await withAlreadyExistsTranslation("edge", () =>
        runInsertBatch(edgeInsertDispatch(target), batchInsertParams),
      );
    },
    { fencesConstraintProbe: batchFencesConstraintProbe(ctx, inputs) },
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

  return runInWriteTransaction(
    ctx,
    backend,
    async (target) => {
      const { batchInsertParams } = await prepareEdgeBatchCreates(
        ctx,
        inputs,
        target,
      );

      const rows = await withAlreadyExistsTranslation("edge", () =>
        runInsertBatchReturning(edgeInsertDispatch(target), batchInsertParams),
      );

      return rows.map((row) => rowToEdge(row));
    },
    { fencesConstraintProbe: batchFencesConstraintProbe(ctx, inputs) },
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
  return validateEdgeProps(
    registration.type.schema,
    { ...existingProps, ...inputProps },
    { kind, operation: "update", id },
  );
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
  target: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Edge> {
  const id = input.id;

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

  const { validatedProps } = resolveEdgeUpdateProps(ctx, existing, input.props);

  const validFrom = validateOptionalCanonicalIsoDate(
    input.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(input.validTo, "validTo");
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
    validFrom,
    {
      effectiveValidFrom: existing.valid_from,
      appliesStatedValidFrom: options?.clearDeleted === true,
    },
    validTo,
  );

  // `validFrom` reaches the backend only through a resurrecting write (see
  // UpdateEdgeParams): a live edge's lower bound is history and stays put.
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
  const updateParams: {
    graphId: string;
    id: string;
    kind: string;
    fromKind?: string;
    fromId?: string;
    toKind?: string;
    toId?: string;
    props: Record<string, unknown>;
    validFrom?: string;
    validTo?: string;
    expectedValidFrom?: string | null;
    clearDeleted?: boolean;
  } = {
    graphId: ctx.graphId,
    id,
    kind: input.identity.kind,
    props: validatedProps,
  };
  // The bound the window verdict above READ, carried into the same `WHERE` as
  // the identity components and on exactly the same terms: emitted only when
  // the verdict consulted it, because a component the caller made no claim
  // about must not become a predicate that refuses legitimate writes. Unlike
  // the node side, `effectiveValidFrom` here is the row's stored bound on BOTH
  // legs — an edge retains `valid_from` through a resurrection that does not
  // name a new one — so there is no resurrection carve-out to make.
  if (windowVerdict.readEffectiveLowerBound) {
    // eslint-disable-next-line unicorn/no-null -- `expectedValidFrom` distinguishes "assert IS NULL" (null) from "assert nothing" (undefined); see UpdateEdgeParams.
    updateParams.expectedValidFrom = existing.valid_from ?? null;
  }
  if (input.identity.fromKind !== undefined) {
    updateParams.fromKind = input.identity.fromKind;
  }
  if (input.identity.fromId !== undefined) {
    updateParams.fromId = input.identity.fromId;
  }
  if (input.identity.toKind !== undefined) {
    updateParams.toKind = input.identity.toKind;
  }
  if (input.identity.toId !== undefined) {
    updateParams.toId = input.identity.toId;
  }
  if (validFrom !== undefined) updateParams.validFrom = validFrom;
  if (validTo !== undefined) updateParams.validTo = validTo;
  if (options?.clearDeleted) updateParams.clearDeleted = true;

  const row = await withUnmatchedEdgeUpdateRefusal(
    ctx,
    target,
    id,
    input.identity,
    updateParams.expectedValidFrom !== undefined,
    () => target.updateEdge(updateParams),
  );

  return rowToEdge(row);
}

function isEdgeUpdateNoRowError(
  error: unknown,
): error is DatabaseOperationError {
  return (
    error instanceof DatabaseOperationError &&
    error.details.operation === "update" &&
    error.details.entity === "edge" &&
    error.details.reason === "no_row_returned"
  );
}

/**
 * Reports a kind-predicated edge UPDATE that matched nothing.
 *
 * With the expected kind in the statement's `WHERE`, "no row returned" is no
 * longer only "the row vanished" — it is also "the id now resolves to a
 * different edge" (or "the row was tombstoned", for a non-resurrecting
 * update). Only this failure path pays the extra read, and it re-derives the
 * SAME verdict the pre-write check would have reached, through the same single
 * owner ({@link assertEdgeIdentityMatches}), so the caller cannot tell which of
 * the two raised it.
 */
async function withUnmatchedEdgeUpdateRefusal<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  target: GraphBackend | TransactionBackend,
  id: string,
  expected: EdgeIdentityExpectation,
  assertedValidFrom: boolean,
  write: () => Promise<BackendEdgeRow>,
): Promise<BackendEdgeRow> {
  try {
    return await write();
  } catch (error) {
    if (!isEdgeUpdateNoRowError(error)) throw error;
    const current = await target.getEdge(ctx.graphId, id);
    if (current !== undefined) {
      assertEdgeIdentityMatches(
        id,
        expected,
        edgeIdentityFromRow(current),
        "update",
      );
      // Identity still matches, so the predicate that stopped matching was the
      // validity bound this update asserted — the row was replaced by an
      // incarnation whose window the verdict never saw. That is not "no such
      // edge", and reporting it as one would be a lie about a row that is
      // sitting right there; it is a stale target, and the caller above
      // converges on the row that is actually present.
      if (assertedValidFrom && current.deleted_at === undefined) {
        throw new EdgeUpdateTargetMoved(expected.kind, id);
      }
    }
    // The row is gone, or still this edge but tombstoned by a concurrent
    // delete (a non-resurrecting UPDATE carries `deleted_at IS NULL`). Either
    // way the edge this update was for no longer exists to update.
    throw new EdgeNotFoundError(expected.kind, id);
  }
}

/**
 * Internal signal: the edge is still there and still this edge, but the
 * validity bound the update asserted no longer holds.
 *
 * Module-private and never returned to a caller, exactly like
 * {@link EdgeConvergenceRaced}. {@link performEdgeUpdateConverging} is the only
 * code that catches it, and it does so to re-read and re-judge rather than to
 * report anything.
 */
class EdgeUpdateTargetMoved extends Error {
  constructor(kind: string, id: string) {
    super(
      `The ${kind} edge "${id}" was replaced between this update's read and ` +
        `its write; re-resolving it. This is internal and is never returned ` +
        `to a caller.`,
    );
    this.name = "EdgeUpdateTargetMoved";
  }
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
  target: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Edge> {
  for (let attempt = 1; attempt <= EDGE_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      return await performEdgeUpdate(ctx, input, target, options);
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

  return runHookedWriteOperation(ctx, opContext, backend, (target) =>
    performEdgeUpdateConverging(ctx, input, target),
  );
}

/**
 * A cardinality re-check a resurrecting upsert must pass, run INSIDE the write
 * transaction that resurrects.
 *
 * Reviving a tombstone re-admits an edge to the `(kind, from)` / `(kind, from,
 * to)` population cardinality constrains, so it is a constrained write and its
 * probe belongs under the same fence as the UPDATE it authorizes — the callers
 * used to run it against the root backend, outside any transaction, where a
 * concurrent create could land between the verdict and the revival.
 */
type EdgeResurrectCardinality = Readonly<{
  cardinality: Cardinality;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  /** The upper bound the revived row will hold; `oneActive` ignores ended rows. */
  effectiveValidTo: string | undefined;
}>;

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
    resurrectCardinality?: EdgeResurrectCardinality;
  }>,
): Promise<Edge> {
  const resurrectCardinality = options?.resurrectCardinality;
  return runInWriteTransaction(
    ctx,
    backend,
    async (target) => {
      if (resurrectCardinality !== undefined) {
        await checkCardinalityConstraint(
          {
            graphId: ctx.graphId,
            registry: ctx.registry,
            backend: target,
          },
          input.identity.kind,
          resurrectCardinality.cardinality,
          resurrectCardinality.fromKind,
          resurrectCardinality.fromId,
          resurrectCardinality.toKind,
          resurrectCardinality.toId,
          resurrectCardinality.effectiveValidTo,
        );
      }
      return performEdgeUpdateConverging(ctx, input, target, options);
    },
    {
      // An in-place props update re-derives no constraint verdict: endpoints
      // are immutable, so cardinality cannot change under it.
      fencesConstraintProbe:
        resurrectCardinality === undefined ? undefined : (
          edgeWriteNeedsConstraintFence(resurrectCardinality.cardinality)
        ),
    },
  );
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

  return runHookedWriteOperation(ctx, opContext, backend, async (target) => {
    // No in-transaction re-read: the statement carries the expected kind and
    // `deleted_at IS NULL`, so it is its own recheck. A concurrent writer that
    // tombstones this edge, or hard-deletes it and recreates the id under
    // another kind, leaves the DELETE matching zero rows — the same no-op the
    // re-read produced, one round trip cheaper and without the window between
    // a lock-free `getEdge` and a `(graph_id, id)`-keyed write that PostgreSQL
    // READ COMMITTED left open.
    await target.deleteEdge({
      graphId: ctx.graphId,
      id,
      kind: expectedKind,
    });
  });
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
  await runInWriteTransaction(
    ctx,
    backend,
    async (target) => {
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
        await target.deleteEdge({
          graphId: ctx.graphId,
          id,
          kind: expectedKind,
        });
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

  return runHookedWriteOperation(ctx, opContext, backend, async (target) => {
    // No in-transaction re-read: see executeEdgeDelete. The DELETE carries the
    // expected kind, so an id concurrently re-pointed at another kind's edge
    // matches zero rows instead of destroying that other edge.
    await target.hardDeleteEdge({
      graphId: ctx.graphId,
      id,
      kind: expectedKind,
    });
  });
}

// ============================================================
// Get-Or-Create Operations
// ============================================================

const UNDEFINED_SENTINEL = "\u001D";

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

/**
 * Serializes a value for composite key construction.
 * Sorts object keys for deterministic ordering of nested values.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return UNDEFINED_SENTINEL;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const sorted = Object.keys(value).toSorted();
  const entries = sorted.map(
    (key) =>
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Builds a deterministic composite key for edge matching.
 *
 * Endpoints and sorted property-name/value pairs are encoded as one injective
 * string tuple, so legal control characters cannot collapse distinct edges.
 */
function buildEdgeCompositeKey(
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  props: Record<string, unknown>,
  matchOn: readonly string[],
): string {
  const sortedFields = [...matchOn].toSorted();
  return encodeTupleKey([
    fromKind,
    fromId,
    toKind,
    toId,
    ...sortedFields.flatMap((field) => [
      field,
      stableStringify(readOwnProperty(props, field)),
    ]),
  ]);
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
          stableStringify(readOwnProperty(rowProps, field)) ===
          stableStringify(readOwnProperty(inputProps, field)),
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
  const props = options?.props ?? {};

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

  const { liveRow } = findMatchingEdge(candidateRows, matchOn, props);
  return liveRow === undefined ? undefined : rowToEdge(liveRow);
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
  }>,
): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>> {
  const ifExists = options?.ifExists ?? "return";
  const matchOn = options?.matchOn ?? [];

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  // Validate props
  const validatedProps = validateEdgeProps(edgeKind.schema, props, {
    kind,
    operation: "create",
  });

  // Validate matchOn fields
  validateMatchOnFields(edgeKind.schema, matchOn, kind);

  // Validate temporal inputs before the read probe so validity of a call does
  // not depend on whether its endpoint identity already exists. Only the
  // endpoint PAIR can be judged here — the effective lower bound of a lone
  // `validTo` belongs to the row the write leg resolves to, and is checked there.
  const validFrom = validateOptionalCanonicalIsoDate(
    options?.validFrom,
    "validFrom",
  );
  const validTo = validateOptionalCanonicalIsoDate(options?.validTo, "validTo");
  assertOrderedValidityWindow(
    `${kind} edge between ${fromKind} "${fromId}" and ${toKind} "${toId}"`,
    validFrom,
    validTo,
  );

  // Probe outside the transaction: with ifExists "return", the common found
  // path performs no write, so it must not pay for a write transaction
  // (BEGIN IMMEDIATE on SQLite, the per-graph advisory lock under history).
  // The transactional body re-queries, so a concurrent create between this
  // probe and the write lock is still handled correctly.
  if (ifExists === "return") {
    const probeRows = await backend.findEdgesByKind({
      graphId: ctx.graphId,
      kind,
      fromKind,
      fromId,
      toKind,
      toId,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
    });
    const { liveRow: probedLiveRow } = findMatchingEdge(
      probeRows,
      matchOn,
      validatedProps,
    );
    if (probedLiveRow !== undefined) {
      return { edge: rowToEdge(probedLiveRow), action: "found" };
    }
  }

  // No enclosing transaction: each write leg opens its own (hooked, for the
  // create leg) transaction. An outer transaction here would make the nested
  // operation run directly inside it and fire its success hooks before THIS
  // wrapper's COMMIT — the durability contract hooks promise would be false.
  //
  // The lookup below is therefore only a DISPATCHER: it chooses a leg, and the
  // two legs that DERIVE a verdict re-derive it under the per-graph fence their
  // transaction holds. The create leg re-runs this very lookup inside that
  // transaction (`convergeOn`) and aborts rather than inserting a second edge
  // for a match key a competitor just claimed; the resurrect leg re-checks
  // cardinality in-transaction. The `found` leg writes nothing and derives
  // nothing, and the `updated` leg writes to an id it resolved here — its
  // in-transaction re-read and its endpoint-predicated UPDATE are what make
  // that write land on the row this lookup meant, not a re-derivation of the
  // dispatcher's choice.
  async function attempt(): Promise<
    Readonly<{ edge: Edge; action: GetOrCreateAction }>
  > {
    // Query all edges of this kind between (from, to) including tombstones
    const candidateRows = await backend.findEdgesByKind({
      graphId: ctx.graphId,
      kind,
      fromKind,
      fromId,
      toKind,
      toId,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
    });

    const { liveRow, deletedRow } = findMatchingEdge(
      candidateRows,
      matchOn,
      validatedProps,
    );

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
      const created = await executeEdgeCreateInternal(ctx, input, backend, {
        returnRow: true,
        convergeOn: { matchOn, props: validatedProps },
      });
      if (created === undefined) {
        throw new DatabaseOperationError(
          "Edge create failed: expected created edge row",
          { operation: "insert", entity: "edge" },
        );
      }
      return { edge: created, action: "created" };
    }

    // Live match found
    if (liveRow !== undefined) {
      if (ifExists === "return") {
        return { edge: rowToEdge(liveRow), action: "found" };
      }
      // ifExists === "update". `validFrom` is forwarded even though an in-place
      // update stores no lower bound: the shared write guard is what judges it,
      // refusing a bound that differs from the one the live row holds instead of
      // dropping it here where the caller would never hear about it.
      const edge = await executeEdgeUpsertUpdate(
        ctx,
        {
          id: liveRow.id,
          identity: { kind, fromKind, fromId, toKind, toId },
          props: validatedProps,
          ...(validFrom !== undefined && { validFrom }),
          ...(validTo !== undefined && { validTo }),
        },
        backend,
      );
      return { edge, action: "updated" };
    }

    // Deleted match only → resurrect, re-checking cardinality INSIDE the
    // resurrecting transaction (see EdgeResurrectCardinality): the verdict and
    // the revival it authorizes then share the fence.
    const cardinality = registration.cardinality ?? "many";
    if (deletedRow === undefined) {
      throw new Error("Expected deletedRow to be defined");
    }
    const matchedDeletedRow = deletedRow;
    const effectiveValidTo = validTo ?? matchedDeletedRow.valid_to;

    // A resurrection forwards `validFrom` as the create leg does: naming it
    // restates the revived row's WHOLE window (the backend rewrites both
    // endpoints together), which is the only way to revive a row into a window
    // that closed before the row originally began. Dropping it here silently
    // ignored a stated lower bound and left the caller no way to satisfy the
    // window-ordering guard.
    const edge = await executeEdgeUpsertUpdate(
      ctx,
      {
        id: matchedDeletedRow.id,
        identity: { kind, fromKind, fromId, toKind, toId },
        props: validatedProps,
        ...(validFrom !== undefined && { validFrom }),
        ...(validTo !== undefined && { validTo }),
      },
      backend,
      {
        clearDeleted: true,
        resurrectCardinality: {
          cardinality,
          fromKind,
          fromId,
          toKind,
          toId,
          effectiveValidTo,
        },
      },
    );
    return { edge, action: "resurrected" };
  }

  // Convergence loop. Under the fence a losing writer learns about the winner
  // from its own in-transaction lookup ({@link EdgeConvergenceRaced}) rather
  // than from a constraint violation, so the ordinary path is one re-dispatch
  // that finds the winner's edge. The `CardinalityError` arm remains the
  // backstop for the paths the fence cannot cover — a competitor whose write is
  // not a `getOrCreateByEndpoints` at all.
  //
  // ATTEMPT_LIMIT bounds a pathological ping-pong (a competitor that creates
  // and hard-deletes the same match key repeatedly) rather than spinning; the
  // last attempt would otherwise be indistinguishable from a livelock. On the
  // FINAL attempt a retryable signal is no longer retryable, so it is reported:
  // a `CardinalityError` as itself (the caller's own constraint is what failed),
  // and an exhausted convergence race as the terminal error below, which names
  // the interference rather than leaking an internal signal.
  const ATTEMPT_LIMIT = 3;
  for (let remaining = ATTEMPT_LIMIT; remaining > 0; remaining -= 1) {
    try {
      return await attempt();
    } catch (error) {
      const retryable =
        error instanceof CardinalityError ||
        error instanceof EdgeConvergenceRaced;
      if (!retryable || remaining === 1) {
        if (!(error instanceof EdgeConvergenceRaced)) throw error;
        throw new DatabaseOperationError(
          `getOrCreateByEndpoints for ${kind} between ${fromKind} "${fromId}" ` +
            `and ${toKind} "${toId}" lost its match key to a competing writer ` +
            `${String(ATTEMPT_LIMIT)} times without converging. A concurrent ` +
            `writer is repeatedly creating and removing this edge; serialize ` +
            `those callers or retry the operation.`,
          { operation: "insert", entity: "edge" },
          { cause: error },
        );
      }
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
  }>[],
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{
    matchOn?: readonly string[];
    ifExists?: IfExistsMode;
  }>,
): Promise<Readonly<{ edge: Edge; action: GetOrCreateAction }>[]> {
  if (items.length === 0) return [];

  const ifExists = options?.ifExists ?? "return";
  const matchOn = options?.matchOn ?? [];

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;
  const cardinality = registration.cardinality ?? "many";

  // Validate matchOn fields once
  validateMatchOnFields(edgeKind.schema, matchOn, kind);

  // Step 1: Validate all props and compute composite keys
  const validated: {
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    validatedProps: Record<string, unknown>;
    compositeKey: string;
    endpointKey: string;
    validFrom?: string;
    validTo?: string;
  }[] = [];

  for (const item of items) {
    const validatedProps = validateEdgeProps(edgeKind.schema, item.props, {
      kind,
      operation: "create",
    });
    const validFrom = validateOptionalCanonicalIsoDate(
      item.validFrom,
      "validFrom",
    );
    const validTo = validateOptionalCanonicalIsoDate(item.validTo, "validTo");
    // As in the single-item path: the endpoint pair is judged up front so a
    // batch's validity does not depend on which items already exist.
    assertOrderedValidityWindow(
      `${kind} edge between ${item.fromKind} "${item.fromId}" and ${item.toKind} "${item.toId}"`,
      validFrom,
      validTo,
    );

    const compositeKey = buildEdgeCompositeKey(
      item.fromKind,
      item.fromId,
      item.toKind,
      item.toId,
      validatedProps,
      matchOn,
    );
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
      compositeKey,
      endpointKey,
      ...(validFrom !== undefined && { validFrom }),
      ...(validTo !== undefined && { validTo }),
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
        duplicateOf.push({ index, sourceIndex: previousIndex });
        continue;
      }
      seenKeys.set(entry.compositeKey, index);

      const candidateRows = rowsByEndpoint.get(entry.endpointKey) ?? [];
      const { liveRow, deletedRow } = findMatchingEdge(
        candidateRows,
        matchOn,
        entry.validatedProps,
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
  function runBatch(): Promise<Result[]> {
    return runInWriteTransaction(
      ctx,
      backend,
      async (target) => {
        const { toCreate, toFetch, duplicateOf } = partitionEntries(
          await fetchRowsByEndpoint(target),
        );
        const results: Result[] = Array.from({ length: items.length });

        // Step 4: Execute creates in batch
        if (toCreate.length > 0) {
          const createInputs = toCreate.map((entry) => entry.input);
          const createdEdges = await executeEdgeCreateBatch(
            ctx,
            createInputs,
            target,
          );
          for (const [batchIndex, entry] of toCreate.entries()) {
            results[entry.index] = {
              edge: requireDefined(createdEdges[batchIndex]),
              action: "created",
            };
          }
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
              },
              target,
              {
                clearDeleted: true,
                resurrectCardinality: {
                  cardinality,
                  fromKind: entry.fromKind,
                  fromId: entry.fromId,
                  toKind: entry.toKind,
                  toId: entry.toId,
                  effectiveValidTo: entry.validTo ?? entry.row.valid_to,
                },
              },
            );
            results[entry.index] = { edge, action: "resurrected" };
          } else if (ifExists === "update") {
            // As in the single-item path: `validFrom` is forwarded so the
            // shared write guard refuses a bound the in-place update cannot
            // store, rather than dropping it silently here.
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
              },
              target,
            );
            results[entry.index] = { edge, action: "updated" };
          } else {
            results[entry.index] = {
              edge: rowToEdge(entry.row),
              action: "found",
            };
          }
        }

        // Step 6: Resolve within-batch duplicates
        for (const { index, sourceIndex } of duplicateOf) {
          const sourceResult = requireDefined(results[sourceIndex]);
          results[index] = { edge: sourceResult.edge, action: "found" };
        }

        return results;
      },
      // A bulk getOrCreate always converges on a match key no database key
      // backs, whatever its cardinality — the same reason the single-item path
      // fences unconditionally.
      { fencesConstraintProbe: "edgeMatchKeyConvergence" },
    );
  }

  // The single-item path's `CardinalityError` retry, which this path lacked: a
  // competing winner failed the WHOLE batch instead of converging. With the
  // fence the batch's own lookup sees the winner, so this is the backstop for
  // the paths the fence cannot cover (a non-transactional backend, or a
  // competitor that is not a `getOrCreateByEndpoints`) — one retry, matching
  // the single-item path rather than inventing a second policy.
  try {
    return await runBatch();
  } catch (error) {
    if (!(error instanceof CardinalityError)) throw error;
    return runBatch();
  }
}
