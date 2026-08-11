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
import {
  type ClaimEdgeCardinalityParams,
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
  ConfigurationError,
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
  preservesImmutableLowerBound,
  validateOptionalCanonicalIsoDate,
} from "../../utils/date";
import { generateId } from "../../utils/id";
import { hasOwnKey, readOwnProperty } from "../../utils/object";
import { requireDefined } from "../../utils/presence";
import { encodeTupleKey } from "../../utils/tuple-key";
import { edgeCardinalityClaim } from "../claims/edge-claims";
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
import { runHookedWritePlan, runWritePlan } from "./write-executor";
import {
  assertsStoredWindowState,
  type EdgeUpdateFences,
} from "./write-fences";
import { edgeWritePlan } from "./write-plan";
import {
  type EdgeInsertWork,
  unfencedTarget,
  type WriteSession,
  type WriteTarget,
} from "./write-session";

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
    ...(claim === undefined ? {} : { claim }),
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

async function validateAndPrepareEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  id: string,
  backend: WriteTarget,
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

  return runHookedWritePlan(
    ctx,
    opContext,
    // A create that runs a cardinality probe, or one converging on a match
    // key, decides something the write must not have invalidated. A plain
    // `many` create decides nothing and takes no lock.
    edgeWritePlan(
      convergeOn === undefined ?
        edgeWriteNeedsConstraintFence(edgeCardinality(ctx, kind))
      : "edgeMatchKeyConvergence",
    ),
    backend,
    async (session, target): Promise<Edge | undefined> => {
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

      return row === undefined ? undefined : rowToEdge(row);
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
  backend: WriteTarget,
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
  session: WriteSession,
  target: WriteTarget,
  options?: Readonly<{ clearDeleted?: boolean }>,
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
  session: WriteSession,
  target: WriteTarget,
  options?: Readonly<{ clearDeleted?: boolean }>,
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
          options.coalesceCandidate ??
          (await target.getEdge(ctx.graphId, input.id));
        if (existing !== undefined && existing.deleted_at === undefined) {
          assertEdgeIdentityMatches(
            input.id,
            input.identity,
            edgeIdentityFromRow(existing),
            "update",
          );
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
  options?: Readonly<{ clearDeleted?: boolean }>,
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
  const matchOn = options?.matchOn ?? [];

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

  assertValidityEndMutation(options ?? {}, { entityType: "edge", kind });
  if (options?.clearValidTo === true) {
    assertClearValidToSupported(backend, "edge");
  }

  // Validate props
  const validatedProps = validateEdgeProps(edgeKind.schema, props, {
    kind,
    operation: "create",
  });

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
      assertEndpointClearCanApply(ifExists, options?.clearValidTo, kind);
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
        assertEndpointClearCanApply(ifExists, options?.clearValidTo, kind);
        return { edge: rowToEdge(liveRow), action: "found" };
      }
      // ifExists === "update". `validFrom` is forwarded even though an in-place
      // update stores no lower bound: the shared write guard is what judges it,
      // refusing a bound that differs from the one the live row holds instead of
      // dropping it here where the caller would never hear about it.
      const outcome = await executeEdgeUpsertUpdateWithOutcome(
        ctx,
        {
          id: liveRow.id,
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
            shouldCoalesceUpsert(liveRow, options, () =>
              edgeUpsertDirtyCheck(
                ctx,
                liveRow.kind,
                liveRow.id,
                rowPropsToObject(liveRow.props),
                validatedProps,
              ),
            ),
        },
      );
      return {
        edge: outcome.edge,
        action: outcome.wrote ? "updated" : "found",
      };
    }

    // Deleted match only → resurrect. The shared update path derives the
    // resulting live/active state and re-checks cardinality under the same
    // transaction fence as the revival it authorizes.
    if (deletedRow === undefined) {
      throw new Error("Expected deletedRow to be defined");
    }
    const matchedDeletedRow = deletedRow;

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
        ...(options?.clearValidTo === true && {
          clearValidTo: true as const,
        }),
        ...(options?.onImmutableLowerBound !== undefined && {
          onImmutableLowerBound: options.onImmutableLowerBound,
        }),
      },
      backend,
      { clearDeleted: true },
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
  const matchOn = options?.matchOn ?? [];

  const registration = getEdgeRegistration(ctx.graph, kind);
  const edgeKind = registration.type;

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
      async (session, target) => {
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
        const rawTarget = unfencedTarget(target);
        const { toCreate, toFetch, duplicateOf } = partitionEntries(
          await fetchRowsByEndpoint(target),
        );
        const results: Result[] = Array.from({ length: items.length });
        let writes = 0;

        // Step 4: Execute creates in batch
        if (toCreate.length > 0) {
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
