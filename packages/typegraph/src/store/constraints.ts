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
import { type GraphEntityReadBackend, isLiveNodeRow } from "../backend/types";
import { checkDisjointness } from "../constraints";
import { type GraphDef } from "../core/define-graph";
import { type UniqueConstraint } from "../core/types";
import { type KindRegistry } from "../registry/kind-registry";
import { acyclicEdgeRelations } from "./acyclicity";
import { type ConstraintFenceReason } from "./claims/backing";
import {
  type EdgeCardinalityAxisRef,
  edgeCardinalityAxisReferences,
  type EdgeCardinalityDeclarations,
  edgeCardinalitySpec,
  edgeCardinalityViolation,
} from "./claims/edge-claims";
import { nodeClaimSites } from "./claims/sites";

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
 * declares a constrained whole-side cardinality (§2.5 of the design note), so
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
 * {@link edgeCardinalityAxisReferences}, the same fold `checkEdgeCardinalityConstraints`
 * iterates, so a second inline `!== "many"` at a write path — blind to a
 * target-only declaration — can never drift from it. {@link graphOwesClaims}
 * deliberately does NOT call this: it asks the cardinality-only half of the
 * same fold directly, because acyclicity has no claim row to substitute for
 * the per-graph lock import skips (see {@link graphOwesLockOnlyFence}).
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
 *
 * `"edgeComposition"` is E-b's eventual constant; until it lands this
 * reports the existing `"edgeCardinality"` reason (both name the same
 * remediation class to `CONSTRAINT_FENCE_ADVICE`: declare cardinality on
 * the realizing edge).
 */
export function nodeDeleteNeedsConstraintFence(
  registry: KindRegistry,
  kind: string,
): ConstraintFenceReason | undefined {
  return registry.isCompositionWhole(kind) ? "edgeCardinality" : undefined;
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
  for (const registration of Object.values(graph.edges)) {
    if (edgeCardinalityAxisReferences(registration).length > 0) {
      return "edgeCardinality";
    }
  }
  return undefined;
}

/**
 * Whether `importGraph` must take the per-graph write lock per chunk: the
 * graph declares at least one `acyclic: true` edge kind, or any
 * `partOf`/`hasPart` pair — item E's composition relation is D-10's oriented
 * union over the SAME acyclicity check, with the same `lockOnly` backing.
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
    if (existing !== undefined && isLiveNodeRow(existing)) {
      const error = checkDisjointness(id, kind, [disjointKind], ctx.registry);
      if (error) throw error;
    }
  }
}

/** The endpoint identity a cardinality probe reads and refuses against. */
export type EdgeEndpointTuple = Readonly<{
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

/**
 * Checks every cardinality axis an edge's declaration constrains, source and
 * target alike.
 *
 * Takes the AXIS LIST rather than the raw {@link EdgeCardinalityDeclarations},
 * so the caller decides which axes this write actually owes a probe for.
 * Every ordinary write (create, or an update re-entering the FULL live
 * population on a resurrection) owes the complete
 * {@link edgeCardinalityAxisReferences} fold, and every such caller passes
 * exactly that. The one caller that does not is a window reopen with no
 * delete transition: this row held its non-active-only axes continuously
 * (see {@link file://./operations/edge-operations.ts}'s reentry branch for
 * why probing them here would count the row against itself), so it passes a
 * narrower list. Per axis, reads {@link edgeCardinalitySpec} rather than
 * re-spelling each cardinality's rules: which endpoint the axis covers
 * (`keyShape`), whether an edge born already ended joins the population at
 * all (`claimsWhenBornEnded`) and whether the population is the live one or
 * the active one (`holderLiveness`) are the same three facts the claim's SQL
 * reads. A probe that spelled its own copy would be the drift that accepts a
 * write the fence then refuses (or the reverse).
 *
 * **These are limits on edge count, not on distinct neighbours**: nothing in
 * the count mentions the opposite endpoint on a `from`/`to` axis, so a second
 * distinct edge from the same source to a target-`one` target is refused
 * exactly as a second edge from a different source would be.
 *
 * @throws CardinalityError if any constrained axis is violated
 */
export async function checkEdgeCardinalityConstraints(
  ctx: ConstraintContext,
  edgeKind: string,
  axisReferences: readonly EdgeCardinalityAxisRef[],
  endpoints: EdgeEndpointTuple,
  validTo: string | undefined,
): Promise<void> {
  for (const ref of axisReferences) {
    const spec = edgeCardinalitySpec(ref);

    // An edge born ended never joins an active-only population, so it has
    // nothing to check and nothing to claim.
    if (!spec.claimsWhenBornEnded && validTo !== undefined) continue;

    if (spec.keyShape === "fromAndTo") {
      const exists = await ctx.backend.edgeExistsBetween({
        graphId: ctx.graphId,
        edgeKind,
        fromKind: endpoints.fromKind,
        fromId: endpoints.fromId,
        toKind: endpoints.toKind,
        toId: endpoints.toId,
      });
      const error = edgeCardinalityViolation(
        ref,
        { edgeKind, ...endpoints },
        exists ? 1 : 0,
      );
      if (error) throw error;
      continue;
    }

    const endpoint = spec.keyShape;
    const { endpointKind, endpointId } =
      endpoint === "from" ?
        { endpointKind: endpoints.fromKind, endpointId: endpoints.fromId }
      : { endpointKind: endpoints.toKind, endpointId: endpoints.toId };
    const count = await ctx.backend.countEdgesAtEndpoint({
      graphId: ctx.graphId,
      edgeKind,
      endpoint,
      endpointKind,
      endpointId,
      activeOnly: spec.holderLiveness === "liveAndActive",
    });
    const error = edgeCardinalityViolation(
      ref,
      { edgeKind, ...endpoints },
      count,
    );
    if (error) throw error;
  }
}
