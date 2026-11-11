/**
 * Constraint Checking for Store Operations
 *
 * Handles checking disjointness and cardinality constraints.
 *
 * ## The invariant these probes depend on
 *
 * **A declared constraint's probe and the write it guards commit under one
 * per-graph mutual exclusion, on every backend.** Every check in this module is
 * an APPLICATION probe: it reads, decides, and returns, and the caller then
 * writes. Nothing in the schema re-decides at write time, because for each of
 * these constraints the available key covers a different axis than the
 * constraint declares:
 *
 * - edge cardinality `one` / `unique` / `oneActive` is a predicate over
 *   `(kind, from)` or `(kind, from, to)`, while the edges table's only
 *   uniqueness is its `(graph_id, id)` primary key;
 * - disjointness is a predicate over `(graph_id, id)` ACROSS kinds, while the
 *   nodes primary key is `(graph_id, kind, id)` — the same id under a disjoint
 *   kind is a different row by construction;
 * - `scope: "kindWithSubClasses"` uniqueness probes the root kind and every
 *   descendant. Its claim is now reserved at the scope's AXIS — the subclass
 *   component's minimum — so sibling kinds contend for one row and the uniques
 *   primary key does fence them (see {@link file://./claims/node-claims.ts});
 *   the lock is kept because the probe still reads kinds the key does not
 *   cover, including rows written before the axis existed.
 *
 * So the probe is only as good as the serialization around it. SQLite supplies
 * that for free (`BEGIN IMMEDIATE` admits one writer per database). PostgreSQL
 * supplied it only when history or revision tracking was enabled, because only
 * those took the per-graph advisory lock — leaving a default PostgreSQL store
 * open to two writers that both read "no conflict" and both commit.
 * {@link edgeWriteNeedsConstraintFence} / {@link nodeWriteNeedsConstraintFence}
 * are what the write paths ask so they take that same per-graph lock whenever
 * one of these probes is in play, and only then.
 */
import {
  type ClaimEdgeCardinalityParams,
  type CompositionClaimScope,
  type EdgeRow,
  type GraphEntityReadBackend,
  isLiveNodeRowPresent,
} from "../backend/types";
import { checkDisjointness } from "../constraints";
import { type GraphDef } from "../core/define-graph";
import { type UniqueConstraint } from "../core/types";
import { type CardinalityError, type CompositionError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { compareCodePoints } from "../utils/compare";
import { hasOwnKey } from "../utils/object";
import { requireDefined } from "../utils/presence";
import {
  acyclicEdgeRelations,
  edgeKindIsInAcyclicRelation,
} from "./acyclicity";
import { type ConstraintFenceReason } from "./claims/backing";
import {
  axisCountsRow,
  claimRefusalFor,
  claimsInProbeOrder,
  compositionClaimEndpoints,
  edgeCardinalityAxisName,
  type EdgeCardinalityAxisRef,
  edgeCardinalityAxisReferences,
  type EdgeCardinalityDeclarations,
  edgeCardinalitySpec,
  edgeCardinalityViolation,
} from "./claims/edge-claims";
import { nodeClaimSites } from "./claims/sites";
import {
  compositionEdgeHasRequiredExistencePart,
  findLiveCompositionAttachment,
} from "./operations/composition-create";

export { type ConstraintFenceReason } from "./claims/backing";

/**
 * Context for constraint operations.
 *
 * The backend is the graph-entity READ facet rather than the backend union:
 * every check in this module is an application probe that reads, decides and
 * returns, and the CALLER does the writing. Naming the facet is what lets a
 * probe run inside a write frame, whose row-work handle exposes reads only,
 * and it states in the type that no check here writes.
 */
export type ConstraintContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphEntityReadBackend;
}>;

/**
 * The constraint that makes an edge write of this declaration constrained, or
 * `undefined` when it is not.
 *
 * A declaration with no constrained cardinality axis (both `cardinality` and
 * `targetCardinality` absent or `many`) and no `acyclic: true` runs no probe
 * and must NOT pay for the lock — the fence is for writes that check
 * something, not for writes in general. Every constrained axis counts or
 * existence-tests sibling edges before inserting, and an `acyclic: true` edge
 * kind (`cardinality: "many", acyclic: true` is the common case) runs the
 * reachability probe before inserting; nothing in the schema repeats either
 * test.
 *
 * Composition is reported first of all: a composition edge kind ALWAYS
 * declares a constrained whole-side cardinality, so
 * it always also qualifies as `"edgeCardinality"` — reporting the narrower
 * reason first is what lets a backend that cannot hold the fence give advice
 * that names the `partOf`/`hasPart` declaration rather than a generic
 * cardinality one. Cardinality is reported next when both it and acyclicity
 * apply, so every refusal payload that existed before `acyclic` shipped stays
 * byte-identical — the fence itself is the same per-graph lock regardless of
 * which reason names it, so the choice affects only what a refusal on an
 * unfenceable backend calls the constraint.
 *
 * The one owner of this classification: it folds through
 * {@link edgeCardinalityAxisReferences}, the same fold the claim set
 * `checkEdgeCardinalityConstraints` probes is built from, so a second inline `!== "many"` at a write path — blind to a
 * target-only declaration — can never drift from it. {@link graphOwesClaims}
 * routes through this function too, and accepts only its
 * `"edgeComposition"` / `"edgeCardinality"` answers: acyclicity has no claim
 * row to substitute for the per-graph lock import skips (see
 * {@link graphOwesLockOnlyFence}), so an `"edgeAcyclicity"` answer from here
 * is filtered out at that call site rather than re-derived by a second,
 * narrower fold.
 */
export function edgeWriteNeedsConstraintFence(
  declarations: EdgeCardinalityDeclarations &
    Readonly<{ acyclic?: boolean; composition?: boolean }>,
): ConstraintFenceReason | undefined {
  if (declarations.composition === true) {
    return "edgeComposition";
  }
  if (edgeCardinalityAxisReferences(declarations).length > 0) {
    return "edgeCardinality";
  }
  return declarations.acyclic === true ? "edgeAcyclicity" : undefined;
}

/**
 * The cardinality declarations an edge write of `kind` must honor, read from
 * the graph def. A kind this graph does not define answers the empty
 * declaration: choosing the fence must not become the thing that REPORTS an
 * unknown kind — the write path raises `KindNotFoundError` from inside the
 * hooked transaction, where a caller's `onError` hook observes it.
 */
export function edgeKindCardinalityDeclarations(
  graph: GraphDef,
  kind: string,
): EdgeCardinalityDeclarations {
  return (hasOwnKey(graph.edges, kind) ? graph.edges[kind] : undefined) ?? {};
}

/**
 * THE constraint-fence reason an edge write of `kind` owes: the kind's
 * declared cardinality axes and its composition dimension — both invariant
 * properties of the kind — folded through {@link edgeWriteNeedsConstraintFence}
 * with an acyclicity answer.
 *
 * `acyclic` defaults to whether the kind participates in an acyclic relation
 * at all, which is what a create (always re-admitting its row to that
 * population) owes. A write that re-admits the row only conditionally — a
 * resurrect that clears the tombstone, a window reopen of an `"openRows"`
 * member — states the dimension it actually decides.
 */
export function edgeKindFenceReason(
  graph: GraphDef,
  registry: KindRegistry,
  kind: string,
  acyclic: boolean = edgeKindIsInAcyclicRelation(graph, registry, kind),
): ConstraintFenceReason | undefined {
  return edgeWriteNeedsConstraintFence({
    ...edgeKindCardinalityDeclarations(graph, kind),
    acyclic,
    composition: registry.isCompositionEdge(kind),
  });
}

/**
 * The constraint that makes a node write of this kind constrained, or
 * `undefined` when it is not. A kind can qualify on both counts; the reason
 * reported is the first that applies, which is enough to name the class in a
 * refusal.
 *
 * Two probe families qualify, and they are reached by different operations:
 *
 * - **Disjointness** is probed only where a node comes into existence under a
 *   kind — the create/resurrect preparation. An in-place update cannot change a
 *   node's kind, so it re-derives no cross-kind verdict and needs no fence for
 *   this reason.
 * - **Shared-scope uniqueness** is probed by create AND update. It qualifies
 *   only when the constraint's scope actually spans more than the node's own
 *   kind: a single-kind scope probes exactly the `(graph_id, node_kind,
 *   constraint_name, key)` row that the claim then reserves, so the uniques
 *   primary key IS the fence and the write needs no other.
 *
 * The whole answer is a PROJECTION of {@link nodeClaimSites}, not a second
 * spelling of it: that list already decided, per family, whether the site's
 * axis spans kinds beyond the writer's own — in order to decide where its claim
 * is written and when — and this reads that same decision back, reporting the
 * first site carrying it. Disjointness sites come first in that list, so a kind
 * qualifying on both counts keeps reporting the class it reports today, which
 * is what the refusal payload names.
 *
 * Deliberately typed over `"create" | "update"` alone, never the third
 * {@link NodeClaimOperation} `"resurrect"`: this projection feeds the per-graph
 * LOCK, whose trigger set this workstream leaves byte-identical to HEAD's, and
 * a resurrect's disjointness claim needs none — `insertUnique`'s own
 * `INSERT … ON CONFLICT … RETURNING` fences it, the same primary key that
 * already fences an own-kind uniqueness claim with no lock. `nodeClaimEntries`
 * reads `nodeClaimSites` at `"resurrect"` directly (see
 * `claims/node-claims.ts:planNodeClaimReinsert`) without going through this
 * projection at all.
 */
export function nodeWriteNeedsConstraintFence(
  registry: KindRegistry,
  kind: string,
  uniqueConstraints: readonly UniqueConstraint[],
  operation: "create" | "update",
): ConstraintFenceReason | undefined {
  return nodeClaimSites(registry, kind, uniqueConstraints, operation).find(
    (site) => site.needsLockFence,
  )?.refusalReason;
}

/**
 * WHICH constraint makes a node DELETE a constrained write: a composition
 * WHOLE's delete cascades leaf-first through its parts closure under the
 * per-graph write lock (`planCompositionCascade`), so a concurrent attach
 * cannot slip a part past it. The classification is STATIC — a declared-
 * schema property (`registry.isCompositionWhole`), decided before any row
 * read — which is what lets a part-less kind's delete stay unfenced on
 * every backend, interactive transactions or not.
 *
 * Sibling of {@link nodeWriteNeedsConstraintFence}: that one folds
 * `nodeClaimSites` (a create/update write owes a claim); this one is a
 * one-line registry lookup because a composition delete owes no claim row —
 * it owes exclusive access to the closure it is about to walk. Kept as its
 * own function rather than a third value in that one's `operation` union so
 * a delete's very different reason ("this kind cascades") is never confused
 * with a create/update's ("this kind claims a scope").
 */
export function nodeDeleteNeedsConstraintFence(
  registry: KindRegistry,
  kind: string,
): ConstraintFenceReason | undefined {
  return registry.isCompositionWhole(kind) ? "edgeComposition" : undefined;
}

/**
 * WHICH constraint makes a node RESTORE — any write that clears a tombstone
 * without stating an attachment — a constrained write: a required-existence
 * part may only come back holding a live whole
 * (`assertRestoredRequiredPartsAttached`), a verdict read from the part's
 * composition edge and its whole that no claim row records. A concurrent
 * detach ({@link edgeDetachNeedsConstraintFence}) or whole delete
 * ({@link nodeDeleteNeedsConstraintFence}) reads the part's liveness just as
 * unbacked, so all three serialize on the per-graph write fence, named for
 * the composition relation. A kind that requires no whole restores unfenced.
 */
export function nodeRestoreNeedsConstraintFence(
  registry: KindRegistry,
  kind: string,
): ConstraintFenceReason | undefined {
  return registry.compositionExistence(kind) === "required" ?
      "edgeComposition"
    : undefined;
}

/**
 * WHICH constraint makes an edge write that can SEPARATE a part from its
 * whole — a soft delete, a hard delete, or a stated window end — a
 * constrained write: `assertCompositionExistencePreserved` refuses it while
 * the part is live, judged from a part-row read no claim row backs. The
 * restore twin is {@link nodeRestoreNeedsConstraintFence}. Only a composition
 * edge kind realizing a required-existence part pays; every other detach
 * decides nothing and stays unfenced.
 */
export function edgeDetachNeedsConstraintFence(
  registry: KindRegistry,
  edgeKind: string,
): ConstraintFenceReason | undefined {
  return compositionEdgeHasRequiredExistencePart(registry, edgeKind) ?
      "edgeComposition"
    : undefined;
}

/**
 * WHICH constraint makes an edge update that STATES a `validTo` a constrained
 * write. Everything {@link edgeDetachNeedsConstraintFence} names, since a
 * stated end can detach; and, on a `population: "oneActive"` composition
 * pair, every stated end — a later `validTo` on an already-ended row widens
 * its window, and whether that window now overlaps another of the part's
 * composition edges is a decision from rows no claim records
 * (`assertCompositionWindowsDisjoint`). A plan reads no row, so it cannot
 * tell a widening end from a shrinking one and fences both.
 */
export function edgeWindowEndNeedsConstraintFence(
  registry: KindRegistry,
  edgeKind: string,
): ConstraintFenceReason | undefined {
  return (
    edgeDetachNeedsConstraintFence(registry, edgeKind) ??
    (registry.compositionEdgePopulation(edgeKind) === "oneActive" ?
      "edgeComposition"
    : undefined)
  );
}

/**
 * THE graph-level answer to "does writing into this graph owe a claim that must
 * precede the row it gates?", folded over the SAME per-kind functions the write
 * paths consult — a node kind any of whose claim sites is `pre-insert` under
 * either operation, or an edge kind whose cardinality is not `many`.
 *
 * It exists for `importGraph`, which takes no per-graph lock and therefore
 * cannot declare `fencesConstraintProbe`: that option carries a second decision
 * — take the lock — and holding a per-graph mutex for a whole bulk load is a
 * different change with a different owner. The CONSUMPTION is split; the
 * definition is not.
 *
 * BOTH operations are folded because an import performs both, and the answer is
 * needed before the payload is inspected. That makes the fold coarser than the
 * per-row seam on purpose: a payload whose every row fails its constraints'
 * `where` predicates owes nothing, yet the import is refused. That is the price
 * of answering up front — and answering up front is what makes the refusal
 * deterministic across a chunked stream, which imports per chunk and would
 * otherwise fail on chunk k with k-1 chunks already committed.
 *
 * It lives here rather than beside {@link nodeClaimSites} because it also folds
 * {@link edgeWriteNeedsConstraintFence}, and this module is the one that already
 * sees both per-kind predicates.
 *
 * Deliberately asks about CARDINALITY alone, never acyclicity: a claim row is
 * a pre-insert reservation import's per-row recovery substitutes for the
 * per-graph lock it does not take, and acyclicity has no claim row to
 * reserve (`lockOnly`) — so this predicate would have nothing to report for
 * it anyway. The lock-only question for an acyclic graph is
 * {@link graphOwesLockOnlyFence}, a separate decision with a separate
 * consumer: import takes the per-graph lock per chunk when it applies,
 * rather than trying to substitute a claim that does not exist.
 */
export function graphOwesClaims(
  graph: GraphDef,
  registry: KindRegistry,
): ConstraintFenceReason | undefined {
  for (const [kind, registration] of Object.entries(graph.nodes)) {
    for (const operation of ["create", "update"] as const) {
      const gating = nodeClaimSites(
        registry,
        kind,
        registration.unique ?? [],
        operation,
      ).find((site) => site.placement === "pre-insert");
      if (gating !== undefined) return gating.refusalReason;
    }
  }
  for (const kind of Object.keys(graph.edges)) {
    // Routed through `edgeKindFenceReason` — the one owner of "which reason
    // does this edge kind's declaration qualify under, and in what preference
    // order" — rather than re-spelling the cardinality-only half of that fold
    // here. An acyclicity-only answer is filtered out below.
    const reason = edgeKindFenceReason(graph, registry, kind);
    if (reason === "edgeComposition" || reason === "edgeCardinality") {
      return reason;
    }
  }
  return undefined;
}

/**
 * Whether `importGraph` must take the per-graph write lock per chunk: the
 * graph declares at least one `acyclic: true` edge kind, or any
 * `partOf`/`hasPart` pair — the composition relation is an oriented union
 * over the SAME acyclicity check, with the same `lockOnly` backing.
 *
 * Import takes no per-graph lock by design (`graphOwesClaims`'s docblock) and
 * is fenced instead by the claim rows its constrained writes issue —
 * acyclicity has no claim row, so that substitute does not exist here. This
 * is therefore a real change to import's concurrency posture for such a
 * graph: for the duration of each chunk transaction, every other writer of
 * the graph blocks. `importGraphData` reads this before the first chunk and,
 * on a backend with no transactions, refuses the whole import up front
 * rather than probing unfenced.
 */
export function graphOwesLockOnlyFence(
  graph: GraphDef,
  registry: KindRegistry,
): ConstraintFenceReason | undefined {
  return acyclicEdgeRelations(graph, registry).length === 0 ?
      undefined
    : "edgeAcyclicity";
}

/**
 * Checks disjointness constraints for a node.
 *
 * Ensures that a node with a given ID doesn't exist in any disjoint kinds.
 *
 * @throws ValidationError if disjointness constraint is violated
 */
export async function checkDisjointnessConstraint(
  ctx: ConstraintContext,
  kind: string,
  id: string,
): Promise<void> {
  // Get all kinds that are disjoint with this kind
  const disjointKinds = ctx.registry.getDisjointKinds(kind);

  // For each disjoint kind, check if a node with this ID exists
  for (const disjointKind of disjointKinds) {
    const existing = await ctx.backend.getNode(ctx.graphId, disjointKind, id);
    if (isLiveNodeRowPresent(existing)) {
      const error = checkDisjointness(id, kind, [disjointKind], ctx.registry);
      if (error) throw error;
    }
  }
}

/**
 * The portable probe for every claim one edge write owes: the claim set
 * itself, read against the live graph instead of the claim relation.
 *
 * Takes the CLAIMS — `edgeInsertClaims` for a create, the re-entry set for a
 * resurrect or window reopen — rather than a declaration, so a write probes
 * exactly what it then claims, never a superset and never a subset. The claim
 * owners already applied every exemption (an edge born ended joins no
 * active-only population; a window reopen re-enters only the axes it left),
 * so this function decides nothing about WHICH axes are owed. Per claim it
 * reads {@link edgeCardinalitySpec} rather than re-spelling each
 * cardinality's rules: which endpoint the axis covers (`keyShape`) and
 * whether the population is the live one or the active one
 * (`holderLiveness`) are the same facts the claim's SQL reads. A probe that
 * spelled its own copy would be the drift that accepts a write the fence
 * then refuses (or the reverse).
 *
 * Probe order is {@link claimsInProbeOrder}: composition first. "One whole
 * per part" spans every realizing edge kind, so it is counted across all of
 * the claim's holders and refused as `CompositionError` naming the incumbent
 * edge — the refusal the claim row raises on a backend that takes the fused
 * path, so the two sides of that seam cannot disagree about the error class.
 * It is also the only fence that invariant has on a backend with no claim
 * relation, where the per-graph lock serializes writers but no row collides.
 *
 * **These are limits on edge count, not on distinct neighbours**: nothing in
 * the count mentions the opposite endpoint on a `from`/`to` axis, so a second
 * distinct edge from the same source to a target-`one` target is refused
 * exactly as a second edge from a different source would be.
 *
 * @throws CompositionError if the part already holds a whole
 * @throws CardinalityError if any constrained axis is violated
 */
export async function checkEdgeCardinalityConstraints(
  ctx: ConstraintContext,
  claims: readonly ClaimEdgeCardinalityParams[],
): Promise<void> {
  const ordered = claimsInProbeOrder(claims);
  const composition = ordered.find((claim) => claim.scope !== undefined);
  for (const claim of ordered) {
    if (claim.scope !== undefined) {
      const refusal = await compositionAttachmentViolation(
        ctx,
        claim,
        claim.scope,
      );
      if (refusal !== undefined) throw refusal;
      continue;
    }
    // The composition count above already read this kind's own part-side
    // population, so the ordinary axis that names the same population has
    // nothing left to decide.
    if (composition !== undefined && sameAxis(composition, claim)) continue;

    const spec = edgeCardinalitySpec(claim);
    if (spec.keyShape === "fromAndTo") {
      const exists = await ctx.backend.edgeExistsBetween({
        graphId: ctx.graphId,
        edgeKind: claim.edgeKind,
        fromKind: claim.fromKind,
        fromId: claim.fromId,
        toKind: claim.toKind,
        toId: claim.toId,
      });
      if (exists) {
        throw edgeCardinalityRefusal(
          claim,
          1,
          await namedIncumbentEdgeId(ctx, claim),
        );
      }
      continue;
    }

    const endpoint = spec.keyShape;
    const { endpointKind, endpointId } =
      endpoint === "from" ?
        { endpointKind: claim.fromKind, endpointId: claim.fromId }
      : { endpointKind: claim.toKind, endpointId: claim.toId };
    const count = await ctx.backend.countEdgesAtEndpoint({
      graphId: ctx.graphId,
      edgeKind: claim.edgeKind,
      endpoint,
      endpointKind,
      endpointId,
      activeOnly: spec.holderLiveness === "liveAndActive",
    });
    if (count > 0) {
      throw edgeCardinalityRefusal(
        claim,
        count,
        await namedIncumbentEdgeId(ctx, claim),
      );
    }
  }
}

function edgeCardinalityRefusal(
  claim: ClaimEdgeCardinalityParams,
  existingCount: number,
  incumbentEdgeId: string | undefined,
): CardinalityError {
  return requireDefined(
    edgeCardinalityViolation(claim, claim, existingCount, incumbentEdgeId),
    "A positive incumbent count violates every constrained cardinality.",
  );
}

/**
 * The stored edge occupying the slot a refused claim overran, read only
 * after a count has refused so a write that succeeds pays nothing. The
 * lowest id in code-point order among the population's members, the same
 * incumbent the claim statements' `ORDER BY` names. `undefined` when no
 * stored edge is visible (a pending row of the same batch), which the
 * refusal then omits rather than inventing.
 */
async function namedIncumbentEdgeId(
  ctx: ConstraintContext,
  claim: ClaimEdgeCardinalityParams,
): Promise<string | undefined> {
  const { keyShape } = edgeCardinalitySpec(claim);
  const keyedOnTarget = keyShape === "to";
  const incident = await ctx.backend.findEdgesConnectedTo({
    graphId: ctx.graphId,
    nodeKind: keyedOnTarget ? claim.toKind : claim.fromKind,
    nodeId: keyedOnTarget ? claim.toId : claim.fromId,
  });
  const sharesFrom = (edge: EdgeRow): boolean =>
    edge.from_kind === claim.fromKind && edge.from_id === claim.fromId;
  const sharesTo = (edge: EdgeRow): boolean =>
    edge.to_kind === claim.toKind && edge.to_id === claim.toId;
  const holders = incident.filter(
    (edge) =>
      edge.kind === claim.edgeKind &&
      edge.deleted_at === undefined &&
      axisCountsRow(claim, { validTo: edge.valid_to }) &&
      (keyShape === "to" ? sharesTo(edge)
      : keyShape === "from" ? sharesFrom(edge)
      : sharesFrom(edge) && sharesTo(edge)),
  );
  return holders
    .map((edge) => edge.id)
    .toSorted((left, right) => compareCodePoints(left, right))[0];
}

function sameAxis(
  left: EdgeCardinalityAxisRef,
  right: EdgeCardinalityAxisRef,
): boolean {
  return edgeCardinalityAxisName(left) === edgeCardinalityAxisName(right);
}

/**
 * The relation-wide half of the probe: whether the part a composition claim
 * keys on already has an attachment through ANY realizing edge kind, in the
 * population the claim's own axis counts. The portable rendering of the claim
 * statement's competing-holder predicate — same holders, same part-side
 * endpoint, same liveness.
 *
 * Counted through `countEdgesAtEndpoint`, one read per holder kind, so a
 * batch's pending rows and a move's retiring row are seen through the same
 * overlays that already adjust the ordinary axes. The incumbent edge is read
 * only once a count has refused, to name it.
 */
async function compositionAttachmentViolation(
  ctx: ConstraintContext,
  claim: ClaimEdgeCardinalityParams,
  scope: CompositionClaimScope,
): Promise<CardinalityError | CompositionError | undefined> {
  const { part } = compositionClaimEndpoints(claim);
  const activeOnly =
    edgeCardinalitySpec(claim).holderLiveness === "liveAndActive";
  for (const holder of scope.holders) {
    const count = await ctx.backend.countEdgesAtEndpoint({
      graphId: ctx.graphId,
      edgeKind: holder.edgeKind,
      endpoint: holder.partSide,
      endpointKind: part.kind,
      endpointId: part.id,
      activeOnly,
    });
    if (count <= 0) continue;
    const incumbent = await findLiveCompositionAttachment(
      ctx.registry,
      ctx.backend,
      ctx.graphId,
      part.kind,
      part.id,
    );
    return claimRefusalFor(claim, incumbent?.edge.id);
  }
  return undefined;
}
