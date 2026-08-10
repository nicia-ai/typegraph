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
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  checkCardinality,
  checkDisjointness,
  checkUniqueEdge,
} from "../constraints";
import { type GraphDef } from "../core/define-graph";
import { type Cardinality, type UniqueConstraint } from "../core/types";
import { type KindRegistry } from "../registry/kind-registry";
import { type ConstraintFenceReason } from "./claims/backing";
import { EDGE_CARDINALITY_SPECS } from "./claims/edge-claims";
import { nodeClaimSites } from "./claims/sites";

export { type ConstraintFenceReason } from "./claims/backing";

/**
 * Context for constraint operations.
 */
export type ConstraintContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphBackend | TransactionBackend;
}>;

/**
 * The constraint that makes an edge write of this cardinality constrained, or
 * `undefined` when it is not.
 *
 * `many` declares no constraint, so its create runs no cardinality probe and
 * must NOT pay for the lock — the fence is for writes that check something, not
 * for writes in general. Every other cardinality counts or existence-tests
 * sibling edges before inserting, and nothing in the schema repeats that test.
 *
 * The one owner of this classification: `checkCardinalityConstraint`'s `many`
 * arm and this predicate are the same decision seen from two sides, and a
 * second inline `!== "many"` at a write path would be the copy that drifts.
 */
export function edgeWriteNeedsConstraintFence(
  cardinality: Cardinality,
): ConstraintFenceReason | undefined {
  return cardinality === "many" ? undefined : "edgeCardinality";
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
    const reason = edgeWriteNeedsConstraintFence(
      registration.cardinality ?? "many",
    );
    if (reason !== undefined) return reason;
  }
  return undefined;
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
    if (existing && !existing.deleted_at) {
      const error = checkDisjointness(id, kind, [disjointKind], ctx.registry);
      if (error) throw error;
    }
  }
}

/**
 * Checks cardinality constraints for an edge.
 *
 * Reads {@link EDGE_CARDINALITY_SPECS} rather than re-spelling each
 * cardinality's rules: which endpoints the axis covers (`keyShape`), whether an
 * edge born already ended joins the population at all (`claimsWhenBornEnded`)
 * and whether the population is the live one or the active one
 * (`holderLiveness`) are the same three facts the claim's SQL reads. A probe
 * that spelled its own copy would be the drift that accepts a write the fence
 * then refuses (or the reverse).
 *
 * @throws CardinalityError if cardinality constraint is violated
 */
export async function checkCardinalityConstraint(
  ctx: ConstraintContext,
  edgeKind: string,
  cardinality: Cardinality,
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  validTo: string | undefined,
): Promise<void> {
  if (cardinality === "many") return;
  const spec = EDGE_CARDINALITY_SPECS[cardinality];

  // An edge born ended never joins an active-only population, so it has
  // nothing to check and nothing to claim.
  if (!spec.claimsWhenBornEnded && validTo !== undefined) return;

  if (spec.keyShape === "fromAndTo") {
    const exists = await ctx.backend.edgeExistsBetween({
      graphId: ctx.graphId,
      edgeKind,
      fromKind,
      fromId,
      toKind,
      toId,
    });
    const error = checkUniqueEdge(
      edgeKind,
      fromKind,
      fromId,
      toKind,
      toId,
      exists ? 1 : 0,
    );
    if (error) throw error;
    return;
  }

  const count = await ctx.backend.countEdgesFrom({
    graphId: ctx.graphId,
    edgeKind,
    fromKind,
    fromId,
    activeOnly: spec.holderLiveness === "liveAndActive",
  });
  const error = checkCardinality(
    edgeKind,
    fromKind,
    fromId,
    cardinality,
    count,
    count > 0,
  );
  if (error) throw error;
}
