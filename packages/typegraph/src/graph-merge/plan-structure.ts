/**
 * Plan-time structural conflicts: refusals a resolved merge plan is certain to
 * meet at apply, raised while the plan is built so `planMerge()` never returns
 * a plan that cannot be applied.
 *
 * A plan is fenced by the target's revision: apply refuses it as stale after
 * any intervening target write. A conflict that the plan's own writes produce
 * against the target's CURRENT rows is therefore not a race the apply might
 * win — the unchanged target refuses it, and the only target write that could
 * resolve it makes the plan stale. Each check here asks the store's own
 * decision about the post-plan state (the claim set an edge write takes, the
 * delete-behavior verdict a node delete reaches, the acyclicity probe) rather
 * than spelling a second copy of it, and turns the refusal that decision
 * would raise into a typed merge conflict.
 *
 * Every check is a {@link PlanStructuralCheck} over one shared
 * {@link PlanStructure}: adding a structural conflict kind is one more function
 * in the planner's check list. Apply still re-verifies every one of them
 * inside its own transaction; these are previews of certain refusals, never
 * the write gate.
 */
import { RestrictedDeleteError } from "../errors";
import { nowIso } from "../utils/date";
import { hasOwnKey } from "../utils/object";
import { requireDefined } from "../utils/presence";
import {
  AcyclicityMergeConflictError,
  CardinalityMergeConflictError,
  CompositionWindowMergeConflictError,
  type MergeConflictEdge,
  MergeError,
  RestrictedDeleteMergeConflictError,
} from "./errors";
import { type MergeKey, mergeKey } from "./node-key";
import type { MergePlanEdgeUpsert, MergePlanWrites } from "./plan-schema";
import {
  acyclicEdgeRelations,
  batchPointReadVerdict,
  type ClaimEdgeCardinalityParams,
  claimRefusalFor,
  claimsInProbeOrder,
  compareCodePoints,
  compositionWindowOverlapError,
  type CompositionWindowTransition,
  createSqlSchema,
  type EdgeAcyclicityViolation,
  edgeCardinalityClaimTarget,
  edgeInsertClaims,
  edgeKindCardinalityDeclarations,
  edgeKindIsInAcyclicRelation,
  edgeKindOwesAnyClaim,
  type EdgeRow,
  getDialect,
  getEdgeRowsByIds,
  type GraphDef,
  type InsertEdgeParams,
  judgeNodeDeleteBehavior,
  type NodeDeletePolicy,
  type ProposedRelationEdge,
  readCompositionWindowConflict,
  readProposedEdgeAcyclicityViolations,
  type Store,
  storeBackend,
  targetIdentity,
} from "./typegraph-internal";

/**
 * The delete policy every merge node delete runs under: delete behavior is
 * enforced, so a `restrict` edge still refuses, while composition parts are
 * left to the plan, which enumerates every one a composition delete would
 * cascade to. Shared by the apply's node deletes and the plan-time
 * {@link restrictedDeleteConflict}, so both reach one verdict.
 */
export const MERGE_NODE_DELETE_POLICY = {
  enforceDeleteBehavior: true,
  cascadeComposition: false,
} as const satisfies NodeDeletePolicy;

/**
 * The node deletes a merge apply runs, in its order: the plan's node
 * deletions, then the delete half of every recreation (an upsert that deletes
 * the live node before writing it again). Both run under
 * {@link MERGE_NODE_DELETE_POLICY}, so each can be refused by its node's
 * delete behavior. The apply's node phase and the plan-time
 * {@link restrictedDeleteConflict} both walk this one sequence.
 */
export function mergeNodeDeleteSequence<
  Ref extends Readonly<{ kind: string; id: string }>,
>(
  deletions: readonly Ref[],
  upserts: readonly (Ref & Readonly<{ recreate?: true | undefined }>)[],
): readonly Ref[] {
  return [
    ...deletions,
    ...upserts.filter((upsert) => upsert.recreate === true),
  ];
}

/** Whether a write states its own end of validity — an instant or an explicit reopening — rather than keeping the stored row's. */
export function statesValidityEnd(
  write: Readonly<{
    validTo?: string | undefined;
    clearValidTo?: boolean | undefined;
  }>,
): boolean {
  return write.validTo !== undefined || write.clearValidTo === true;
}

/**
 * One constrained edge upsert as the row it leaves: its final endpoints and
 * its window, beside the stored row it replaces.
 */
type PlannedEdgeRow = ProposedRelationEdge &
  Readonly<{
    /**
     * The lower bound the row is left with. An in-place update never moves a
     * stored lower bound, so it keeps the stored row's; an insert or a
     * resurrection leaves the one it states — `null` an explicit unbounded
     * start, `undefined` the instant the write itself stamps — or, for a
     * resurrection that states none, the stored row's.
     */
    validFrom: string | null | undefined;
    /** The stored row this write replaces; absent when the plan inserts it. */
    stored: EdgeRow | undefined;
  }>;

/**
 * What every structural check reads: the plan's normalized write view, its
 * constrained edge writes as the rows they leave, and the target's current
 * rows through one cached reader.
 */
export type PlanStructure<G extends GraphDef> = Readonly<{
  target: Store<G>;
  writes: MergePlanWrites;
  /**
   * Every edge upsert of a kind some structural rule constrains (an acyclic
   * relation or a claim), at its FINAL endpoints and with the window it
   * leaves on its row: the end the write states, or the stored row's when it
   * states none (a row the target does not hold yet is born open), and the
   * lower bound {@link PlannedEdgeRow.validFrom} describes.
   */
  edgeRows: readonly PlannedEdgeRow[];
  /** The stored rows the plan's edge deletes remove, for a constrained kind. */
  deletedEdgeRows: readonly EdgeRow[];
  /** Edge ids whose stored state the plan removes or replaces. */
  supersededEdgeIds: ReadonlySet<string>;
  /**
   * Nodes the apply deletes — the plan's deletions and the delete half of its
   * recreations ({@link mergeNodeDeleteSequence}). A stored edge incident to
   * one leaves with it: its delete removes the edge, or refuses, which
   * {@link restrictedDeleteConflict} reports.
   */
  deletedNodes: ReadonlySet<MergeKey>;
  /** The target's live edges incident to one node, read once per node. */
  connectedEdges: (kind: string, id: string) => Promise<readonly EdgeRow[]>;
}>;

/** One structural rule: the conflict the plan would meet at apply, if any. */
export type PlanStructuralCheck = <G extends GraphDef>(
  structure: PlanStructure<G>,
) => Promise<MergeError | undefined>;

/**
 * Runs `checks` in order over the plan's structure and throws the first
 * conflict any of them finds.
 */
export async function assertPlanStructurallySound<G extends GraphDef>(
  target: Store<G>,
  writes: MergePlanWrites,
  checks: readonly PlanStructuralCheck[],
): Promise<void> {
  const structure = await capturePlanStructure(target, writes);
  for (const check of checks) {
    const conflict = await check(structure);
    if (conflict !== undefined) throw conflict;
  }
}

async function capturePlanStructure<G extends GraphDef>(
  target: Store<G>,
  writes: MergePlanWrites,
): Promise<PlanStructure<G>> {
  const backend = storeBackend(target);
  const constrained = writes.edgeUpserts.filter((upsert) =>
    edgeKindIsStructurallyConstrained(target, upsert.kind),
  );
  const constrainedDeletes = writes.edgeDeletes.filter((deletion) =>
    edgeKindIsStructurallyConstrained(target, deletion.kind),
  );
  const storedRows = await getEdgeRowsByIds(
    backend,
    batchPointReadVerdict(backend),
    target.graphId,
    [
      ...constrained.map((upsert) => upsert.id),
      ...constrainedDeletes.map((deletion) => deletion.id),
    ],
  );
  const connected = new Map<MergeKey, readonly EdgeRow[]>();
  return {
    target,
    writes,
    edgeRows: constrained.map((upsert) =>
      plannedEdgeRow(upsert, storedRows.get(upsert.id)),
    ),
    deletedEdgeRows: constrainedDeletes.flatMap((deletion) => {
      const stored = storedRows.get(deletion.id);
      return stored === undefined ? [] : [stored];
    }),
    supersededEdgeIds: new Set([
      ...writes.edgeDeletes.map((deletion) => deletion.id),
      ...writes.edgeUpserts.map((upsert) => upsert.id),
    ]),
    deletedNodes: new Set(
      mergeNodeDeleteSequence(writes.nodeDeletes, writes.nodeUpserts).map(
        (deletion) => mergeKey(deletion.kind, deletion.id),
      ),
    ),
    connectedEdges: async (kind, id) => {
      const key = mergeKey(kind, id);
      const cached = connected.get(key);
      if (cached !== undefined) return cached;
      const rows = await backend.findEdgesConnectedTo({
        graphId: target.graphId,
        nodeKind: kind,
        nodeId: id,
      });
      connected.set(key, rows);
      return rows;
    },
  };
}

function edgeKindIsStructurallyConstrained<G extends GraphDef>(
  target: Store<G>,
  edgeKind: string,
): boolean {
  return (
    edgeKindIsInAcyclicRelation(target.graph, target.registry, edgeKind) ||
    edgeKindOwesAnyClaim(
      target.registry,
      edgeKindCardinalityDeclarations(target.graph, edgeKind),
      edgeKind,
    )
  );
}

function plannedEdgeRow(
  upsert: MergePlanEdgeUpsert,
  stored: EdgeRow | undefined,
): PlannedEdgeRow {
  const appliesStatedValidFrom =
    stored === undefined || stored.deleted_at !== undefined;
  return {
    edgeId: upsert.id,
    edgeKind: upsert.kind,
    fromKind: upsert.from.kind,
    fromId: upsert.from.id,
    toKind: upsert.to.kind,
    toId: upsert.to.id,
    validTo: statesValidityEnd(upsert) ? upsert.validTo : stored?.valid_to,
    validFrom:
      appliesStatedValidFrom && upsert.validFrom !== undefined ?
        upsert.validFrom
      : stored?.valid_from,
    stored,
  };
}

function storedEdgeRow(row: EdgeRow): ProposedRelationEdge {
  return {
    edgeId: row.id,
    edgeKind: row.kind,
    fromKind: row.from_kind,
    fromId: row.from_id,
    toKind: row.to_kind,
    toId: row.to_id,
    validTo: row.valid_to,
  };
}

function conflictEdge(row: ProposedRelationEdge): MergeConflictEdge {
  return {
    edgeId: row.edgeId,
    edgeKind: row.edgeKind,
    fromKind: row.fromKind,
    fromId: row.fromId,
    toKind: row.toKind,
    toId: row.toId,
  };
}

/**
 * Does the plan's edge writes — layered onto the target's current live edges,
 * less the edges the same plan deletes or rewrites — close a cycle in a
 * declared-acyclic relation. Apply removes those edges before it writes, so a
 * reversal or re-rooting inside the relation is judged by the DAG it
 * produces, not by rows that will be gone.
 *
 * Lock-free (`readProposedEdgeAcyclicityViolations`): the commit re-verifies
 * under the per-graph write lock and stays the sole authority.
 */
export async function acyclicityConflict<G extends GraphDef>(
  structure: PlanStructure<G>,
): Promise<MergeError | undefined> {
  const { target } = structure;
  if (acyclicEdgeRelations(target.graph, target.registry).length === 0) {
    return undefined;
  }
  const proposed = structure.edgeRows.filter((row) =>
    edgeKindIsInAcyclicRelation(target.graph, target.registry, row.edgeKind),
  );
  if (proposed.length === 0) return undefined;

  const backend = storeBackend(target);
  const violations = await readProposedEdgeAcyclicityViolations(
    {
      graphId: target.graphId,
      registry: target.registry,
      schema: createSqlSchema(backend.tableNames),
      dialect: getDialect(backend.dialect),
      target: backend,
      operation: "mergePlanAcyclicity",
    },
    target.graph,
    proposed,
    // Every stored row the plan rewrites is replaced by its proposed state
    // (or dropped, when that state is no member), and every row it deletes is
    // gone: the walk judges the relation the plan produces.
    [
      ...structure.writes.edgeDeletes.map((deletion) => deletion.id),
      ...proposed.map((edge) => edge.edgeId),
    ],
  );
  if (violations.length === 0) return undefined;
  return acyclicityMergeConflict(
    violations,
    new Map(proposed.map((edge) => [edge.edgeId, edge] as const)),
  );
}

/**
 * Builds the typed conflict from the first violated relation. A plan can
 * violate several relations at once (for example when composition relations
 * overlap), so every other violated relation is named in
 * `details.additionalRelations` without complicating the primary message.
 */
function acyclicityMergeConflict(
  violations: readonly EdgeAcyclicityViolation[],
  proposedById: ReadonlyMap<string, ProposedRelationEdge>,
): AcyclicityMergeConflictError {
  const [firstViolation, ...remaining] = violations;
  if (firstViolation === undefined) {
    throw new MergeError(
      "acyclicityMergeConflict called with no violations — this is a defect in the caller, not a real conflict.",
    );
  }
  const edges = firstViolation.edgeIds.map((edgeId) =>
    conflictEdge(requireDefined(proposedById.get(edgeId))),
  );
  const describedEdges = edges
    .map(
      (edge) =>
        `${edge.edgeKind} ${edge.fromKind}:${edge.fromId} -> ${edge.toKind}:${edge.toId}`,
    )
    .join(", ");
  return new AcyclicityMergeConflictError(
    `The merge plan would close a cycle in acyclic relation "${firstViolation.relation}": ${describedEdges}.`,
    {
      details: {
        relation: firstViolation.relation,
        edges,
        ...(remaining.length === 0 ?
          {}
        : {
            additionalRelations: remaining.map((violation) => ({
              relation: violation.relation,
              edgeIds: violation.edgeIds,
            })),
          }),
      },
    },
  );
}

/**
 * Whether the plan leaves two live edges holding one claim: a part's one
 * whole across every composition edge kind, or one declared `cardinality` /
 * `targetCardinality` slot. The claims are the ones each edge row takes in
 * the state the plan leaves it in ({@link edgeInsertClaims} — the claim set
 * every store edge write takes, with its born-ended and active-only
 * exemptions), compared by the claim row they reserve
 * ({@link edgeCardinalityClaimTarget}), which is the store's own fence: two
 * holders of one claim row is what the store refuses.
 *
 * The incumbent is the target row the plan leaves in place, or else the
 * plan's earlier row in edge-id order. A target row the plan deletes or
 * rewrites is judged in its planned state, and one incident to a node the
 * plan deletes leaves with that node (or the delete refuses, which
 * {@link restrictedDeleteConflict} reports). Rows are visited in edge-id
 * order and each row's claims in the store's probe order (composition first),
 * so the conflict named does not depend on branch order.
 */
export async function edgeClaimConflict<G extends GraphDef>(
  structure: PlanStructure<G>,
): Promise<MergeError | undefined> {
  const plannedHolders = new Map<string, ProposedRelationEdge>();
  const rows = structure.edgeRows.toSorted((left, right) =>
    compareCodePoints(left.edgeId, right.edgeId),
  );
  for (const row of rows) {
    for (const claim of claimsInProbeOrder(rowClaims(structure, row))) {
      const claimKey = claimIdentity(claim);
      const incumbent =
        (await storedClaimHolder(structure, claim, claimKey)) ??
        plannedHolders.get(claimKey);
      if (incumbent !== undefined) {
        return new CardinalityMergeConflictError(
          claimRefusalFor(claim, incumbent.edgeId),
          [conflictEdge(incumbent), conflictEdge(row)],
        );
      }
      plannedHolders.set(claimKey, row);
    }
  }
  return undefined;
}

function rowClaims<G extends GraphDef>(
  structure: PlanStructure<G>,
  row: ProposedRelationEdge,
): readonly ClaimEdgeCardinalityParams[] {
  const { target } = structure;
  return edgeInsertClaims(
    target.registry,
    edgeKindCardinalityDeclarations(target.graph, row.edgeKind),
    {
      graphId: target.graphId,
      id: row.edgeId,
      kind: row.edgeKind,
      fromKind: row.fromKind,
      fromId: row.fromId,
      toKind: row.toKind,
      toId: row.toId,
      ...(row.validTo === undefined ? {} : { validTo: row.validTo }),
    },
  );
}

function claimIdentity(claim: ClaimEdgeCardinalityParams): string {
  return targetIdentity(edgeCardinalityClaimTarget(claim));
}

/**
 * The target row the plan leaves in place that holds the same claim row as
 * `claim`, lowest edge id first. A claim's key always includes the endpoint
 * on its `direction` side — the source for a source axis (and the pair a
 * `unique` axis keys on), the target for a target axis, the part for a
 * composition claim — so that endpoint's incident edges are every candidate.
 */
async function storedClaimHolder<G extends GraphDef>(
  structure: PlanStructure<G>,
  claim: ClaimEdgeCardinalityParams,
  claimKey: string,
): Promise<ProposedRelationEdge | undefined> {
  const [kind, id] =
    claim.direction === "source" ?
      [claim.fromKind, claim.fromId]
    : [claim.toKind, claim.toId];
  const holders = (await structure.connectedEdges(kind, id))
    .filter(
      (row) =>
        !structure.supersededEdgeIds.has(row.id) &&
        !structure.deletedNodes.has(mergeKey(row.from_kind, row.from_id)) &&
        !structure.deletedNodes.has(mergeKey(row.to_kind, row.to_id)),
    )
    .map((row) => storedEdgeRow(row))
    .filter((row) =>
      rowClaims(structure, row).some(
        (held) => claimIdentity(held) === claimKey,
      ),
    )
    .toSorted((left, right) => compareCodePoints(left.edgeId, right.edgeId));
  return holders[0];
}

/**
 * Whether a node the apply deletes would be refused by its own delete
 * behavior: an `onDelete: "restrict"` node (the default) that keeps a
 * non-composition edge the plan does not delete. Every node delete counts —
 * a plan deletion and the delete half of a recreation alike
 * ({@link mergeNodeDeleteSequence}). The verdict is the store's
 * ({@link judgeNodeDeleteBehavior}), reached in the apply's order — the plan's
 * edge deletes land first, and every earlier node delete's `cascade` /
 * `disconnect` removals are consumed before the next node is judged — under
 * the apply's own {@link MERGE_NODE_DELETE_POLICY}.
 */
export async function restrictedDeleteConflict<G extends GraphDef>(
  structure: PlanStructure<G>,
): Promise<MergeError | undefined> {
  const { target } = structure;
  const consumedEdgeIds = new Set(
    structure.writes.edgeDeletes.map((deletion) => deletion.id),
  );
  const connectedEdgesReader = {
    findEdgesConnectedTo: (
      params: Readonly<{ nodeKind: string; nodeId: string }>,
    ) => structure.connectedEdges(params.nodeKind, params.nodeId),
  };
  for (const deletion of mergeNodeDeleteSequence(
    structure.writes.nodeDeletes,
    structure.writes.nodeUpserts,
  )) {
    try {
      const verdict = await judgeNodeDeleteBehavior(
        { graphId: target.graphId, registry: target.registry },
        {
          kind: deletion.kind,
          id: deletion.id,
          onDelete:
            hasOwnKey(target.graph.nodes, deletion.kind) ?
              target.graph.nodes[deletion.kind]?.onDelete
            : undefined,
        },
        connectedEdgesReader,
        { ...MERGE_NODE_DELETE_POLICY, consumedEdgeIds },
      );
      for (const edgeId of verdict.removedEdgeIds) consumedEdgeIds.add(edgeId);
    } catch (error) {
      if (error instanceof RestrictedDeleteError) {
        return new RestrictedDeleteMergeConflictError(error);
      }
      throw error;
    }
  }
  return undefined;
}

/**
 * Whether the plan leaves one part of a `population: "oneActive"` pair with
 * two composition windows that share an instant — history two sides
 * contributed, or a side's history overlapping the target's. The verdict is
 * the composition lane's own ({@link readCompositionWindowConflict}), given
 * every composition-row write of the plan in ONE call so it judges the state
 * the plan leaves: each upsert as an insert or a revision of its stored row,
 * each edge delete as a revision whose row is deleted. The refusal carries
 * the store's own `CompositionError` (`"windowOverlap"`) as its `cause`.
 */
export async function compositionWindowConflict<G extends GraphDef>(
  structure: PlanStructure<G>,
): Promise<MergeError | undefined> {
  const { target } = structure;
  const { registry } = target;
  const inserts: InsertEdgeParams[] = [];
  const revisions: CompositionWindowTransition[] = [];
  for (const row of structure.edgeRows) {
    if (!registry.isCompositionEdge(row.edgeKind)) continue;
    if (row.stored === undefined) {
      inserts.push({
        graphId: target.graphId,
        id: row.edgeId,
        kind: row.edgeKind,
        fromKind: row.fromKind,
        fromId: row.fromId,
        toKind: row.toKind,
        toId: row.toId,
        props: {},
        ...(row.validFrom === undefined ? {} : { validFrom: row.validFrom }),
        ...(row.validTo === undefined ? {} : { validTo: row.validTo }),
      });
      continue;
    }
    revisions.push({
      before: row.stored,
      after: {
        id: row.edgeId,
        kind: row.edgeKind,
        from_kind: row.fromKind,
        from_id: row.fromId,
        to_kind: row.toKind,
        to_id: row.toId,
        valid_from: row.validFrom ?? undefined,
        valid_to: row.validTo,
        deleted_at: undefined,
      },
    });
  }
  const operationInstant = nowIso();
  for (const stored of structure.deletedEdgeRows) {
    if (!registry.isCompositionEdge(stored.kind)) continue;
    revisions.push({
      before: stored,
      after: { ...stored, deleted_at: stored.deleted_at ?? operationInstant },
    });
  }
  if (inserts.length === 0 && revisions.length === 0) return undefined;
  const conflict = await readCompositionWindowConflict(
    registry,
    storeBackend(target),
    target.graphId,
    { inserts, revisions },
    { operationInstant },
  );
  if (conflict === undefined) return undefined;
  return new CompositionWindowMergeConflictError(
    compositionWindowOverlapError(registry, conflict),
    [conflict.incumbent, conflict.proposed].map((edge) => ({
      edgeId: edge.id,
      edgeKind: edge.kind,
      fromKind: edge.from_kind,
      fromId: edge.from_id,
      toKind: edge.to_kind,
      toId: edge.to_id,
    })),
  );
}
